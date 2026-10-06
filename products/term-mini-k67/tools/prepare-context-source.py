"""Dựng nguồn lớp/quyền riêng của K67; không chuyển bài thi hoặc sửa K56.

Nhận source đã ghim và credential mã hóa cục bộ. Chỉ tạo role/namespace/container
mới có journal, khóa riêng và quota. Lỗi giữ nguyên tài nguyên để đối soát;
không drop, reset, ghi đè hoặc tự sửa tài nguyên không thuộc intent.
"""
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import quote
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

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path('E:/Codex-Data/k67-backend-separation-20261006/context-source')
STATE = PRIVATE / 'state.json'
VAULT = PRIVATE / 'credentials.dpapi'
REMOTE = '/opt/term-mini-k67-context-source'
APP = 'term-mini-k67-context-source'
PG = 'mapping-postgres'
ROLE = 'k67_context_reader'
SCHEMA = 'k67_context_api_v1'
PORT = '8798'
PRODUCT = 'PRODUCT-TERM-MINI-K67'
FILES = ['src/context-source-server.js', 'src/context-source.js', 'src/context-contract.js']


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def sql(u, client, text):
    # SQL và mật khẩu chỉ qua stdin, không đặt trong argv hoặc terminal.
    return u.remote(client, ['docker', 'exec', '-i', PG, 'psql', '-X', '-qAt',
        '-v', 'ON_ERROR_STOP=1', '-U', 'mapping_admin', '-d', 'mapping_db'], text.encode()).decode().strip()


def query(u, client, text):
    return json.loads(sql(u, client, "BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; " + text + '; ROLLBACK;'))


def source_catalog(u, client):
    # Hash định nghĩa/ACL các đối tượng đã có; không đưa bản ghi hoặc secret vào evidence.
    return query(u, client, """SELECT jsonb_build_object(
      'relations',md5(coalesce((SELECT string_agg(row_to_json(x)::text,'' ORDER BY x.oid) FROM
        (SELECT c.oid,n.nspname,c.relname,c.relkind,c.relowner,c.relacl::text,
          CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) ELSE NULL END AS viewdef
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','k67_context_api_v1')) x),'')),
      'columns',md5(coalesce((SELECT string_agg(row_to_json(x)::text,'' ORDER BY x.attrelid,x.attnum) FROM
        (SELECT a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl::text
         FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname NOT LIKE 'pg_%'
           AND n.nspname NOT IN ('information_schema','k67_context_api_v1')) x),'')),
      'functions',md5(coalesce((SELECT string_agg(row_to_json(x)::text,'' ORDER BY x.oid) FROM
        (SELECT p.oid,p.proowner,p.proacl::text,pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','k67_context_api_v1')
           AND p.prokind='f') x),'')))""")


def objects(u, client):
    return query(u, client, """SELECT jsonb_build_object(
      'role',EXISTS(SELECT 1 FROM pg_roles WHERE rolname='k67_context_reader'),
      'schema',EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='k67_context_api_v1'))""")


def verify_database(u, client, state):
    marker = PRODUCT + ':' + state['intent'] + ':' + state['sql_sha256']
    actual = query(u, client, """SELECT jsonb_build_object(
      'marker',obj_description('k67_context_api_v1'::regnamespace,'pg_namespace'),
      'role_marker',(SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname='k67_context_reader'),
      'role',(SELECT jsonb_build_object('login',rolcanlogin,'super',rolsuper,'create_db',rolcreatedb,
        'create_role',rolcreaterole,'replication',rolreplication,'bypass',rolbypassrls,'limit',rolconnlimit)
        FROM pg_roles WHERE rolname='k67_context_reader'),
      'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='k67_context_reader')),
      'scope',(SELECT jsonb_agg(class_id::text ORDER BY class_id) FROM k67_context_api_v1.class_scope),
      'views',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_viewdef(c.oid,true),
        'options',c.reloptions,'select',has_table_privilege('k67_context_reader',c.oid,'SELECT')) ORDER BY c.relname)
        FROM pg_class c WHERE c.relnamespace='k67_context_api_v1'::regnamespace AND c.relkind='v'),
      'outside_read',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m')
          AND n.nspname<>'k67_context_api_v1' AND has_table_privilege('k67_context_reader',c.oid,'SELECT')),
      'write',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m')
          AND has_table_privilege('k67_context_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')),
      'scope_read',has_table_privilege('k67_context_reader','k67_context_api_v1.class_scope','SELECT'),
      'definer_exec',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND has_schema_privilege('k67_context_reader',n.oid,'USAGE')
          AND has_function_privilege('k67_context_reader',p.oid,'EXECUTE')))""")
    expected_role = {'login': True, 'super': False, 'create_db': False, 'create_role': False,
        'replication': False, 'bypass': False, 'limit': 2}
    if actual['marker'] != marker or actual['role_marker'] != marker or actual['role'] != expected_role \
        or actual['memberships'] or actual['outside_read'] or actual['write'] or actual['scope_read'] or actual['definer_exec']:
        raise RuntimeError('CONTEXT_SOURCE_PERMISSION_MISMATCH')
    if actual['scope'] != ['-8062028','1124','1131','1135','1157','1166','1187','1199','1226','1250','1293'] \
        or [x['name'] for x in actual['views']] != ['access','accounts','classes','memberships','students'] \
        or any(not x['select'] or x['options'] != ['security_barrier=true'] for x in actual['views']):
        raise RuntimeError('CONTEXT_SOURCE_SCOPE_MISMATCH')
    return actual


def secret_values():
    _, raw = win32crypt.CryptUnprotectData(VAULT.read_bytes(), None, None, None, 0)
    return json.loads(raw)


def environment(keys):
    return ('K67_CONTEXT_SOURCE_DATABASE_URL=postgresql://k67_context_reader:' + quote(keys['password'],safe='')
        + '@mapping-postgres:5432/mapping_db\nK67_CONTEXT_SOURCE_SECRET=' + keys['api'] + '\n').encode()


def owned_directory_files(sftp, directory, files):
    # Thư mục cũ phải có marker đúng trước mọi ghi. Kiểm tất cả file đã có trước,
    # rồi mới tạo file còn thiếu; không sửa mode/nội dung của file có sẵn.
    created=False
    try:sftp.stat(directory)
    except FileNotFoundError:
        sftp.mkdir(directory,mode=0o700);created=True
    if sftp.stat(directory).st_mode & 0o777 != 0o700:
        raise RuntimeError('K67_REMOTE_DIRECTORY_MODE_MISMATCH')
    existing={}
    if set(sftp.listdir(directory))-set(files):raise RuntimeError('K67_REMOTE_DIRECTORY_FOREIGN_FILE')
    for name,(data,mode) in files.items():
        if '/' in name or name in ['.','..']:raise RuntimeError('K67_REMOTE_FILENAME_INVALID')
        path=directory+'/'+name
        try:
            with sftp.open(path,'rb') as stream:actual=stream.read()
        except FileNotFoundError:continue
        if actual!=data or sftp.stat(path).st_mode & 0o777 != mode:
            raise RuntimeError('K67_REMOTE_FILE_MISMATCH')
        existing[name]=actual
    if not created and 'identity.json' not in existing:
        raise RuntimeError('K67_REMOTE_DIRECTORY_OWNERSHIP_UNKNOWN')
    for name,(data,mode) in files.items():
        if name not in existing:
            path=directory+'/'+name
            with sftp.open(path,'wx') as stream:stream.write(data)
            sftp.chmod(path,mode)
            with sftp.open(path,'rb') as stream:actual=stream.read()
            if actual!=data or sftp.stat(path).st_mode & 0o777 != mode:
                raise RuntimeError('K67_REMOTE_FILE_READBACK_MISMATCH')


def guarded_operation(operation, observe, save):
    # Đọc guard sau cả đường thành công/lỗi; giữ lỗi thao tác và lỗi đối soát riêng.
    before=after=None
    operation_error=guard_error=None
    result={'outcome':'unknown','learner_cutover':False}
    try:
        before=observe()
        result=operation()
    except Exception as error:
        operation_error=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        result={'outcome':'failure','code':operation_error,'learner_cutover':False}
    finally:
        try:after=observe()
        except Exception as error:
            guard_error='READBACK_'+type(error).__name__
        if before is None:guard_error=guard_error or 'BEFORE_GUARD_UNKNOWN'
        elif after is not None and before!=after:guard_error='PROTECTED_STATE_CHANGED'
    receipt={'observed_at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
        'operation_result':result,'operation_error':operation_error,'guard_error':guard_error,
        'guard_outcome':'unknown' if before is None or after is None else ('failed' if guard_error else 'passed'),
        'protected_before':before,'protected_after':after}
    outcome=result['outcome'] if not guard_error else (
        'failure' if result['outcome']=='failure' or operation_error or after is not None else 'unknown')
    receipt['outcome']=outcome
    try:save(receipt)
    except Exception as error:
        receipt['receipt_error']=type(error).__name__;receipt['outcome']='failure'
    return receipt


def run_guarded(u,h,client,operation,store,with_catalog=False,caller_path=None):
    store.mkdir(parents=True,exist_ok=True)
    def read(connection):
        value={'runtime':u.protected(connection)}
        if with_catalog:value['catalog']=source_catalog(u,connection)
        return value
    def observe():
        try:return read(client)
        except Exception:
            # Một kết nối đọc mới khi SSH cũ mất ACK; không retry mutation.
            replacement=u.connect()
            try:return read(replacement)
            finally:replacement.close()
    path=store/('deployment-'+uuid.uuid4().hex+'.json')
    def save(receipt):
        receipt['guard_helper_sha256']=digest(Path(__file__).read_bytes())
        receipt['helper_sha256']=digest(Path(caller_path or __file__).read_bytes())
        with path.open('x',encoding='utf-8') as stream:
            json.dump(receipt,stream,ensure_ascii=False,indent=2);stream.write('\n')
    receipt=guarded_operation(operation,observe,save)
    print(json.dumps({'outcome':receipt['outcome'],'operation':receipt['operation_result'],
        'operation_error':receipt['operation_error'],'guard_error':receipt['guard_error'],
        'guard_outcome':receipt['guard_outcome'],'receipt':str(path),
        'receipt_error':receipt.get('receipt_error')},ensure_ascii=False))
    return 0 if receipt['outcome']=='success' else 1


def verify_container(u, client, state, keys):
    row = json.loads(u.remote(client, ['docker', 'inspect', APP]))[0]
    host = row['HostConfig']
    labels = {'com.izone.product':PRODUCT,'com.izone.purpose':'context-source-v1','com.izone.intent':state['intent']}
    actual_env = dict(x.split('=',1) for x in row['Config']['Env'] if '=' in x)
    expected_env = dict(x.split('=',1) for x in environment(keys).decode().splitlines())
    if row['Image'] != state['image'] or row['Name'] != '/'+APP or not row['State']['Running'] \
        or row['Config']['Cmd'] != ['node','src/context-source-server.js'] or row['Config']['User'] != 'node' \
        or any(row['Config'].get('Labels',{}).get(k)!=v for k,v in labels.items()) \
        or any(actual_env.get(k)!=v for k,v in expected_env.items()) \
        or host['NanoCpus']!=250000000 or host['Memory']!=134217728 or host['PidsLimit']!=64 \
        or not host['ReadonlyRootfs'] or host['NetworkMode']!='n8n-net' or row['Mounts'] \
        or host['PortBindings']!={'8797/tcp':[{'HostIp':'127.0.0.1','HostPort':PORT}]}:
        raise RuntimeError('CONTEXT_SOURCE_CONTAINER_MISMATCH')
    proof = """import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';
    const files=JSON.parse(process.argv[1]);const hashes=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
    const base='http://127.0.0.1:8797';const unauthorized=await fetch(base+'/v1/snapshot');
    const response=await fetch(base+'/v1/snapshot',{headers:{'x-k67-context-key':process.env.K67_CONTEXT_SOURCE_SECRET}});
    const data=await response.json();const denied=await fetch(base+'/v1/assessment');
    console.log(JSON.stringify({hashes,unauthorized:unauthorized.status,status:response.status,foreign:denied.status,
      apiVersion:data.apiVersion,productId:data.productId,capturedAt:data.capturedAt,sourceRevision:data.sourceRevision,
      bytes:Buffer.byteLength(JSON.stringify(data)),counts:Object.fromEntries(['classes','students','memberships','accounts','access'].map(k=>[k,data[k]?.length]))}));"""
    deadline=time.monotonic()+25
    while True:
        try:
            result=json.loads(u.remote(client,['docker','exec',APP,'node','--input-type=module','-e',proof,json.dumps(FILES)],timeout=8))
            break
        except RuntimeError:
            if time.monotonic()>deadline: raise RuntimeError('CONTEXT_SOURCE_READINESS_TIMEOUT')
            time.sleep(1)
    if result['hashes']!=state['source_hashes'] or result['unauthorized']!=401 or result['status']!=200 \
        or result['foreign']!=404 or result['apiVersion']!=1 or result['productId']!=PRODUCT \
        or not 0<result['bytes']<=1048576:
        raise RuntimeError('CONTEXT_SOURCE_API_READBACK_MISMATCH')
    return result


def prepare(u,h,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    source_hashes={name:digest((ROOT/name).read_bytes()) for name in FILES}
    ddl=(ROOT/'db/006-context-source.sql').read_bytes()
    fixture=json.loads((h.STORE/'state.json').read_text(encoding='utf-8'))
    names=u.remote(client,['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    before=u.protected(client)
    catalog_before=source_catalog(u,client)
    if STATE.exists():
        state=json.loads(STATE.read_text(encoding='utf-8'))
        if state['product']!=PRODUCT or not re.fullmatch('[0-9a-f]{32}',state['intent']) \
            or state['source_hashes']!=source_hashes or state['sql_sha256']!=digest(ddl) \
            or state['image']!=fixture['image']:
            raise RuntimeError('CONTEXT_SOURCE_STATE_CHANGED')
    else:
        if objects(u,client)!={'role':False,'schema':False} or APP in names or VAULT.exists():
            raise RuntimeError('CONTEXT_SOURCE_NAME_COLLISION')
        state={'product':PRODUCT,'intent':uuid.uuid4().hex,'source_hashes':source_hashes,
            'sql_sha256':digest(ddl),'image':fixture['image'],'stage':'intent','protected_before':before,
            'catalog_before':catalog_before}
        h.atomic(STATE,state)
    # Kiểm source trong image trước mọi mutation DB; container fixture chỉ được đọc.
    raw=u.remote(client,['docker','exec','term-mini-k67-http-fixture','sha256sum',*FILES]).decode()
    image_hashes={line.split(None,1)[1].strip():line.split()[0] for line in raw.splitlines()}
    if image_hashes!=source_hashes: raise RuntimeError('CONTEXT_SOURCE_IMAGE_SOURCE_MISMATCH')
    if not VAULT.exists():
        keys={'password':secrets.token_urlsafe(48),'api':secrets.token_urlsafe(48),'intent':state['intent']}
        with VAULT.open('xb') as stream:
            stream.write(win32crypt.CryptProtectData(json.dumps(keys).encode(),'K67 context source',None,None,None,0))
    keys=secret_values()
    if keys['intent']!=state['intent'] or set(keys)!={'intent','password','api'} \
        or any(not re.fullmatch('[A-Za-z0-9_-]{48,96}',keys[field]) for field in ['password','api']):
        raise RuntimeError('CONTEXT_SOURCE_VAULT_MISMATCH')
    if 'database_readback' not in state:
        if objects(u,client)!={'role':False,'schema':False}:
            raise RuntimeError('CONTEXT_DATABASE_EXISTS_INSPECT_REQUIRED')
        state['stage']='database_create_intent';h.atomic(STATE,state)
        marker=PRODUCT+':'+state['intent']+':'+state['sql_sha256']
        command=("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s';\n"
          "CREATE ROLE k67_context_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"
          +keys['password']+"';\n"+ddl.decode()+"\nCOMMENT ON SCHEMA k67_context_api_v1 IS '"+marker
          +"';\nCOMMENT ON ROLE k67_context_reader IS '"+marker+"';\nCOMMIT;")
        sql(u,client,command)
        state['database_readback']=verify_database(u,client,state)
        state['stage']='database_created';h.atomic(STATE,state)
    elif verify_database(u,client,state)!=state['database_readback']:
        raise RuntimeError('CONTEXT_SOURCE_DATABASE_DEFINITION_CHANGED')
    sftp=client.open_sftp()
    try:
        marker=json.dumps({'intent':state['intent'],'product':PRODUCT},sort_keys=True).encode()
        owned_directory_files(sftp,REMOTE,{'identity.json':(marker,0o600),'source.env':(environment(keys),0o600)})
    finally:sftp.close()
    if APP not in names:
        if u.remote(client,['ss','-H','-ltn','sport = :'+PORT]).strip():raise RuntimeError('CONTEXT_SOURCE_PORT_COLLISION')
        state['stage']='container_create_intent';h.atomic(STATE,state)
        health="node -e \"fetch('http://127.0.0.1:8797/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        u.remote(client,['docker','run','--detach','--name',APP,'--label','com.izone.product='+PRODUCT,
          '--label','com.izone.purpose=context-source-v1','--label','com.izone.intent='+state['intent'],
          '--network','n8n-net','--cpus','0.25','--memory','128m','--pids-limit','64','--read-only',
          '--security-opt','no-new-privileges','--cap-drop','ALL','--tmpfs','/tmp:rw,noexec,nosuid,size=16m',
          '--publish','127.0.0.1:'+PORT+':8797','--env-file',REMOTE+'/source.env','--restart','unless-stopped',
          '--health-cmd',health,'--health-interval','15s','--health-timeout','5s',
          state['image'],'node','src/context-source-server.js'])
    state['api_readback']=verify_container(u,client,state,keys)
    after=u.protected(client);catalog_after=source_catalog(u,client)
    if before!=after or catalog_before!=catalog_after or state['catalog_before']!=catalog_after:
        raise RuntimeError('CONTEXT_SOURCE_PROTECTED_STATE_CHANGED')
    state['stage']='ready_localhost';state['protected_after']=after;state['catalog_after']=catalog_after
    h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'container':APP,'port':PORT,
        'api':state['api_readback'],'protected_unchanged':True,'existing_catalog_unchanged':True,
        'learner_cutover':False}


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    client=u.connect()
    try:
        return run_guarded(u,h,client,lambda:prepare(u,h,client),PRIVATE,with_catalog=True)
    finally:client.close()


if __name__=='__main__':sys.exit(main())
