"""Tạm giữ hoặc chuyển đúng tuyến K67 trên vhost443 đã kiểm.

Nhận candidate bất biến; giữ inode cũ ngoài mọi wildcard Nginx, kiểm nguồn
trước/sau exchange. Unknown giữ file và không reload. Không sửa tuyến K56.
HOLD chưa chuyển dữ liệu; RELEASE chỉ được phép khi bản sao đã đối soát.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import re
import sys
import time
import requests

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/legacy-routing')
STATE=PRIVATE/'state.json'
VHOST='/etc/nginx/sites-enabled/ducizone.conf'

def load(name,file,base='tools'):
    spec=importlib.util.spec_from_file_location(name,ROOT/base/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

EXCHANGE='''# Kiểm module đã ghim, giữ inode trước; unknown không reload.
import hashlib,importlib.util,json,sys
r=json.load(sys.stdin)
raw=open(r['module'],'rb').read()
if hashlib.sha256(raw).hexdigest()!=r['module_sha']:raise RuntimeError('K67_EXCHANGE_MODULE_CHANGED')
s=importlib.util.spec_from_file_location('cutover',r['module']);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
try:
 target=c.read_regular(r['target']);staged=c.read_regular(r['staged'])
 if c.sha(target)==r['after'] and c.sha(staged)==r['before']:
  result={'reconciled':True,'before_sha256':r['before'],'after_sha256':r['after'],'captured_path':r['staged']}
 elif c.sha(target)==r['before'] and c.sha(staged)==r['after']:
  result=c.guarded_exchange(r['target'],r['staged'],r['before'],r['after'])
 else:raise RuntimeError('K67_EXCHANGE_PRESENT_STATE_UNKNOWN')
 print(json.dumps({'outcome':'success',**result}))
except Exception as e:print(json.dumps({'outcome':'unknown','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__}))
'''

def immutable_remote(sftp,route,path,raw,mode=0o600):
    current=route.optional(sftp,path)
    if current is None:
        with sftp.open(path,'wx') as stream:stream.write(raw)
        sftp.chmod(path,mode)
    elif current!=raw:raise RuntimeError('K67_ROUTE_CANDIDATE_CHANGED')
    if route.read(sftp,path)!=raw:raise RuntimeError('K67_ROUTE_CANDIDATE_READBACK_UNKNOWN')

def exchange(u,client,sftp,route,prepare,c,state,phase,target,before,after):
    staged='/etc/nginx/.k67-'+state['intent']+'-'+phase+'.staged'
    actual=route.read(sftp,target);saved=route.optional(sftp,staged)
    if actual==after and saved==before:return {'reconciled':True,'captured_path':staged}
    if actual!=before or saved not in [None,after]:raise RuntimeError('K67_ROUTE_EXCHANGE_SOURCE_UNKNOWN')
    immutable_remote(sftp,route,staged,after)
    payload={'module':prepare.REMOTE+'/nginx-cutover.py','module_sha':c.sha((ROOT/'ops/nginx-cutover.py').read_bytes()),
      'target':target,'staged':staged,'before':c.sha(before),'after':c.sha(after)}
    result=json.loads(u.remote(client,['python3','-c',EXCHANGE],json.dumps(payload).encode()))
    if result['outcome']!='success':raise RuntimeError(result['code'])
    if route.read(sftp,target)!=after or route.read(sftp,staged)!=before:raise RuntimeError('K67_ROUTE_EXCHANGE_READBACK_UNKNOWN')
    return result

def apply(u,h,route,prepare,c,source,client,phase):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    original=json.loads(prepare.STATE.read_bytes())
    if original['stage']!='prepared_not_applied' or not re.fullmatch('[a-f0-9]{32}',original['intent']):
        raise RuntimeError('K67_ROUTE_PREPARATION_UNKNOWN')
    files={name:(prepare.PRIVATE/name).read_bytes() for name in original['hashes']}
    if {name:c.sha(raw) for name,raw in files.items()}!=original['hashes']:raise RuntimeError('K67_ROUTE_LOCAL_CANDIDATE_CHANGED')
    if STATE.exists():state=json.loads(STATE.read_bytes())
    else:
        state={'intent':original['intent'],'stage':'intent'};h.atomic(STATE,state)
    if state['intent']!=original['intent']:raise RuntimeError('K67_ROUTE_INTENT_CHANGED')
    if phase=='release':
        copy=json.loads((PRIVATE.parent/'production-migration/state.json').read_bytes())
        if copy['stage']!='restored_verified':raise RuntimeError('K67_ROUTE_FINAL_COPY_NOT_VERIFIED')
        fence=load('source_fence','source-fence.py','ops')
        status=source.query(u,client,fence.inspect_query())
        migration=load('migration','rehearse-migration.py')
        fence.verify(status,migration.TABLES,copy['intent'])
        final=load('final_migration','production-migration.py');db=load('production_db','prepare-production-database.py')
        doc,stream=final.document(copy,final.migration_module())
        dbstate=json.loads(db.STATE.read_bytes());db.verify_container(u,client,dbstate);db.verify_schema(u,client,dbstate)
        qualified={'intent':copy['intent'],'snapshot_sha256':copy['snapshot_json_sha256'],
          'target':db.DATABASE,'container':db.PG,'db_marker':dbstate['schema']['marker']}
        inspection=client.open_sftp()
        try:
            released_exact=route.optional(inspection,c.INCLUDE)==files['routes-active.conf'] and \
              route.optional(inspection,'/etc/nginx/.k67-'+state['intent']+'-release.staged')==files['routes-hold.conf']
        finally:inspection.close()
        # Sau khi exchange đã xảy ra, bài mới có thể được ghi: đối soát mất ACK bằng
        # bằng chứng trước exchange + exact hai inode, không ép hash dữ liệu mới bằng dump cũ.
        if not released_exact or state.get('release_copy_verified')!=qualified:
            final.verify_copy(u,client,db,source,fence)
            state['release_copy_verified']=qualified;h.atomic(STATE,state)
    sftp=client.open_sftp()
    try:
        protected=route.protected_files(sftp);before_health=route.health()
        if route.read(sftp,'/etc/nginx/conf.d/term-mini-k67-legacy-secret.conf')!=files['mini-compatibility.private.conf']:
            raise RuntimeError('K67_ROUTE_COMPATIBILITY_MAP_CHANGED')
        desired=files['routes-hold.conf'] if phase=='hold' else files['routes-active.conf']
        previous=route.optional(sftp,c.INCLUDE)
        if phase=='hold':
            if previous is None:immutable_remote(sftp,route,c.INCLUDE,desired)
            elif previous!=desired:raise RuntimeError('K67_ROUTE_HOLD_STATE_UNKNOWN')
            state['stage']='hold_exchange_intent';h.atomic(STATE,state)
            proof=exchange(u,client,sftp,route,prepare,c,state,'vhost',VHOST,
              files['vhost-before.private.conf'],files['vhost-with-include.private.conf'])
        else:
            if route.read(sftp,VHOST)!=files['vhost-with-include.private.conf']:raise RuntimeError('K67_ROUTE_VHOST_CHANGED')
            state['stage']='release_exchange_intent';h.atomic(STATE,state)
            proof=exchange(u,client,sftp,route,prepare,c,state,'release',c.INCLUDE,files['routes-hold.conf'],desired)
        # Lỗi syntax giữ file và HOLD; không tự trả nguồn khi dữ liệu đã chuyển.
        u.remote(client,['nginx','-t']);state['stage']=phase+'_reload_intent';h.atomic(STATE,state)
        u.remote(client,['nginx','-s','reload'])
        checks={}
        expected=503 if phase=='hold' else 401
        for path in ['/mapping-api/api/term-tests/writing-grading/jobs/claim','/mapping-api/api/mini-tests/results']:
            for attempt in range(10):
                response=requests.post(route.HOST+path,json={},timeout=15,allow_redirects=False)
                if response.status_code==expected:break
                time.sleep(0.5)
            if response.status_code!=expected:raise RuntimeError('K67_LEGACY_ROUTE_HTTP_READBACK_UNKNOWN')
            checks[path]=response.status_code
        if phase=='release':
            response=requests.get(route.HOST+'/mapping-api/api/term-tests/teacher/tests',timeout=15,allow_redirects=False)
            if response.status_code!=409 or response.json().get('error')!='K67_BACKEND_MOVED':
                raise RuntimeError('K67_LEGACY_TEACHER_RELOAD_NOT_OBSERVED')
        if route.read(sftp,VHOST)!=files['vhost-with-include.private.conf'] or route.read(sftp,c.INCLUDE)!=desired:
            raise RuntimeError('K67_ROUTE_POST_RELOAD_FILE_UNKNOWN')
        after=route.protected_files(sftp)
        if {k:v for k,v in protected.items() if k!=VHOST}!={k:v for k,v in after.items() if k!=VHOST} \
          or route.health()!=before_health:raise RuntimeError('K67_ROUTE_PROTECTED_STATE_CHANGED')
        state['stage']='holding' if phase=='hold' else 'released';state[phase+'_proof']=proof;state['checks']=checks;h.atomic(STATE,state)
        return {'outcome':'success','stage':state['stage'],'checks':checks,'protected_routes':before_health,
          'other_protected_files_unchanged':True,'learner_cutover':phase=='release'}
    finally:sftp.close()

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('phase',choices=['hold','release']);args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    route=load('public_route','prepare-k67-route.py');prepare=load('legacy_prepare','prepare-legacy-cutover.py')
    c=load('cutover','nginx-cutover.py','ops');source=load('guard','prepare-context-source.py')
    lock=load('grading_lock','prepare-grading-fixture.py');PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:return source.run_guarded(u,h,client,lambda:apply(u,h,route,prepare,c,source,client,args.phase),PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
