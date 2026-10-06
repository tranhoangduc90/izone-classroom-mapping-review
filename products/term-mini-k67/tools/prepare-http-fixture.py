"""Dựng backend K67 giữ sống và Portal giả bằng asset thật, người/bài giả.

Chỉ tạo tài nguyên fixture mới; ghi ý định trước mutation, kiểm marker khi tiếp lại.
Không chuyển route công khai, không sửa nguồn chung hoặc bật cây chấm.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import re
import secrets
import shlex
import subprocess
import sys
import tarfile
import uuid
from urllib.parse import quote
import win32crypt

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path('E:/Codex-Data/k67-backend-separation-20261006')
STORE = PRIVATE / 'live-http-fixture'
STATE = STORE / 'state.json'
REMOTE = '/opt/term-mini-k67-fixture/live-http'
PG = 'term-mini-k67-postgres-fixture'
APP = 'term-mini-k67-http-fixture'
GATE = 'term-mini-k67-gateway-fixture'
IDENTITY = 'PRODUCT-TERM-MINI-K67:synthetic-live-http-v1'
LABELS = {'com.izone.product':'PRODUCT-TERM-MINI-K67', 'com.izone.purpose':'synthetic-live-http-v1'}
SLUGS = ['term-test-1','term-test-2','mini-test-lesson-5']

def utilities():
    spec = importlib.util.spec_from_file_location('redis_fixture', ROOT / 'tools/prepare-redis-fixture.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

def atomic(path, value):
    # Ghi đủ file mới rồi thay state; không mất state cũ khi quá trình bị ngắt.
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as target:
        json.dump(value,target,ensure_ascii=False,indent=2);target.write('\n');target.flush()
        import os
        os.fsync(target.fileno())
    temporary.replace(path)

def sha(data): return hashlib.sha256(data).hexdigest()
def vault(path):
    _, raw = win32crypt.CryptUnprotectData(path.read_bytes(),None,None,None,0)
    return json.loads(raw.decode('utf-8'))
def fingerprint():
    result = subprocess.run([sys.executable,'C:/Users/ADMIN/.codex/hooks/enforce_product_process.py',
        'fingerprint','--root',str(ROOT),'--manifest',str(ROOT/'.codex/product-quality-gate.json')],
        capture_output=True,check=True,timeout=30)
    return json.loads(result.stdout.decode('utf-8'))['tree_revision']

def upload(client,path,data,mode):
    sftp=client.open_sftp()
    try:
        with sftp.open(path,'wx') as target: target.write(data)
        sftp.chmod(path,mode)
    finally: sftp.close()

def sql(u,client,database,source):
    return u.remote(client,['docker','exec','-i',PG,'psql','-X','-qAt','-v','ON_ERROR_STOP=1',
        '-U','k67_owner','-d',database],source.encode('utf-8')).decode().strip()

def current_source():
    files=[ROOT/'Dockerfile',ROOT/'package.json',ROOT/'package-lock.json',ROOT/'ops/fixture-gateway.mjs']
    files+=sorted((ROOT/'src').glob('*.js'))
    return {file.relative_to(ROOT).as_posix():sha(file.read_bytes()) for file in files}

def validate_state(state):
    if state.get('identity')!=IDENTITY or not re.fullmatch(r'[0-9a-f]{32}',state.get('intent_id','')) \
        or not re.fullmatch(r'term_mini_k67_test_live_[0-9a-f]{12}',state.get('database','')) \
        or sorted(state.get('student_refs',{}))!=sorted(SLUGS):raise RuntimeError('FIXTURE_STATE_IDENTITY_MISMATCH')
    for value in state['student_refs'].values():
        if str(uuid.UUID(value))!=value:raise RuntimeError('FIXTURE_STUDENT_ID_MISMATCH')

def seed_expected(state,definitions):
    return {'definitions':sorted(definitions,key=lambda row:row['slug']),
        'classes':[{'erp_course_class_id':1124,'erp_class_name_snapshot':'K67SIM'}],
        'roster':sorted([{'test_slug':slug,'erp_course_class_id':1124,'erp_student_contact_id':9870677001+i,
            'student_ref':state['student_refs'][slug],'student_name_snapshot':'Học viên mô phỏng '+str(i+1)}
            for i,slug in enumerate(SLUGS)],key=lambda row:row['test_slug']),
        'members':[{'erp_course_class_id':1124,'erp_student_contact_id':9870677001+i,
            'erp_student_name_snapshot':'Học viên mô phỏng '+str(i+1),'source_state':'active'} for i in range(3)],
        'context':[{'api_version':1,'product_id':'PRODUCT-TERM-MINI-K67','source_revision':state['definition_hash']}],
        'accounts':0}

def classify_seed(actual,expected):
    # Mất ACK sau COMMIT: chỉ nhận dữ liệu đúng nguyên mẫu, không ghi lại hoặc sửa bài/điểm.
    if actual==expected:return 'present'
    empty={key:(0 if key=='accounts' else []) for key in expected}
    if actual==empty:return 'empty'
    raise RuntimeError('FIXTURE_SEED_MISMATCH_INSPECT_REQUIRED')

def read_seed(u,client,state):
    query="""SELECT jsonb_build_object(
      'definitions',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY slug),'[]'::jsonb) FROM assessment.test_definition t),
      'classes',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY erp_course_class_id),'[]'::jsonb) FROM mapping.classroom_course_mapping t),
      'roster',(SELECT coalesce(jsonb_agg(jsonb_build_object('test_slug',test_slug,'erp_course_class_id',erp_course_class_id,
        'erp_student_contact_id',erp_student_contact_id,'student_ref',student_ref,'student_name_snapshot',student_name_snapshot) ORDER BY test_slug),'[]'::jsonb) FROM assessment.term_test_roster),
      'members',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY erp_student_contact_id),'[]'::jsonb) FROM mapping.erp_class_membership_snapshot t),
      'context',(SELECT coalesce(jsonb_agg(jsonb_build_object('api_version',api_version,'product_id',product_id,'source_revision',source_revision)),'[]'::jsonb) FROM mapping.k67_context_state),
      'accounts',(SELECT count(*) FROM mapping.reviewer_account))::text"""
    return json.loads(sql(u,client,state['database'],query))

def check_container(row,state,name,allow_stopped=False):
    if allow_stopped and name!=GATE: raise RuntimeError('STOPPED_CONTAINER_OUTSIDE_GATEWAY_RECOVERY')
    labels={**LABELS,'com.izone.fixture-intent':state['intent_id']}
    if row['Name']!='/'+name or row['Image']!=state['image'] or (not row['State']['Running'] and not allow_stopped) \
        or any(row['Config'].get('Labels',{}).get(k)!=v for k,v in labels.items()):
        raise RuntimeError('FIXTURE_CONTAINER_MISMATCH')
    host=row['HostConfig']
    expected_cpu,expected_mem,expected_pid=(500000000,268435456,100) if name==APP else (250000000,134217728,64)
    if host['NanoCpus']!=expected_cpu or host['Memory']!=expected_mem or host['PidsLimit']!=expected_pid \
        or not host['ReadonlyRootfs'] or host['NetworkMode']!='n8n-net' or row['Config']['User']!='node':
        raise RuntimeError('FIXTURE_QUOTA_MISMATCH')
    expected_mounts={REMOTE+'/assets':('/private-assets',False)} if name==APP else {
        REMOTE+'/portal-state':('/fixture-state',True),REMOTE+'/source/ops/fixture-gateway.mjs':('/fixture-gateway.mjs',False)}
    actual={r['Source']:(r['Destination'],r['RW']) for r in row['Mounts'] if r['Type']=='bind'}
    if actual!=expected_mounts: raise RuntimeError('FIXTURE_MOUNT_MISMATCH')
    ports=host['PortBindings'] or {}
    if ports!=({} if name==APP else {'8876/tcp':[{'HostIp':'127.0.0.1','HostPort':'18867'}]}):
        raise RuntimeError('FIXTURE_PORT_MISMATCH')

def prepare(u,client):
    STORE.mkdir(parents=True,exist_ok=True)
    source=current_source()
    names=u.remote(client,['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    if STATE.exists():
        state=json.loads(STATE.read_text(encoding='utf-8'))
        if state['identity']!=IDENTITY or state['source_hashes']!=source:
            raise RuntimeError('FIXTURE_STATE_OR_SOURCE_MISMATCH')
        for name in [APP,GATE]:
            if name in names:
                existing=json.loads(u.remote(client,['docker','inspect',name]))[0]
                if existing['Config'].get('Labels',{}).get('com.izone.fixture-intent')!=state['intent_id']:
                    raise RuntimeError('FIXTURE_NAME_COLLISION')
    else:
        if any(name in names for name in [APP,GATE]) or (STORE/'credentials.dpapi').exists():
            raise RuntimeError('FIXTURE_NAME_COLLISION')
        # UUID và DB đích được lưu trước khi tạo; lỗi giữ ý định, không tự đổi tên rồi tạo lại.
        state={'identity':IDENTITY,'intent_id':uuid.uuid4().hex,'database':'term_mini_k67_test_live_'+uuid.uuid4().hex[:12],
            'source_hashes':source,'student_refs':{slug:str(uuid.uuid4()) for slug in SLUGS},'stages':[]}
        atomic(STATE,state)
    stages=state['stages']
    validate_state(state)
    if (STORE/'credentials.dpapi').exists():
        existing_vault=vault(STORE/'credentials.dpapi')
        if existing_vault.get('identity')!=IDENTITY or existing_vault.get('intent_id')!=state['intent_id']:
            raise RuntimeError('FIXTURE_VAULT_COLLISION')
    # Không dùng thư mục/tài nguyên tên trùng của lượt hoặc task khác.
    expected_marker={'identity':IDENTITY,'intent_id':state['intent_id'],'source_hashes':source}
    sftp=client.open_sftp()
    try:
        try:sftp.stat(REMOTE)
        except FileNotFoundError:
            sftp.mkdir(REMOTE,mode=0o700)
            with sftp.open(REMOTE+'/intent.json','wx') as out:out.write(json.dumps(expected_marker))
        else:
            try:
                with sftp.open(REMOTE+'/intent.json','rb') as incoming:observed=json.loads(incoming.read())
            except FileNotFoundError:raise RuntimeError('FIXTURE_REMOTE_DIRECTORY_UNMARKED')
            if observed!=expected_marker:raise RuntimeError('FIXTURE_REMOTE_MARKER_MISMATCH')
    finally:sftp.close()
    def stage(name):
        if name not in stages: stages.append(name);atomic(STATE,state)
        print(json.dumps({'stage':name,'intent_id':state['intent_id']}),flush=True)
    pg=json.loads(u.remote(client,['docker','inspect',PG]))[0]
    if pg['Config'].get('Labels',{}).get('com.izone.product')!='PRODUCT-TERM-MINI-K67':
        raise RuntimeError('PG_FIXTURE_LABEL_MISMATCH')
    marker=sql(u,client,'term_mini_k67_test_database',"SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity")
    if marker!='PRODUCT-TERM-MINI-K67:synthetic-fixture-20261006':raise RuntimeError('PG_FIXTURE_MARKER_MISMATCH')
    if 'n8n-net' not in pg['NetworkSettings']['Networks']:
        u.remote(client,['docker','network','connect','n8n-net',PG])
    pg=json.loads(u.remote(client,['docker','inspect',PG]))[0]
    if 'n8n-net' not in pg['NetworkSettings']['Networks']:raise RuntimeError('PG_NETWORK_READBACK_FAILED')
    stage('own_pg_network')
    # Chỉ ba dòng định nghĩa đề từ nguồn; không lấy bài hoặc danh tính thật.
    query="BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT jsonb_agg(to_jsonb(t) ORDER BY slug)::text FROM assessment.test_definition t WHERE slug IN ('term-test-1','term-test-2','mini-test-lesson-5'); ROLLBACK;"
    source_pg=json.loads(u.remote(client,['docker','inspect','mapping-postgres']))[0]
    source_env=dict(value.split('=',1) for value in source_pg['Config']['Env'] if '=' in value)
    source_user=source_env['POSTGRES_USER'];source_database=source_env['POSTGRES_DB'];source_env=None;source_pg=None
    raw=u.remote(client,['docker','exec','mapping-postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',source_user,'-d',source_database,'-c',query])
    definitions=json.loads(raw)
    if sorted(row['slug'] for row in definitions)!=sorted(SLUGS) or not all(row['is_active'] for row in definitions):
        raise RuntimeError('SOURCE_DEFINITIONS_MISMATCH')
    definition_hash=sha(raw)
    if state.get('definition_hash',definition_hash)!=definition_hash:raise RuntimeError('SOURCE_DEFINITIONS_CHANGED')
    state['definition_hash']=definition_hash;atomic(STATE,state)
    if not (STORE/'test-definitions.json').exists():
        with (STORE/'test-definitions.json').open('xb') as out:out.write(raw)
    if sha((STORE/'test-definitions.json').read_bytes())!=definition_hash:raise RuntimeError('DEFINITION_SNAPSHOT_MISMATCH')
    databases=u.remote(client,['docker','exec',PG,'psql','-X','-qAt','-U','k67_owner','-d','term_mini_k67_test_database',
        '-c','SELECT datname FROM pg_database']).decode().splitlines()
    if state['database'] not in databases:
        u.remote(client,['docker','exec',PG,'createdb','-U','k67_owner','--template=template0',state['database']])
    else:
        # DB từ lượt dở chưa có marker là unknown; không ghi đè schema hoặc dữ liệu để vượt lỗi.
        existing=sql(u,client,state['database'],"SELECT to_regclass('mapping.k67_fixture_identity')::text")
        if not existing:raise RuntimeError('FIXTURE_DATABASE_UNMARKED_INSPECT_REQUIRED')
    if 'database' not in stages:
        exists=sql(u,client,state['database'],"SELECT to_regclass('mapping.k67_fixture_identity')::text")
        if not exists:
            ddl=['BEGIN;']+[(ROOT/'db'/name).read_text(encoding='utf-8') for name in
                ['001-context.sql','002-history.sql','003-assessment.sql','004-grants.sql','005-context-auth.sql']]
            ddl += ["CREATE TABLE mapping.k67_fixture_identity(product_id text PRIMARY KEY,fixture_id text NOT NULL);",
                "INSERT INTO mapping.k67_fixture_identity VALUES('PRODUCT-TERM-MINI-K67','"+state['intent_id']+"');",
                'GRANT SELECT ON mapping.k67_fixture_identity TO k67_app;','COMMIT;']
            sql(u,client,state['database'],'\n'.join(ddl))
        stage('database')
    if sql(u,client,state['database'],"SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity")!= 'PRODUCT-TERM-MINI-K67:'+state['intent_id']:
        raise RuntimeError('TARGET_DATABASE_MARKER_MISMATCH')
    seed_status=classify_seed(read_seed(u,client,state),seed_expected(state,definitions))
    if seed_status=='empty':
        # Toàn bộ người/lớp ở đích là giả; đưa JSON qua stdin SQL, không nội suy dữ liệu nguồn thành mã SQL.
        payload=json.dumps(definitions,ensure_ascii=False)
        delimiter='$k67_'+uuid.uuid4().hex+'$'
        if delimiter in payload:raise RuntimeError('SQL_DELIMITER_COLLISION')
        parts=['BEGIN;']
        parts += ["INSERT INTO assessment.test_definition SELECT * FROM jsonb_populate_recordset(NULL::assessment.test_definition,"+delimiter+payload+delimiter+"::jsonb);"]
        parts += ["INSERT INTO mapping.classroom_course_mapping VALUES(1124,'K67SIM');",
            "INSERT INTO mapping.k67_context_state(api_version,product_id,source_revision,captured_at) VALUES(1,'PRODUCT-TERM-MINI-K67','"+definition_hash+"',now());"]
        for i,slug in enumerate(SLUGS):
            student=9870677001+i;ref=state['student_refs'][slug]
            parts += ["INSERT INTO mapping.erp_class_membership_snapshot VALUES(1124,"+str(student)+",'Học viên mô phỏng "+str(i+1)+"','active');",
                "INSERT INTO assessment.term_test_roster(test_slug,erp_course_class_id,erp_student_contact_id,student_ref,student_name_snapshot) VALUES('"+slug+"',1124,"+str(student)+",'"+ref+"','Học viên mô phỏng "+str(i+1)+"');"]
        parts+=['COMMIT;'];sql(u,client,state['database'],'\n'.join(parts))
    if classify_seed(read_seed(u,client,state),seed_expected(state,definitions))!='present':raise RuntimeError('FIXTURE_SEED_READBACK_FAILED')
    stage('seed')
    inventory=json.loads((PRIVATE/'ASSETS_AND_PAGES_INVENTORY_FINAL.json').read_text(encoding='utf-8'))['assets']['rows']
    if len(inventory)!=9:raise RuntimeError('ASSET_INVENTORY_MISMATCH')
    source_script='''import json,sys,pathlib,hashlib,shutil,os
rows=json.load(sys.stdin);src=pathlib.Path('/opt/mapping-review-api/private-assets');dst=pathlib.Path('/opt/term-mini-k67-fixture/live-http/assets')
def verify(file,row):
 if file.is_symlink() or not file.is_file() or file.stat().st_size!=row['bytes'] or hashlib.sha256(file.read_bytes()).hexdigest()!=row['sha256']:raise RuntimeError('ASSET_HASH_MISMATCH')
for row in rows:verify(src/row['path'],row)
dst.mkdir(parents=True,exist_ok=True);os.chmod(dst,0o755)
for row in rows:
 target=dst/row['path'];target.parent.mkdir(exist_ok=True);os.chmod(target.parent,0o755)
 if not target.exists():
  with target.open('xb') as out,(src/row['path']).open('rb') as incoming:shutil.copyfileobj(incoming,out)
  os.chmod(target,0o644)
 verify(target,row);verify(src/row['path'],row)
expected={row['path'] for row in rows};actual={p.relative_to(dst).as_posix() for p in dst.rglob('*') if p.is_file()}
if actual!=expected:raise RuntimeError('ASSET_EXTRA_FILE')
print(json.dumps({'count':len(rows),'before_after_hashes_equal':True}))
'''
    # Python nguồn cố định được tải vào thư mục riêng rồi inventory truyền stdin.
    u.remote(client,['mkdir','-p',REMOTE]);u.remote(client,['chmod','700',REMOTE])
    script_path=REMOTE+'/copy-assets-'+state['intent_id']+'.py'
    sftp=client.open_sftp()
    try:
        try:
            with sftp.open(script_path,'rb') as f:observed=f.read()
        except FileNotFoundError:observed=None
    finally:sftp.close()
    if observed is None:upload(client,script_path,source_script.encode(),0o600)
    elif observed!=source_script.encode():raise RuntimeError('ASSET_COPY_SCRIPT_CHANGED')
    result=u.remote(client,['python3',script_path],json.dumps(inventory).encode())
    state['asset_readback']=json.loads(result);atomic(STATE,state);stage('assets')
    if 'image' not in state:
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w:gz') as archive:
            for relative in source:
                data=(ROOT/relative).read_bytes();entry=tarfile.TarInfo(relative);entry.size=len(data);entry.mode=0o644
                archive.addfile(entry,io.BytesIO(data))
        u.remote(client,['mkdir','-p',REMOTE+'/source'])
        archive_path=REMOTE+'/source-'+state['intent_id']+'.tgz'
        expected_archive=stream.getvalue()
        sftp=client.open_sftp()
        try:
            try:
                with sftp.open(archive_path,'rb') as incoming:existing_archive=incoming.read()
            except FileNotFoundError:existing_archive=None
        finally:sftp.close()
        # gzip chứa mtime khác giữa hai lượt; so payload tar và từng file, không chỉ byte archive.
        if existing_archive is None:upload(client,archive_path,expected_archive,0o600)
        else:
            with tarfile.open(fileobj=io.BytesIO(existing_archive),mode='r:gz') as existing:
                members=existing.getmembers()
                if sorted(member.name for member in members)!=sorted(source) or any(not member.isfile() for member in members):
                    raise RuntimeError('FIXTURE_ARCHIVE_MISMATCH')
                if any(sha(existing.extractfile(member).read())!=source[member.name] for member in members):raise RuntimeError('FIXTURE_ARCHIVE_HASH_MISMATCH')
        u.remote(client,['tar','-xzf',archive_path,'-C',REMOTE+'/source'])
        tag='izone-term-mini-k67-fixture:'+state['intent_id']
        # stdout/stderr build không có secret; giữ file thật cho điều tra.
        image_labels={**LABELS,'com.izone.fixture-intent':state['intent_id'],
            'com.izone.source':sha(json.dumps(source,sort_keys=True).encode())}
        existing_image=u.remote(client,['docker','image','ls','-q','--no-trunc',tag]).decode().strip()
        if not existing_image:
            argv=['docker','build','-t',tag,'-f',REMOTE+'/source/Dockerfile']
            for k,v in image_labels.items():argv+=['--label',k+'='+v]
            argv+=[REMOTE+'/source']
            data=u.remote(client,argv,timeout=300,include_stderr=True)
            with (STORE/('build-'+uuid.uuid4().hex+'.log')).open('xb') as out:out.write(data)
        image_info=json.loads(u.remote(client,['docker','image','inspect',tag]))[0]
        if any(image_info['Config'].get('Labels',{}).get(k)!=v for k,v in image_labels.items()):raise RuntimeError('FIXTURE_IMAGE_LABEL_MISMATCH')
        state['image']=json.loads(u.remote(client,['docker','image','inspect',tag]))[0]['Id'];atomic(STATE,state)
    stage('image')
    secrets_path=STORE/'credentials.dpapi'
    if not secrets_path.exists():
        values={name:secrets.token_urlsafe(48) for name in ['portal','control','session','legacy']}
        values['identity']=IDENTITY;values['intent_id']=state['intent_id']
        raw=win32crypt.CryptProtectData(json.dumps(values).encode(),'K67 HTTP fixture',None,None,None,0)
        with secrets_path.open('xb') as f:f.write(raw)
    values=vault(secrets_path)
    if values['identity']!=IDENTITY or values['intent_id']!=state['intent_id']:raise RuntimeError('FIXTURE_VAULT_MISMATCH')
    credentials=vault(PRIVATE/'fixture-credentials.dpapi')
    service=vault(PRIVATE/'grading-provision/service-keys.dpapi')
    # Chưa bật notifier/ERP; callback được khóa bằng credential K67 riêng.
    env={'K67_ENV':'test','K67_PORT':'8796','K67_AUTH_MODE':'legacy','K67_LEGACY_REVIEW_TOKEN':values['legacy'],
        'K67_DATABASE_URL':'postgresql://k67_app:'+quote(credentials['k67_app'],safe='')+'@'+PG+':5432/'+state['database'],
        'K67_PUBLIC_API_BASE_URL':'http://'+GATE+':8876/term-mini-k67-api','K67_ASSET_DIR':'/private-assets',
        'K67_SESSION_SECRET':values['session'],'K67_WRITING_SYNC_SECRET':service['grading_sync'],
        'K67_MINI_SYNC_SECRET':service['mini_sync'],'K67_APP_VERSION':'synthetic-live-http-v1','K67_BUILD_SHA':state['source_revision']}
    gateway_env={'K67_FIXTURE_PORTAL_SECRET':values['portal'],'K67_FIXTURE_CONTROL_SECRET':values['control'],'K67_FIXTURE_INTENT':state['intent_id']}
    credentials=None;values=None;service=None
    for name,environment in [(APP,env),(GATE,gateway_env)]:
        if name not in names:
            env_path=REMOTE+'/'+name+'.'+uuid.uuid4().hex+'.env'
            upload(client,env_path,'\n'.join(k+'='+v for k,v in environment.items())+'\n',0o600)
            argv=['docker','run','-d','--name',name,'--network','n8n-net','--restart','unless-stopped',
                '--read-only','--tmpfs','/tmp:rw,size=32m,mode=1777','--env-file',env_path]
            for k,v in {**LABELS,'com.izone.fixture-intent':state['intent_id']}.items():argv+=['--label',k+'='+v]
            if name==APP:argv+=['--cpus','0.5','--memory','256m','--pids-limit','100','-v',REMOTE+'/assets:/private-assets:ro',state['image']]
            else:
                u.remote(client,['mkdir','-p',REMOTE+'/portal-state']);u.remote(client,['chown','1000:1000',REMOTE+'/portal-state'])
                argv+=['--cpus','0.25','--memory','128m','--pids-limit','64','--health-cmd',"node --input-type=module -e \"const r=await fetch('http://127.0.0.1:8876/fixture/ready');process.exit(r.ok?0:1)\"",
                    '-p','127.0.0.1:18867:8876','-v',REMOTE+'/portal-state:/fixture-state:rw',
                    '-v',REMOTE+'/source/ops/fixture-gateway.mjs:/fixture-gateway.mjs:ro',state['image'],'node','/fixture-gateway.mjs']
            try:u.remote(client,argv,timeout=60)
            finally:
                sftp=client.open_sftp()
                try:sftp.remove(env_path)
                finally:sftp.close()
        row=json.loads(u.remote(client,['docker','inspect',name]))[0];check_container(row,state,name)
        observed_env=dict(value.split('=',1) for value in row['Config']['Env'] if '=' in value)
        if any(observed_env.get(k)!=v for k,v in environment.items()):raise RuntimeError('FIXTURE_ENV_MISMATCH')
        stage(name)
    state['definition_readback_complete']=True;atomic(STATE,state)
    return state

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True);sys.stderr.reconfigure(encoding='utf-8',line_buffering=True)
    u=utilities();client=u.connect();before=u.protected(client);revision=fingerprint();state=None;error=None
    try:
        if STATE.exists():
            state=json.loads(STATE.read_text(encoding='utf-8'))
        else:
            STORE.mkdir(parents=True,exist_ok=True)
        # Source revision thuộc package này; giữ revision lúc dựng kể cả lần tiếp sau.
        if state is None:
            state={'identity':IDENTITY,'intent_id':uuid.uuid4().hex,'database':'term_mini_k67_test_live_'+uuid.uuid4().hex[:12],
                'source_hashes':current_source(),'source_revision':revision,'student_refs':{slug:str(uuid.uuid4()) for slug in SLUGS},'stages':[]}
            atomic(STATE,state)
        state=prepare(u,client)
    except Exception as exc:error=type(exc).__name__+':'+str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
    finally:
        try:after=u.protected(client);guard_error=None
        except Exception as exc:after=None;guard_error=type(exc).__name__
        client.close()
    after_revision=fingerprint();outcome='passed' if error is None and guard_error is None and before==after and revision==after_revision else 'failure'
    receipt={'run_id':'k67-live-http-provision-'+uuid.uuid4().hex,'outcome':outcome,'operation_error':error,
        'guard_error':guard_error,'tree_revision':revision,'observed_after_revision':after_revision,'protected_before':before,'protected_after':after,
        'state_path':str(STATE),'observed_at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z')}
    path=STORE/(receipt['run_id']+'.json');atomic(path,receipt)
    print(json.dumps({k:receipt[k] for k in ['run_id','outcome','operation_error','guard_error']}))
    return 0 if outcome=='passed' else 1
if __name__=='__main__':sys.exit(main())
