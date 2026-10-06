"""Diễn tập đổi bản chạy K67 rồi quay lại, giữ nguyên kho đã có bài mới.

Dựng runtime thứ hai từ cùng source/image đã ghim, chỉ đổi nhãn build để nhận
diện. Chuyển đúng API18869 sang runtime mới, đọc kết quả giả, trả tuyến về bản
chính và dừng runtime diễn tập. Không đổi shared443/K56 hoặc phục hồi dump cũ.
"""
from pathlib import Path
import importlib.util
import json
import sys
import time
import uuid
import requests

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/release-rehearsal')
STATE=PRIVATE/'state.json'
APP='term-mini-k67-release-rehearsal'
REMOTE='/opt/term-mini-k67-release-rehearsal'
PORT='8799'
ROLLBACK_STAGES={'rollback_exchange_intent','rollback_reload_intent','standby_stop_intent','rolled_back_verified','rolled_back_after_error'}

def load(name,file,base='tools'):
    s=importlib.util.spec_from_file_location(name,ROOT/base/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def observe(base,version,revision,fake):
    for attempt in range(15):
        response=requests.get(base+'/version',timeout=15,allow_redirects=False)
        if response.status_code==200 and response.json()=={'ok':True,'build':{'version':version,'sha':revision}}:break
        time.sleep(0.5)
    else:raise RuntimeError('K67_REHEARSAL_RUNTIME_NOT_OBSERVED')
    results={}
    for slug,token in fake['attempts'].items():
        r=requests.post(base+'/api/term-tests/result',json={'attemptToken':token},timeout=20,allow_redirects=False)
        if r.status_code!=200 or r.json().get('ok') is not True:raise RuntimeError('K67_REHEARSAL_RESULT_NOT_VISIBLE')
        body=r.json();results[slug]={k:body.get(k) for k in ['result','portalSyncStatus','completed']}
        results[slug]['writing']={k:(body.get('writing') or {}).get(k) for k in ['task1','task2','submitted','grading']}
    return results

def verify_app(u,client,state,image,environment):
    row=json.loads(u.remote(client,['docker','inspect',APP]))[0]
    host=row['HostConfig'];env=dict(x.split('=',1) for x in row['Config']['Env'] if '=' in x)
    labels={'com.izone.product':'PRODUCT-TERM-MINI-K67','com.izone.purpose':'release-rehearsal','com.izone.intent':state['intent']}
    mounts={x['Destination']:(x['Source'],x['RW']) for x in row['Mounts']}
    if row['Name']!='/'+APP or row['Image']!=image['image'] or row['Config']['User']!='node' \
      or row['Config']['Cmd']!=['node','src/server.js'] or any(row['Config'].get('Labels',{}).get(k)!=v for k,v in labels.items()) \
      or any(env.get(k)!=v for k,v in environment.items()) or host['NanoCpus']!=500000000 or host['Memory']!=268435456 \
      or host['PidsLimit']!=100 or not host['ReadonlyRootfs'] or host['NetworkMode']!='n8n-net' \
      or host['PortBindings']!={'8796/tcp':[{'HostIp':'127.0.0.1','HostPort':PORT}]} \
      or mounts!={'/private-assets':('/opt/term-mini-k67/assets',False)}:
        raise RuntimeError('K67_REHEARSAL_RUNTIME_IDENTITY_CHANGED')
    return row['State']['Running']

def rehearse_route(u,h,route,legacy,prepare,c,client,sftp,state,image,environment,fake,before,after):
    """Đổi đúng tuyến riêng; lỗi sau đổi luôn thử trả tuyến chính bằng exact hash.

    Kết quả mô phỏng được đọc lại, không replay bài. Lỗi forward và phục hồi
    được lưu riêng; mất ACK dừng container được đối soát bằng trạng thái thật.
    """
    base=route.PUBLIC+'/term-mini-k67-api'
    def primary():
        if route.read(sftp,route.INCLUDE)!=before:raise RuntimeError('K67_REHEARSAL_ROLLBACK_ROUTE_CHANGED')
        if observe(base,'k67-20261006',image['revision'],fake)!=state['baseline']:
            raise RuntimeError('K67_REHEARSAL_ROLLBACK_RESULT_CHANGED')
        if route.protected_files(sftp)!=state['protected_files'] or route.health()!=state['protected_health']:
            raise RuntimeError('K67_REHEARSAL_PROTECTED_STATE_CHANGED')
    if state['stage'] in {'rolled_back_verified','rolled_back_after_error'}:
        primary()
        if verify_app(u,client,state,image,environment):raise RuntimeError('K67_REHEARSAL_STOPPED_RUNTIME_RESTARTED')
        if state.get('operation_error'):raise RuntimeError('K67_REHEARSAL_FORWARD_FAILED_RECOVERED')
        return {'outcome':'success','stage':state['stage'],'reused':True,'new_data_preserved':True,'learner_cutover':True}
    if 'baseline' not in state:
        if route.read(sftp,route.INCLUDE)!=before:raise RuntimeError('K67_REHEARSAL_INITIAL_ROUTE_CHANGED')
        state['baseline']=observe(base,'k67-20261006',image['revision'],fake)
        state['protected_files']=route.protected_files(sftp);state['protected_health']=route.health();h.atomic(STATE,state)
    if state['stage'] not in ROLLBACK_STAGES:
        try:
            state['stage']='forward_exchange_intent';h.atomic(STATE,state)
            legacy.exchange(u,client,sftp,route,prepare,c,state,'rehearsal-forward',route.INCLUDE,before,after)
            u.remote(client,['nginx','-t']);state['stage']='forward_reload_intent';h.atomic(STATE,state)
            u.remote(client,['nginx','-s','reload'])
            if observe(base,environment['K67_APP_VERSION'],image['revision'],fake)!=state['baseline']:
                raise RuntimeError('K67_REHEARSAL_NEW_RUNTIME_RESULT_CHANGED')
            state['forward_verified']=True
        except Exception as error:
            state['operation_error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        state['stage']='rollback_exchange_intent';h.atomic(STATE,state)
    try:
        if state['stage'] not in {'standby_stop_intent','rolled_back_verified','rolled_back_after_error'}:
            actual=route.read(sftp,route.INCLUDE)
            if actual==after:
                legacy.exchange(u,client,sftp,route,prepare,c,state,'rehearsal-rollback',route.INCLUDE,after,before)
            elif actual!=before:raise RuntimeError('K67_REHEARSAL_ROLLBACK_FOREIGN_ROUTE')
            u.remote(client,['nginx','-t']);state['stage']='rollback_reload_intent';h.atomic(STATE,state)
            u.remote(client,['nginx','-s','reload'])
        primary()
        state['stage']='standby_stop_intent';h.atomic(STATE,state)
        if verify_app(u,client,state,image,environment):
            try:u.remote(client,['docker','stop',APP])
            except Exception:
                if verify_app(u,client,state,image,environment):raise
                state['stop_ack_reconciled']=True
        if verify_app(u,client,state,image,environment):raise RuntimeError('K67_REHEARSAL_RUNTIME_NOT_STOPPED')
        primary()
        state['stage']='rolled_back_after_error' if state.get('operation_error') else 'rolled_back_verified'
        h.atomic(STATE,state)
    except Exception as error:
        state['recovery_error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        h.atomic(STATE,state);raise
    if state.get('operation_error'):raise RuntimeError('K67_REHEARSAL_FORWARD_FAILED_RECOVERED')
    return {'outcome':'success','stage':state['stage'],'runtime_forward_verified':state['forward_verified'],
      'new_data_preserved':True,'same_source_image':True,'protected_routes':state['protected_health'],
      'shared_files_unchanged':True,'learner_cutover':True}

def perform(u,h,s,db,app,route,opening,legacy,c,prepare,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    state=json.loads(STATE.read_bytes()) if STATE.exists() else {'intent':uuid.uuid4().hex,'stage':'intent'}
    # Mất tiến trình sau forward: ưu tiên trả tuyến chính, không dựng/forward lần nữa.
    if state['stage'] in {'forward_exchange_intent','forward_reload_intent'}:
        state['operation_error']='K67_REHEARSAL_FORWARD_INTERRUPTED'
        state['stage']='rollback_exchange_intent';h.atomic(STATE,state)
    recovering=state['stage'] in ROLLBACK_STAGES
    fake=json.loads((PRIVATE.parent/'production-journeys/state.json').read_bytes())
    if fake['stage']!='verified':raise RuntimeError('K67_REHEARSAL_SIMULATION_NOT_VERIFIED')
    if not recovering and db.query(u,client,"SELECT to_jsonb(count(*)) FROM assessment.term_test_writing_grading_job WHERE status IN ('queued','retry_wait','processing')"):
        raise RuntimeError('K67_REHEARSAL_JOB_STILL_ACTIVE')
    image=json.loads((PRIVATE.parent/'production-image/state.json').read_bytes())
    h.atomic(STATE,state)
    environment=app.environment(u,h,db,client,image)
    environment['K67_APP_VERSION']='k67-20261006-release-rehearsal'
    # Credential không vào journal/source: chỉ env600 và bộ nhớ, cùng role của runtime K67.
    envbytes=('\n'.join(k+'='+v for k,v in environment.items())+'\n').encode()
    sftp=client.open_sftp()
    try:s.owned_directory_files(sftp,REMOTE,{'identity.json':(json.dumps({'product':'PRODUCT-TERM-MINI-K67','intent':state['intent']},sort_keys=True).encode(),0o600),'runtime.env':(envbytes,0o600)})
    finally:sftp.close()
    names=u.remote(client,['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    if APP not in names and not recovering:
        if u.remote(client,['ss','-H','-ltn','sport = :'+PORT]).strip():raise RuntimeError('K67_REHEARSAL_PORT_COLLISION')
        state['stage']='container_create_intent';h.atomic(STATE,state)
        u.remote(client,['docker','run','--detach','--name',APP,'--label','com.izone.product=PRODUCT-TERM-MINI-K67',
          '--label','com.izone.purpose=release-rehearsal','--label','com.izone.intent='+state['intent'],
          '--network','n8n-net','--cpus','0.5','--memory','256m','--pids-limit','100','--read-only',
          '--security-opt','no-new-privileges','--cap-drop','ALL','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
          '--publish','127.0.0.1:'+PORT+':8796','--mount','type=bind,src=/opt/term-mini-k67/assets,dst=/private-assets,readonly',
          '--env-file',REMOTE+'/runtime.env',image['image'],'node','src/server.js'])
    if not recovering:
        running=verify_app(u,client,state,image,environment)
        if not running:raise RuntimeError('K67_REHEARSAL_RUNTIME_STOPPED_UNKNOWN')
        for attempt in range(15):
            try:
                ready=json.loads(u.remote(client,['curl','--silent','--show-error','--fail','--max-time','3','http://127.0.0.1:'+PORT+'/ready']))
                if ready=={'ok':True,'build':{'version':environment['K67_APP_VERSION'],'sha':image['revision']}}:break
            except RuntimeError:pass
            time.sleep(0.5)
        else:raise RuntimeError('K67_REHEARSAL_PRIVATE_RUNTIME_NOT_READY')
    context=json.loads(route.STATE.read_bytes())
    before=opening.config(route,context['intent']);after=before.replace(b'proxy_pass http://127.0.0.1:8796/;',b'proxy_pass http://127.0.0.1:8799/;')
    if before==after or before.count(b'proxy_pass http://127.0.0.1:8796/;')!=1:raise RuntimeError('K67_REHEARSAL_ROUTE_SCOPE_CHANGED')
    sftp=client.open_sftp()
    try:
        return rehearse_route(u,h,route,legacy,prepare,c,client,sftp,state,image,environment,fake,before,after)
    finally:sftp.close()

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py');s=load('guard','prepare-context-source.py')
    db=load('production_db','prepare-production-database.py');app=load('production_app','prepare-production-app.py');route=load('public_route','prepare-k67-route.py')
    opening=load('opening','open-production-api-route.py');legacy=load('legacy','apply-legacy-cutover.py');c=load('cutover','nginx-cutover.py','ops');prepare=load('legacy_prepare','prepare-legacy-cutover.py')
    lock=load('grading_lock','prepare-grading-fixture.py');PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(route.PRIVATE/'operation.lock'):
        client=u.connect()
        try:return s.run_guarded(u,h,client,lambda:perform(u,h,s,db,app,route,opening,legacy,c,prepare,client),PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
