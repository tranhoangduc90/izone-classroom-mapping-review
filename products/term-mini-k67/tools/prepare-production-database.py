"""Dựng kho K67 riêng còn trống, trước khi diễn tập/chuyển dữ liệu.

Nhận DDL hiện hành, sinh credential riêng trong DPAPI, tạo volume/container mới
có nhãn intent và quota. Kiểm quyền/13 bảng/26 trigger bằng PostgreSQL thật.
Không ghi DB nguồn, chuyển route, xóa fixture hoặc bật chấm bài.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import json
import re
import secrets
import sys
import time
import uuid
import win32crypt

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-database')
STATE=PRIVATE/'state.json'
VAULT=PRIVATE/'credentials.dpapi'
REMOTE='/opt/term-mini-k67-postgres'
PG='term-mini-k67-postgres'
VOLUME='term-mini-k67-postgres-data'
DATABASE='term_mini_k67'
IMAGE='postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
PRODUCT='PRODUCT-TERM-MINI-K67'
DDL=['001-context.sql','002-history.sql','003-assessment.sql','004-grants.sql','005-context-auth.sql']


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def sha(raw):return hashlib.sha256(raw).hexdigest()


def keys():
    _,raw=win32crypt.CryptUnprotectData(VAULT.read_bytes(),None,None,None,0)
    return json.loads(raw)


def labels(state):return {'com.izone.product':PRODUCT,'com.izone.purpose':'production-database-v1','com.izone.intent':state['intent']}


def sql(u,client,text):
    return u.remote(client,['docker','exec','-i',PG,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
        '-U','k67_owner','-d',DATABASE],text.encode(),timeout=90).decode().strip()


def query(u,client,text):return json.loads(sql(u,client,'BEGIN READ ONLY; '+text+'; ROLLBACK;'))


def verify_container(u,client,state):
    row=json.loads(u.remote(client,['docker','inspect',PG]))[0]
    volume=json.loads(u.remote(client,['docker','volume','inspect',VOLUME]))[0]
    image=json.loads(u.remote(client,['docker','image','inspect',IMAGE]))[0]
    host=row['HostConfig'];env=dict(x.split('=',1) for x in row['Config']['Env'] if '=' in x)
    mounts={x['Destination']:(x['Type'],x.get('Name'),x['RW'],x['Source']) for x in row['Mounts']}
    if any(row['Config'].get('Labels',{}).get(k)!=v or volume.get('Labels',{}).get(k)!=v for k,v in labels(state).items()) \
        or row['Image']!=image['Id'] or not row['State']['Running'] or row['Name']!='/'+PG \
        or host['NanoCpus']!=500000000 or host['Memory']!=536870912 or host['PidsLimit']!=128 \
        or host['NetworkMode']!='n8n-net' or host['PortBindings']!={'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'55468'}]} \
        or env.get('POSTGRES_DB')!=DATABASE or env.get('POSTGRES_USER')!='k67_owner' \
        or env.get('POSTGRES_PASSWORD_FILE')!='/run/secrets/owner-password' \
        or row['Config']['Cmd']!=['postgres','-c','max_connections=30','-c','shared_buffers=64MB','-c','work_mem=4MB'] \
        or set(mounts)!={'/var/lib/postgresql/data','/run/secrets/owner-password'} \
        or mounts['/var/lib/postgresql/data'][:3]!=('volume',VOLUME,True) \
        or mounts['/run/secrets/owner-password']!=('bind',None,False,REMOTE+'/owner-password'):
        raise RuntimeError('K67_DATABASE_CONTAINER_MISMATCH')
    return {'image':image['Id'],'volume':VOLUME,'cpu':0.5,'memory_mib':512,'max_connections':30}


def verify_schema(u,client,state):
    marker=PRODUCT+':'+state['intent']+':'+sha(json.dumps(state['ddl_hashes'],sort_keys=True).encode())
    actual=query(u,client,"""SELECT jsonb_build_object(
      'db',current_database(),'owner',current_user,
      'marker',(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()),
      'tables',(SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='assessment'),
      'history_triggers',(SELECT count(*) FROM pg_trigger WHERE tgname IN ('collaboration_row_history','collaboration_truncate_history')
        AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='assessment'::regnamespace)),
      'app_insert',has_table_privilege('k67_app','assessment.term_test_attempt','INSERT'),
      'app_context_write',has_table_privilege('k67_app','mapping.reviewer_class_access','INSERT,UPDATE,DELETE'),
      'app_schema_create',has_schema_privilege('k67_app','mapping','CREATE'),
      'app_audit_read',has_table_privilege('k67_app','collaboration.audit_event','SELECT'),
      'sync_exam_write',has_table_privilege('k67_context_sync','assessment.term_test_attempt','INSERT,UPDATE,DELETE'),
      'sync_session_token',has_column_privilege('k67_context_sync','mapping.reviewer_session','token_hash','SELECT'),
      'sync_revoke',has_column_privilege('k67_context_sync','mapping.reviewer_session','revoked_at','UPDATE'),
      'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'super',rolsuper,
        'create_db',rolcreatedb,'create_role',rolcreaterole,'replication',rolreplication,'bypass',rolbypassrls) ORDER BY rolname)
        FROM pg_roles WHERE rolname IN ('k67_app','k67_context_sync')),
      'memberships',(SELECT count(*) FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('k67_app','k67_context_sync'))))""")
    expected=['mini_test_result','term_test_attempt','term_test_exam_session','term_test_portal_sync_job',
        'term_test_roster','term_test_temporary_student','term_test_writing_grading_component',
        'term_test_writing_grading_criterion','term_test_writing_grading_final','term_test_writing_grading_job',
        'term_test_writing_grading_run','term_test_writing_planning','test_definition']
    expected_roles=[{'name':name,'login':True,'super':False,'create_db':False,'create_role':False,
        'replication':False,'bypass':False} for name in ['k67_app','k67_context_sync']]
    if actual['db']!=DATABASE or actual['owner']!='k67_owner' or actual['marker']!=marker \
        or actual['tables']!=expected or actual['history_triggers']!=26 or not actual['app_insert'] \
        or any(actual[key] for key in ['app_context_write','app_schema_create','app_audit_read','sync_exam_write','sync_session_token','memberships']) \
        or not actual['sync_revoke'] or actual['roles']!=expected_roles:
        raise RuntimeError('K67_DATABASE_SCHEMA_PERMISSION_MISMATCH')
    return actual


def prepare(u,h,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    ddl={name:(ROOT/'db'/name).read_bytes() for name in DDL}
    hashes={name:sha(raw) for name,raw in ddl.items()}
    names=u.remote(client,['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    volumes=u.remote(client,['docker','volume','ls','--format','{{.Name}}']).decode().splitlines()
    before=u.protected(client)
    if STATE.exists():
        state=json.loads(STATE.read_text(encoding='utf-8'))
        if state['product']!=PRODUCT or state['ddl_hashes']!=hashes or not re.fullmatch('[0-9a-f]{32}',state['intent']):
            raise RuntimeError('K67_DATABASE_STATE_CHANGED')
    else:
        if PG in names or VOLUME in volumes or VAULT.exists():raise RuntimeError('K67_DATABASE_NAME_COLLISION')
        state={'product':PRODUCT,'intent':uuid.uuid4().hex,'ddl_hashes':hashes,'stage':'intent','protected_before':before}
        h.atomic(STATE,state)
    if not VAULT.exists():
        value={'intent':state['intent'],'roles':{name:secrets.token_urlsafe(48) for name in ['k67_owner','k67_app','k67_context_sync']}}
        with VAULT.open('xb') as stream:stream.write(win32crypt.CryptProtectData(json.dumps(value).encode(),'K67 database',None,None,None,0))
    secret=keys()
    if secret['intent']!=state['intent'] or set(secret['roles'])!={'k67_owner','k67_app','k67_context_sync'} \
        or any(not re.fullmatch('[A-Za-z0-9_-]{48,96}',value) for value in secret['roles'].values()):
        raise RuntimeError('K67_DATABASE_VAULT_MISMATCH')
    sftp=client.open_sftp()
    try:
        marker=json.dumps({'intent':state['intent'],'product':PRODUCT},sort_keys=True).encode()
        context=load('context_util','prepare-context-source.py')
        context.owned_directory_files(sftp,REMOTE,{'identity.json':(marker,0o600),
            'owner-password':((secret['roles']['k67_owner']+'\n').encode(),0o400)})
    finally:sftp.close()
    if VOLUME not in volumes:
        argv=['docker','volume','create']
        for k,v in labels(state).items():argv+=['--label',k+'='+v]
        state['stage']='volume_create_intent';h.atomic(STATE,state);u.remote(client,[*argv,VOLUME])
    volume=json.loads(u.remote(client,['docker','volume','inspect',VOLUME]))[0]
    if any(volume.get('Labels',{}).get(k)!=v for k,v in labels(state).items()):raise RuntimeError('K67_DATABASE_VOLUME_COLLISION')
    if PG not in names:
        if u.remote(client,['ss','-H','-ltn','sport = :55468']).strip():raise RuntimeError('K67_DATABASE_PORT_COLLISION')
        argv=['docker','run','--detach','--name',PG]
        for k,v in labels(state).items():argv+=['--label',k+'='+v]
        state['stage']='container_create_intent';h.atomic(STATE,state)
        u.remote(client,[*argv,'--network','n8n-net','--cpus','0.5','--memory','512m','--pids-limit','128',
          '--publish','127.0.0.1:55468:5432','--mount','type=volume,src='+VOLUME+',dst=/var/lib/postgresql/data',
          '--mount','type=bind,src='+REMOTE+'/owner-password,dst=/run/secrets/owner-password,readonly',
          '--env','POSTGRES_USER=k67_owner','--env','POSTGRES_DB='+DATABASE,
          '--env','POSTGRES_PASSWORD_FILE=/run/secrets/owner-password','--restart','unless-stopped',
          IMAGE,'postgres','-c','max_connections=30','-c','shared_buffers=64MB','-c','work_mem=4MB'])
    state['container']=verify_container(u,client,state)
    deadline=time.monotonic()+60
    while True:
        try:sql(u,client,'SELECT 1;');break
        except RuntimeError:
            if time.monotonic()>deadline:raise RuntimeError('K67_DATABASE_READY_TIMEOUT')
            time.sleep(1)
    exists=query(u,client,"SELECT to_jsonb(EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='assessment'))")
    if not exists:
        state['stage']='schema_create_intent';h.atomic(STATE,state)
        parts=["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"]
        parts += ["CREATE ROLE "+name+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+secret['roles'][name]+"';" for name in ['k67_app','k67_context_sync']]
        parts += [raw.decode() for raw in ddl.values()]
        marker=PRODUCT+':'+state['intent']+':'+sha(json.dumps(hashes,sort_keys=True).encode())
        parts += ["COMMENT ON DATABASE term_mini_k67 IS '"+marker+"';",'COMMIT;']
        sql(u,client,'\n'.join(parts))
    state['schema']=verify_schema(u,client,state)
    after=u.protected(client)
    if before!=after:raise RuntimeError('K67_DATABASE_PROTECTED_RUNTIME_CHANGED')
    state['protected_after']=after;state['stage']='ready_before_migration'
    state['observed_at']=datetime.now(timezone.utc).isoformat().replace('+00:00','Z');h.atomic(STATE,state)
    return {'outcome':'success','container':PG,'database':DATABASE,'stage':state['stage'],
        'tables':len(state['schema']['tables']),'history_triggers':state['schema']['history_triggers'],
        'protected_unchanged':True,'learner_cutover':False}


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py');client=u.connect()
    try:
        context=load('context_guard','prepare-context-source.py')
        return context.run_guarded(u,h,client,lambda:prepare(u,h,client),PRIVATE,caller_path=Path(__file__))
    finally:client.close()


if __name__=='__main__':sys.exit(main())
