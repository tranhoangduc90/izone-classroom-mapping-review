"""Mở API ở file/cổng HTTPS riêng đã có; chưa đổi giao diện hoặc nguồn ghi.

Giữ bản trước, kiểm đúng intent và backend mới; nginx -t trước reload.
Nếu kiểm sau thất bại, khôi phục đúng file riêng, giữ context route;
không sửa vhost443 hoặc cấu hình K56, không gửi bài/điểm thật.
"""
from pathlib import Path
import importlib.util
import json
import sys
import time
import uuid
import requests

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/public-api-route')
STATE=PRIVATE/'state.json'

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def config(route,intent):
    before=route.config(intent)
    tail=b'    location / { return 404; }\n'
    if before.count(tail)!=1:raise RuntimeError('K67_API_ROUTE_TEMPLATE_CHANGED')
    return before.replace(tail,b'''    location /term-mini-k67-api/ {
        client_max_body_size 1m;
        proxy_connect_timeout 3s;
        proxy_read_timeout 75s;
        proxy_send_timeout 30s;
        proxy_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://127.0.0.1:8796/;
    }
'''+tail)

def replace(sftp,route,before,after,state):
    # Một chủ sửa file riêng; kiểm nội dung trước thay, không gọi đây là CAS.
    if route.read(sftp,route.INCLUDE)!=before:raise RuntimeError('K67_API_ROUTE_OWN_FILE_CHANGED')
    temporary=route.INCLUDE+'.'+state['intent']+'.pending'
    existing=route.optional(sftp,temporary)
    if existing is None:
        with sftp.open(temporary,'wx') as stream:stream.write(after)
        sftp.chmod(temporary,0o644)
    elif existing!=after:raise RuntimeError('K67_API_ROUTE_TEMP_CHANGED')
    if route.read(sftp,route.INCLUDE)!=before:raise RuntimeError('K67_API_ROUTE_OWN_FILE_CHANGED')
    sftp.posix_rename(temporary,route.INCLUDE)
    if route.read(sftp,route.INCLUDE)!=after:raise RuntimeError('K67_API_ROUTE_WRITE_READBACK_UNKNOWN')

def check(route,image,source):
    result={}
    for path in ['/health','/ready','/version']:
        # Reload Nginx trả trước khi worker mới nhận cổng; chỉ đợi GET idempotent.
        for attempt in range(10):
            response=requests.get(route.PUBLIC+'/term-mini-k67-api'+path,timeout=15,allow_redirects=False)
            if response.status_code!=404 or attempt==9:break
            time.sleep(0.5)
        with (PRIVATE/('http-'+uuid.uuid4().hex+'.json')).open('x',encoding='utf-8') as stream:
            json.dump({'path':path,'status':response.status_code,'body_sha256':route.sha(response.content)},stream)
        if response.status_code!=200 or response.json()!= {'ok':True,'build':{'version':'k67-20261006','sha':image['revision']}}:
            raise RuntimeError('K67_PUBLIC_API_IDENTITY_MISMATCH')
        result[path]=200
    headers={'Origin':'https://tranhoangduc90.github.io','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}
    response=requests.options(route.PUBLIC+'/term-mini-k67-api/api/auth/session',headers=headers,timeout=15,allow_redirects=False)
    if response.status_code!=204 or response.headers.get('Access-Control-Allow-Origin')!=headers['Origin'] \
      or response.headers.get('Access-Control-Allow-Credentials')!='true':raise RuntimeError('K67_PUBLIC_CORS_INVALID')
    response=requests.get(route.PUBLIC+'/term-mini-k67-api/api/auth/me',timeout=15,allow_redirects=False)
    if response.status_code!=401:raise RuntimeError('K67_PUBLIC_TEACHER_AUTH_BOUNDARY')
    response=requests.post(route.PUBLIC+'/term-mini-k67-api/api/term-tests/writing-grading/jobs/claim',json={},timeout=15,allow_redirects=False)
    if response.status_code!=401:raise RuntimeError('K67_PUBLIC_GRADING_AUTH_BOUNDARY')
    response=requests.get(route.PUBLIC+'/mapping-api/health',timeout=15,allow_redirects=False)
    if response.status_code!=404:raise RuntimeError('K67_PUBLIC_SHARED_NAMESPACE_BOUNDARY')
    response=requests.get(route.PUBLIC+'/term-mini-k67-context/v1/snapshot',headers={'x-k67-context-key':source.secret_values()['api']},timeout=15,allow_redirects=False)
    if response.status_code!=200 or response.json().get('productId')!='PRODUCT-TERM-MINI-K67':raise RuntimeError('K67_CONTEXT_ROUTE_LOST')
    return {**result,'cors':204,'teacher_unauthorized':401,'grading_unauthorized':401,'shared_closed':404,'context':200}

def prepare(u,h,route,app,db,source,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    previous=json.loads(route.STATE.read_bytes());image=json.loads((PRIVATE.parent/'production-image/state.json').read_bytes())
    appstate=json.loads(app.STATE.read_bytes())
    if previous['stage']!='context_route_verified' or appstate['stage']!='private_runtime_ready':raise RuntimeError('K67_PUBLIC_API_PREREQUISITE_UNKNOWN')
    app.verify(u,client,appstate,app.environment(u,h,db,client,image))
    before=route.config(previous['intent']);desired=config(route,previous['intent'])
    if STATE.exists():
        state=json.loads(STATE.read_bytes())
        if state['before_sha256']!=route.sha(before) or state['after_sha256']!=route.sha(desired):raise RuntimeError('K67_PUBLIC_API_STATE_CHANGED')
    else:
        state={'intent':uuid.uuid4().hex,'before_sha256':route.sha(before),'after_sha256':route.sha(desired),'stage':'intent'};h.atomic(STATE,state)
    backup=PRIVATE/'before.conf'
    if backup.exists():
        if backup.read_bytes()!=before:raise RuntimeError('K67_PUBLIC_API_BACKUP_CHANGED')
    else:
        with backup.open('xb') as stream:stream.write(before)
    sftp=client.open_sftp();protected=route.protected_files(sftp);health=route.health()
    try:
        current=route.read(sftp,route.INCLUDE)
        if current not in [before,desired]:raise RuntimeError('K67_PUBLIC_API_INCLUDE_UNKNOWN')
        if current==before:
            state['stage']='write_intent';h.atomic(STATE,state);replace(sftp,route,before,desired,state)
        try:
            u.remote(client,['nginx','-t']);state['stage']='reload_intent';h.atomic(STATE,state);u.remote(client,['nginx','-s','reload'])
            checks=check(route,image,source)
            if route.protected_files(sftp)!=protected or route.health()!=health:raise RuntimeError('K67_PUBLIC_API_SHARED_STATE_CHANGED')
        except Exception:
            if route.read(sftp,route.INCLUDE)!=desired:raise RuntimeError('K67_PUBLIC_API_ROLLBACK_OWNERSHIP_UNKNOWN')
            replace(sftp,route,desired,before,state);u.remote(client,['nginx','-t']);u.remote(client,['nginx','-s','reload'])
            state['stage']='rolled_back_after_error';h.atomic(STATE,state);raise
        state['stage']='public_api_ready';state['checks']=checks;h.atomic(STATE,state)
        return {'outcome':'success','stage':state['stage'],'checks':checks,'protected_routes':health,
          'protected_files_unchanged':True,'learner_cutover':False}
    finally:sftp.close()

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    route=load('context_route','prepare-k67-route.py');app=load('production_app','prepare-production-app.py')
    db=load('production_db','prepare-production-database.py');source=load('context_guard','prepare-context-source.py')
    lock=load('grading_lock','prepare-grading-fixture.py');PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(route.PRIVATE/'operation.lock'):
        client=u.connect()
        try:return source.run_guarded(u,h,client,lambda:prepare(u,h,route,app,db,source,client),PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
