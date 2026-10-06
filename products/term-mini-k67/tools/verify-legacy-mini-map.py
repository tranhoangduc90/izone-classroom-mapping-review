"""Kiểm Nginx đổi khóa Mini tại listener localhost tạm, không ghi kết quả thi.

Nhận exact key cũ từ container và key K67 từ vault; chỉ gửi body rỗng nên API
đúng khóa trả400 trước SQL, sai khóa trả401. File map riêng600; probe dừng sau
kiểm, artifact giữ lại. Không sửa vhost443 hoặc tuyến Mini đang phục vụ.
"""
from pathlib import Path
import importlib.util
import json
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/legacy-mini-map')
STATE=PRIVATE/'state.json'
MAP='/etc/nginx/conf.d/term-mini-k67-legacy-secret.conf'
PROBE='/etc/nginx/conf.d/term-mini-k67-compatibility-probe.conf'

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def install(sftp,route,path,raw,mode):
    actual=route.optional(sftp,path)
    if actual is None:
        with sftp.open(path,'wx') as stream:stream.write(raw)
        sftp.chmod(path,mode)
    elif actual!=raw:raise RuntimeError('K67_MINI_MAP_FILE_COLLISION')
    if route.read(sftp,path)!=raw or sftp.lstat(path).st_mode&0o777!=mode:raise RuntimeError('K67_MINI_MAP_FILE_READBACK_FAILED')

def stop(u,route,sftp,client,desired):
    actual=route.optional(sftp,PROBE)
    disabled=route.optional(sftp,PROBE+'.disabled')
    if actual is not None:
        if actual!=desired or disabled is not None:raise RuntimeError('K67_MINI_PROBE_ROLLBACK_OWNERSHIP_UNKNOWN')
        sftp.rename(PROBE,PROBE+'.disabled')
        u.remote(client,['nginx','-t']);u.remote(client,['nginx','-s','reload'])
    elif disabled!=desired:raise RuntimeError('K67_MINI_PROBE_UNKNOWN')

def verify(u,h,legacy,route,client):
    PRIVATE.mkdir(parents=True,exist_ok=True);prepared=json.loads(legacy.STATE.read_bytes())
    if prepared['stage']!='prepared_not_applied':raise RuntimeError('K67_LEGACY_NOT_PREPARED')
    state=json.loads(STATE.read_bytes()) if STATE.exists() else {'intent':prepared['intent'],'stage':'intent'}
    if state['intent']!=prepared['intent']:raise RuntimeError('K67_MINI_MAP_INTENT_CHANGED')
    h.atomic(STATE,state)
    desired_map=(legacy.PRIVATE/'mini-compatibility.private.conf').read_bytes()
    if route.sha(desired_map)!=prepared['hashes']['mini-compatibility.private.conf']:raise RuntimeError('K67_MINI_MAP_CANDIDATE_CHANGED')
    desired=('# PRODUCT-TERM-MINI-K67 localhost key probe; intent '+state['intent']+'\n'
      'server {\n listen 127.0.0.1:18870;\n server_name localhost;\n'
      ' location = /api/mini-tests/results {\n'
      '  proxy_set_header x-mini-test-sync $k67_legacy_mini_key;\n'
      '  proxy_connect_timeout 3s; proxy_read_timeout 10s;\n'
      '  proxy_pass http://127.0.0.1:8796/api/mini-tests/results;\n'
      ' }\n location / { return 404; }\n}\n').encode()
    sftp=client.open_sftp();protected=route.protected_files(sftp);health=route.health()
    try:
        install(sftp,route,MAP,desired_map,0o600)
        if state['stage']=='verified_probe_stopped':
            if route.optional(sftp,PROBE) is not None or route.read(sftp,PROBE+'.disabled')!=desired:
                raise RuntimeError('K67_MINI_MAP_COMPLETED_STATE_CHANGED')
            return {'outcome':'success','stage':state['stage'],'checks':state['checks'],'reused':True,'learner_cutover':False}
        if route.optional(sftp,PROBE) is None:
            if u.remote(client,['ss','-H','-ltn','sport = :18870']).strip():raise RuntimeError('K67_MINI_PROBE_PORT_COLLISION')
            disabled=route.optional(sftp,PROBE+'.disabled')
            if disabled is not None:
                if disabled!=desired:raise RuntimeError('K67_MINI_PROBE_DISABLED_CHANGED')
                sftp.rename(PROBE+'.disabled',PROBE)
            else:install(sftp,route,PROBE,desired,0o644)
        elif route.read(sftp,PROBE)!=desired:raise RuntimeError('K67_MINI_PROBE_CHANGED')
        state['stage']='reload_intent';h.atomic(STATE,state)
        try:
            u.remote(client,['nginx','-t']);u.remote(client,['nginx','-s','reload'])
            source=json.loads(u.remote(client,['docker','inspect','mapping-review-api']))[0]
            env=dict(row.split('=',1) for row in source['Config']['Env'] if '=' in row);old=env['MINI_TEST_SYNC_SECRET']
            changed=old.swapcase()
            if changed==old:raise RuntimeError('K67_MINI_KEY_HAS_NO_CASE_TEST')
            checks={}
            for label,key,expected in [('exact_old',old,400),('case_changed',changed,401),('wrong','x'*48,401),('empty','',401)]:
                config=('header = "Content-Type: application/json"\nheader = "x-mini-test-sync: '+key+'"\ndata = "{}"\n').encode()
                code=u.remote(client,['curl','--silent','--show-error','--max-time','10','--retry','3','--retry-connrefused',
                  '--output','/dev/null','--write-out','%{http_code}','--request','POST','http://127.0.0.1:18870/api/mini-tests/results','--config','-'],config).decode()
                if code!=str(expected):raise RuntimeError('K67_MINI_KEY_PROBE_'+label.upper()+'_HTTP_'+code)
                checks[label]=int(code)
            if route.protected_files(sftp)!=protected or route.health()!=health:raise RuntimeError('K67_MINI_PROBE_SHARED_STATE_CHANGED')
        finally:stop(u,route,sftp,client,desired)
        state['stage']='verified_probe_stopped';state['checks']=checks;h.atomic(STATE,state)
        return {'outcome':'success','stage':state['stage'],'checks':checks,'map_mode':'0600','shared_vhost_changed':False,
          'probe_stopped':True,'learner_cutover':False}
    finally:sftp.close()

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    legacy=load('legacy_prepare','prepare-legacy-cutover.py');route=load('context_route','prepare-k67-route.py')
    guard=load('context_guard','prepare-context-source.py');lock=load('grading_lock','prepare-grading-fixture.py')
    PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(legacy.PRIVATE/'operation.lock'):
        client=u.connect()
        try:return guard.run_guarded(u,h,client,lambda:verify(u,h,legacy,route,client),PRIVATE,caller_path=Path(__file__))
        finally:client.close()
if __name__=='__main__':sys.exit(main())
