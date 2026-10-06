"""Dựng backend K67 trên kho riêng còn trống, chưa mở tuyến học viên.

Chép đúng chín asset đã ghim vào thư mục riêng; giữ khóa audio cũ để phiên
được chuyển vẫn mở được. Chỉ tạo container K67 mới với cấu hình/kho riêng;
không dựng lại backend chung, bật workflow hoặc chép bài thi trong bước này.
"""
from pathlib import Path
from urllib.parse import quote
import hashlib
import importlib.util
import json
import re
import stat
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-app')
STATE=PRIVATE/'state.json'
REMOTE='/opt/term-mini-k67'
APP='term-mini-k67-api'
PRODUCT='PRODUCT-TERM-MINI-K67'

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def sha(raw):return hashlib.sha256(raw).hexdigest()

def own_directory(sftp,state):
    marker=json.dumps({'product':PRODUCT,'intent':state['intent'],'purpose':'production-app-v1'},sort_keys=True).encode()
    try:info=sftp.lstat(REMOTE)
    except FileNotFoundError:
        sftp.mkdir(REMOTE,mode=0o700)
        with sftp.open(REMOTE+'/identity.json','wx') as stream:stream.write(marker)
        sftp.chmod(REMOTE+'/identity.json',0o600);info=sftp.lstat(REMOTE)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o777!=0o700:
        raise RuntimeError('K67_APP_REMOTE_OWNERSHIP_UNKNOWN')
    with sftp.open(REMOTE+'/identity.json','rb') as stream:actual=stream.read()
    if actual!=marker or set(sftp.listdir(REMOTE))-{'identity.json','copy-assets.py','app.env','assets'}:
        raise RuntimeError('K67_APP_REMOTE_MARKER_CHANGED')

def own_file(sftp,name,raw,mode):
    path=REMOTE+'/'+name
    try:info=sftp.lstat(path)
    except FileNotFoundError:
        with sftp.open(path,'wx') as stream:stream.write(raw)
        sftp.chmod(path,mode);info=sftp.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o777!=mode:
        raise RuntimeError('K67_APP_FILE_OWNERSHIP_UNKNOWN')
    with sftp.open(path,'rb') as stream:observed=stream.read()
    if observed!=raw:raise RuntimeError('K67_APP_FILE_CHANGED')

COPY_SCRIPT='''# Nhận inventory qua stdin, chép asset đã kiểm; khác hash dừng, không sửa nguồn.
import hashlib,json,os,pathlib,shutil,sys
rows=json.load(sys.stdin)
src=pathlib.Path('/opt/mapping-review-api/private-assets')
dst=pathlib.Path('/opt/term-mini-k67/assets')
expected={r['path'] for r in rows}
def directory(p):
 if p.is_symlink():raise RuntimeError('ASSET_DIRECTORY_SYMLINK')
 if not p.exists():p.mkdir(mode=0o755)
 if not p.is_dir() or p.stat().st_uid!=0 or p.stat().st_mode&0o777!=0o755:raise RuntimeError('ASSET_DIRECTORY_UNKNOWN')
def verify(p,r):
 if p.is_symlink() or not p.is_file() or p.stat().st_size!=r['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest()!=r['sha256']:raise RuntimeError('ASSET_HASH_MISMATCH')
for r in rows:
 p=pathlib.PurePosixPath(r['path'])
 if p.is_absolute() or '..' in p.parts or len(p.parts)!=2:raise RuntimeError('ASSET_PATH_INVALID')
 if (src/p.parts[0]).is_symlink():raise RuntimeError('SOURCE_DIRECTORY_SYMLINK')
 verify(src/r['path'],r)
directory(dst)
for r in rows:
 directory((dst/r['path']).parent)
 target=dst/r['path']
 if not target.exists():
  with target.open('xb') as out,(src/r['path']).open('rb') as incoming:shutil.copyfileobj(incoming,out)
  os.chmod(target,0o644)
 verify(target,r);verify(src/r['path'],r)
 if target.stat().st_uid!=0 or target.stat().st_mode&0o777!=0o644:raise RuntimeError('ASSET_FILE_MODE_CHANGED')
actual=set()
for p in dst.rglob('*'):
 if p.is_symlink():raise RuntimeError('ASSET_SYMLINK')
 if p.is_file():actual.add(p.relative_to(dst).as_posix())
if actual!=expected:raise RuntimeError('ASSET_EXTRA_FILE')
print(json.dumps({'count':len(rows),'source_destination_hashes_equal':True}))
'''

def environment(u,h,db,client,image):
    # Sau bootstrap, dùng khóa đã ghim của K67; K56 đổi khóa không đổi bản dựng K67.
    sftp=client.open_sftp()
    try:
        try:info=sftp.lstat(REMOTE+'/app.env')
        except FileNotFoundError:info=None
        if info is not None:
            if not STATE.exists():raise RuntimeError('K67_APP_ENV_WITHOUT_IDENTITY')
            state=json.loads(STATE.read_bytes())
            sftp.lstat(REMOTE);own_directory(sftp,state)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o777!=0o600:
                raise RuntimeError('K67_APP_ENV_OWNERSHIP_UNKNOWN')
            with sftp.open(REMOTE+'/app.env','rb') as stream:lines=stream.read().decode().splitlines()
            values=[line.split('=',1)[1] for line in lines if line.startswith('K67_SESSION_SECRET=')]
            if len(values)!=1:raise RuntimeError('K67_APP_PINNED_AUDIO_KEY_UNKNOWN')
            session=values[0]
        else:
            if STATE.exists() and json.loads(STATE.read_bytes())['stage']!='intent':
                raise RuntimeError('K67_APP_PINNED_ENV_MISSING')
            source=json.loads(u.remote(client,['docker','inspect','mapping-review-api']))[0]
            source_env=dict(value.split('=',1) for value in source['Config']['Env'] if '=' in value)
            session=source_env.get('TERM_TEST_SESSION_SECRET','')
    finally:sftp.close()
    if len(session)<32 or any(c in session for c in '\r\n\x00'):raise RuntimeError('K67_AUDIO_COMPATIBILITY_KEY_UNKNOWN')
    service=h.vault(PRIVATE.parent/'grading-provision/service-keys.dpapi')
    if service.get('product_id')!=PRODUCT:raise RuntimeError('K67_APP_SERVICE_VAULT_CHANGED')
    credentials=db.keys();password=credentials['roles']['k67_app']
    return {'K67_ENV':'production','K67_PORT':'8796','K67_DB_POOL_MAX':'5',
      'K67_DATABASE_URL':'postgresql://k67_app:'+quote(password,safe='')+'@term-mini-k67-postgres:5432/term_mini_k67',
      'K67_AUTH_MODE':'google','K67_GOOGLE_CLIENT_ID':'235597750133-urmb86ktf5recnvvtbghf13bktfv5rkj.apps.googleusercontent.com',
      'K67_ALLOWED_ORIGINS':'https://tranhoangduc90.github.io','K67_TRUST_PROXY_HOPS':'1',
      'K67_ERP_SYNC_URL':'https://n8n-ai.izone.edu.vn/webhook/term-mini-k67-gui-diem-ve-lop',
      'K67_ERP_SYNC_SECRET':service['erp_sync'],'K67_MINI_SYNC_SECRET':service['mini_sync'],
      'K67_WRITING_SYNC_SECRET':service['grading_sync'],
      'K67_NOTIFY_URL':'https://ducizone.ddns.net/webhook/term-mini-k67-nhan-bai-viet','K67_NOTIFY_SECRET':service['notify'],
      'K67_PUBLIC_API_BASE_URL':'https://ducizone.ddns.net:18869/term-mini-k67-api','K67_ASSET_DIR':'/private-assets',
      'K67_SESSION_SECRET':session,'K67_APP_VERSION':'k67-20261006','K67_BUILD_SHA':image['revision']}

def verify(u,client,state,env):
    row=json.loads(u.remote(client,['docker','inspect',APP]))[0];host=row['HostConfig']
    labels={'com.izone.product':PRODUCT,'com.izone.purpose':'production-app-v1','com.izone.intent':state['intent']}
    live_env=dict(value.split('=',1) for value in row['Config']['Env'] if '=' in value)
    mounts={r['Destination']:(r['Source'],r['Type'],r['RW']) for r in row['Mounts']}
    if row['Name']!='/'+APP or not row['State']['Running'] or row['Image']!=state['image'] \
      or row['Config']['User']!='node' or any(row['Config'].get('Labels',{}).get(k)!=v for k,v in labels.items()) \
      or any(live_env.get(k)!=v for k,v in env.items()) or host['NetworkMode']!='n8n-net' \
      or host['NanoCpus']!=500000000 or host['Memory']!=268435456 or host['PidsLimit']!=100 \
      or not host['ReadonlyRootfs'] or host['CapDrop']!=['ALL'] \
      or 'no-new-privileges' not in host['SecurityOpt'] \
      or host['PortBindings']!={'8796/tcp':[{'HostIp':'127.0.0.1','HostPort':'8796'}]} \
      or mounts!={'/private-assets':(REMOTE+'/assets','bind',False)}:
        raise RuntimeError('K67_APP_RUNTIME_MISMATCH')
    return row

def prepare(u,h,db,guard,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    image=json.loads((PRIVATE.parent/'production-image/state.json').read_bytes())
    if image['stage']!='release_image_verified':raise RuntimeError('K67_APP_IMAGE_NOT_VERIFIED')
    db_state=json.loads(db.STATE.read_bytes());db.verify_container(u,client,db_state);db.verify_schema(u,client,db_state)
    names=u.remote(client,['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    if STATE.exists():
        state=json.loads(STATE.read_bytes())
        if state['image']!=image['image'] or not re.fullmatch('[a-f0-9]{32}',state['intent']):raise RuntimeError('K67_APP_STATE_CHANGED')
    else:
        if APP in names:raise RuntimeError('K67_APP_NAME_COLLISION')
        state={'intent':uuid.uuid4().hex,'image':image['image'],'stage':'intent'};h.atomic(STATE,state)
    inventory=json.loads((PRIVATE.parent/'ASSETS_AND_PAGES_INVENTORY_FINAL.json').read_bytes())['assets']['rows']
    if len(inventory)!=9:raise RuntimeError('K67_APP_ASSET_INVENTORY_CHANGED')
    env=environment(u,h,db,client,image)
    raw_env=('\n'.join(key+'='+value for key,value in env.items())+'\n').encode()
    sftp=client.open_sftp()
    try:
        own_directory(sftp,state);own_file(sftp,'copy-assets.py',COPY_SCRIPT.encode(),0o600)
        own_file(sftp,'app.env',raw_env,0o600)
    finally:sftp.close()
    assets=json.loads(u.remote(client,['python3',REMOTE+'/copy-assets.py'],json.dumps(inventory).encode(),timeout=120))
    state['assets']=assets;h.atomic(STATE,state)
    if APP not in names:
        # Kho chưa có bài/job: startup notifier không thể đánh thức chấm bài thật.
        counts=db.query(u,client,"SELECT jsonb_build_object('attempts',(SELECT count(*) FROM assessment.term_test_attempt),'jobs',(SELECT count(*) FROM assessment.term_test_writing_grading_job))")
        if counts!={'attempts':0,'jobs':0}:raise RuntimeError('K67_APP_START_BEFORE_OWNERSHIP_REFUSED')
        if u.remote(client,['ss','-H','-ltn','sport = :8796']).strip():raise RuntimeError('K67_APP_PORT_COLLISION')
        argv=['docker','run','--detach','--name',APP]
        for k,v in {'com.izone.product':PRODUCT,'com.izone.purpose':'production-app-v1','com.izone.intent':state['intent']}.items():argv+=['--label',k+'='+v]
        state['stage']='container_create_intent';h.atomic(STATE,state)
        u.remote(client,[*argv,'--network','n8n-net','--restart','unless-stopped','--read-only',
          '--tmpfs','/tmp:rw,size=32m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges',
          '--cpus','0.5','--memory','256m','--memory-swap','256m','--pids-limit','100',
          '--publish','127.0.0.1:8796:8796','--env-file',REMOTE+'/app.env',
          '--mount','type=bind,src='+REMOTE+'/assets,dst=/private-assets,readonly',state['image']])
    verify(u,client,state,env)
    for attempt in range(15):
        try:
            ready=json.loads(u.remote(client,['curl','--silent','--show-error','--fail','--max-time','5','http://127.0.0.1:8796/ready']))
            if ready.get('ok') is not True:raise RuntimeError('K67_APP_READY_INVALID')
            break
        except RuntimeError:
            if attempt==14:raise
            time.sleep(1)
    state['stage']='private_runtime_ready';state['ready']=ready;h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'container':APP,'assets':assets,
      'image':state['image'],'audio_key_compatible':True,'learner_cutover':False}

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    db=load('production_db','prepare-production-database.py');guard=load('context_guard','prepare-context-source.py')
    fixture=load('grading_fixture_lock','prepare-grading-fixture.py');PRIVATE.mkdir(parents=True,exist_ok=True)
    with fixture.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:return guard.run_guarded(u,h,client,lambda:prepare(u,h,db,guard,client),PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
