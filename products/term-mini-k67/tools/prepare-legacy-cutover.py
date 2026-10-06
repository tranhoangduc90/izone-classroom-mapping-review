"""Chuẩn bị exact route/khóa tương thích K67 và kiểm trao đổi file giả trên VPS.

Nguồn Nginx/credential chỉ đọc. Artifact có khóa chỉ ở kho riêng tư; kiểm
renameat2 dùng file giả trong thư mục task mới, không sửa cấu hình cổng thật.
Không tạm khóa bài thi, chuyển tuyến, bật workflow hoặc publish giao diện.
"""
from pathlib import Path
import importlib.util
import json
import re
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/legacy-cutover-v2')
STATE=PRIVATE/'state.json'
REMOTE='/opt/term-mini-k67-cutover-v3'

def load(name,file,base='tools'):
    spec=importlib.util.spec_from_file_location(name,ROOT/base/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

NATIVE='''# Kiểm trao đổi file giả và stale-before; giữ mọi file để đọc lại.
import importlib.util,json,pathlib,sys,uuid
base=pathlib.Path('/opt/term-mini-k67-cutover-v3')
spec=importlib.util.spec_from_file_location('cutover',base/'nginx-cutover.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
case=base/('exchange-test-'+uuid.uuid4().hex);case.mkdir(mode=0o700)
def file(name,raw):
 p=case/name;p.write_bytes(raw);p.chmod(0o600);return p
before=b'configuration-original';desired=b'configuration-k67';foreign=b'configuration-other-task'
left=file('normal-left',before);right=file('normal-right',desired)
c.guarded_exchange(left,right,c.sha(before),c.sha(desired))
assert left.read_bytes()==desired and right.read_bytes()==before
left=file('stale-left',foreign);right=file('stale-right',desired)
try:c.guarded_exchange(left,right,c.sha(before),c.sha(desired))
except RuntimeError as error:assert str(error)=='K67_NGINX_PREVIOUS_CHANGED_RESTORED'
else:raise RuntimeError('STALE_WRITE_ACCEPTED')
assert left.read_bytes()==foreign and right.read_bytes()==desired
left=file('concurrent-left',before);right=file('concurrent-right',desired)
original=c.exchange_files
def concurrent(a,b):
 original(a,b);pathlib.Path(a).write_bytes(foreign)
c.exchange_files=concurrent
try:c.guarded_exchange(left,right,c.sha(before),c.sha(desired))
except RuntimeError as error:assert str(error)=='K67_NGINX_CURRENT_CHANGED_PRESERVED_UNKNOWN'
else:raise RuntimeError('CONCURRENT_WRITE_ACCEPTED')
assert left.read_bytes()==foreign and right.read_bytes()==before
left=file('rollback-race-left',foreign);right=file('rollback-race-right',desired)
foreign2=b'configuration-third-task';calls=0
def rollback_race(a,b):
 global calls
 calls+=1
 if calls==2:pathlib.Path(a).write_bytes(foreign2)
 original(a,b)
c.exchange_files=rollback_race
try:c.guarded_exchange(left,right,c.sha(before),c.sha(desired))
except RuntimeError as error:assert str(error)=='K67_NGINX_CONCURRENT_ROLLBACK_PRESERVED_UNKNOWN'
else:raise RuntimeError('ROLLBACK_RACE_ACCEPTED')
assert left.read_bytes()==foreign and right.read_bytes()==foreign2
print(json.dumps({'outcome':'success','cases':4,'normal_preserved':True,'stale_restored':True,'concurrent_preserved_unknown':True,'rollback_race_preserved_unknown':True,'artifacts':str(case)}))
'''

def immutable(path,raw):
    if path.exists():
        if path.read_bytes()!=raw:raise RuntimeError('K67_LEGACY_CANDIDATE_CHANGED')
    else:
        with path.open('xb') as stream:stream.write(raw)

def prepare(u,h,guard,route,c,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    if STATE.exists():state=json.loads(STATE.read_bytes())
    else:
        state={'intent':uuid.uuid4().hex,'stage':'intent'};h.atomic(STATE,state)
    if not re.fullmatch('[a-f0-9]{32}',state['intent']):raise RuntimeError('K67_LEGACY_STATE_CHANGED')
    sftp=client.open_sftp()
    try:before=route.read(sftp,'/etc/nginx/sites-enabled/ducizone.conf')
    finally:sftp.close()
    after=c.add_include(before)
    source=json.loads(u.remote(client,['docker','inspect','mapping-review-api']))[0]
    environment=dict(row.split('=',1) for row in source['Config']['Env'] if '=' in row)
    old=environment.get('MINI_TEST_SYNC_SECRET','')
    service=h.vault(PRIVATE.parent/'grading-provision/service-keys.dpapi')
    map_bytes=c.legacy_map(state['intent'],old,service['mini_sync'])
    artifacts={'vhost-before.private.conf':before,'vhost-with-include.private.conf':after,
      'mini-compatibility.private.conf':map_bytes,'routes-hold.conf':c.legacy_routes(state['intent'],True),
      'routes-active.conf':c.legacy_routes(state['intent'],False)}
    for name,raw in artifacts.items():immutable(PRIVATE/name,raw)
    hashes={name:c.sha(raw) for name,raw in artifacts.items()}
    if state.get('hashes',hashes)!=hashes:raise RuntimeError('K67_LEGACY_PREPARED_SOURCE_CHANGED')
    state['hashes']=hashes;h.atomic(STATE,state)
    ops=(ROOT/'ops/nginx-cutover.py').read_bytes()
    files={'identity.json':(json.dumps({'product':'PRODUCT-TERM-MINI-K67','intent':state['intent']},sort_keys=True).encode(),0o600),
      'nginx-cutover.py':(ops,0o600),'verify-exchange.py':(NATIVE.encode(),0o600)}
    sftp=client.open_sftp()
    try:
        if state.get('native_remote')==REMOTE and state.get('stage')=='prepared_not_applied':
            artifact=state['native']['artifacts']
            if not artifact.startswith(REMOTE+'/exchange-test-') or not re.fullmatch('exchange-test-[a-f0-9]{32}',artifact.split('/')[-1]):
                raise RuntimeError('K67_LEGACY_NATIVE_ARTIFACT_PATH_CHANGED')
            if set(sftp.listdir(REMOTE))!=set(files)|{artifact.split('/')[-1]}:raise RuntimeError('K67_LEGACY_REMOTE_FOREIGN_FILE')
            for name,(raw,mode) in files.items():
                with sftp.open(REMOTE+'/'+name,'rb') as stream:actual=stream.read()
                if actual!=raw or sftp.lstat(REMOTE+'/'+name).st_mode&0o777!=mode:raise RuntimeError('K67_LEGACY_REMOTE_FILE_CHANGED')
            return {'outcome':'success','stage':state['stage'],'source_read_only':True,'native':state['native'],
              'native_reused':True,'shared_vhost_changed':False,'learner_cutover':False}
        guard.owned_directory_files(sftp,REMOTE,files)
    finally:sftp.close()
    native=json.loads(u.remote(client,['python3',REMOTE+'/verify-exchange.py']))
    if native.get('outcome')!='success' or native.get('cases')!=4:raise RuntimeError('K67_LEGACY_NATIVE_EXCHANGE_FAILED')
    state['stage']='prepared_not_applied';state['native']=native;state['native_remote']=REMOTE;h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'source_read_only':True,'native':native,
      'shared_vhost_changed':False,'learner_cutover':False}

def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    guard=load('context_guard','prepare-context-source.py');route=load('context_route','prepare-k67-route.py')
    c=load('nginx_cutover','nginx-cutover.py',base='ops');lock=load('grading_lock','prepare-grading-fixture.py')
    PRIVATE.mkdir(parents=True,exist_ok=True)
    with lock.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:return guard.run_guarded(u,h,client,lambda:prepare(u,h,guard,route,c,client),PRIVATE,with_catalog=True,caller_path=Path(__file__))
        finally:client.close()
if __name__=='__main__':sys.exit(main())
