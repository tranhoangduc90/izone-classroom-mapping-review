"""Kho tiến độ chấm K67 riêng trước cutover, không dùng kho diễn tập.

Sinh khóa riêng trong DPAPI, tạo volume/container mới có intent và hạn mức;
chỉ cho role K67 truy cập namespaceK67. Ca kiểm dùng một khóa giả hết hạn,
không đọc/sửa Redis chung hoặc chấm bài.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import re
import secrets
import sys
import time
import uuid
import win32crypt

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-queue')
STATE=PRIVATE/'state.json';VAULT=PRIVATE/'credentials.dpapi'
APP='term-mini-k67-redis';VOLUME=APP+'-data';REMOTE='/opt/'+APP
PRODUCT='PRODUCT-TERM-MINI-K67'


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def keys():return json.loads(win32crypt.CryptUnprotectData(VAULT.read_bytes(),None,None,None,0)[1])


def cli(u,client,command,password=None,anonymous=False):
    if anonymous:return u.remote(client,['docker','exec','-i',APP,'redis-cli','--raw'],command+'\n',include_stderr=True).decode().strip()
    script='IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli --user k67_grading --no-auth-warning --raw'
    return u.remote(client,['docker','exec','-i',APP,'sh','-c',script],
        (password or keys()['password'])+'\n'+command+'\n',include_stderr=True).decode().strip()


def labels(state):return {'com.izone.product':PRODUCT,'com.izone.purpose':'production-queue-v1','com.izone.intent':state['intent']}


def verify(u,client,state):
    row=json.loads(u.remote(client,['docker','inspect',APP]))[0]
    volume=json.loads(u.remote(client,['docker','volume','inspect',VOLUME]))[0];host=row['HostConfig']
    if row['Image']!=u.IMAGE or not row['State']['Running'] \
        or any(row['Config'].get('Labels',{}).get(k)!=v or volume.get('Labels',{}).get(k)!=v for k,v in labels(state).items()) \
        or host['NanoCpus']!=250000000 or host['Memory']!=134217728 or host['MemorySwap']!=134217728 \
        or host['PidsLimit']!=64 or not host['ReadonlyRootfs'] or host['NetworkMode']!='n8n-net' or host['PortBindings'] \
        or row['Config']['Cmd']!=['redis-server','/usr/local/etc/redis/redis.conf']:
        raise RuntimeError('K67_QUEUE_CONTAINER_MISMATCH')
    mounts={x['Destination']:(x['Type'],x.get('Name'),x['Source'],x['RW']) for x in row['Mounts']}
    if set(mounts)!={'/data','/usr/local/etc/redis/redis.conf'} \
        or mounts['/data'][:2]!=('volume',VOLUME) or not mounts['/data'][3] \
        or mounts['/usr/local/etc/redis/redis.conf']!=('bind',None,REMOTE+'/redis.conf',False):
        raise RuntimeError('K67_QUEUE_MOUNT_MISMATCH')


def prepare(u,h,guard,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    names=u.remote(client,['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    volumes=u.remote(client,['docker','volume','ls','--format','{{.Name}}']).decode().splitlines()
    if STATE.exists():
        state=json.loads(STATE.read_text(encoding='utf-8'))
        if not re.fullmatch('[0-9a-f]{32}',state['intent']):raise RuntimeError('K67_QUEUE_STATE_CHANGED')
    else:
        if APP in names or VOLUME in volumes or VAULT.exists():raise RuntimeError('K67_QUEUE_NAME_COLLISION')
        state={'intent':uuid.uuid4().hex,'stage':'intent'};h.atomic(STATE,state)
    if not VAULT.exists():
        value={'intent':state['intent'],'container':APP,'user':'k67_grading','password':secrets.token_urlsafe(48)}
        with VAULT.open('xb') as stream:stream.write(win32crypt.CryptProtectData(json.dumps(value).encode(),'K67 queue',None,None,None,0))
    secret=keys()
    if secret.get('intent')!=state['intent'] or secret.get('container')!=APP or secret.get('user')!='k67_grading' \
        or not re.fullmatch('[A-Za-z0-9_-]{48,96}',secret.get('password','')):
        raise RuntimeError('K67_QUEUE_VAULT_MISMATCH')
    sftp=client.open_sftp()
    try:
        marker=json.dumps({'intent':state['intent'],'product':PRODUCT},sort_keys=True).encode()
        guard.owned_directory_files(sftp,REMOTE,{'identity.json':(marker,0o600),'redis.conf':(u.config(secret['password']),0o644)})
    finally:sftp.close()
    if VOLUME not in volumes:
        argv=['docker','volume','create']
        for k,v in labels(state).items():argv+=['--label',k+'='+v]
        state['stage']='volume_create_intent';h.atomic(STATE,state);u.remote(client,[*argv,VOLUME])
    volume=json.loads(u.remote(client,['docker','volume','inspect',VOLUME]))[0]
    if any(volume.get('Labels',{}).get(k)!=v for k,v in labels(state).items()):raise RuntimeError('K67_QUEUE_VOLUME_COLLISION')
    if APP not in names:
        argv=['docker','run','--detach','--name',APP]
        for k,v in labels(state).items():argv+=['--label',k+'='+v]
        state['stage']='container_create_intent';h.atomic(STATE,state)
        u.remote(client,[*argv,'--network','n8n-net','--cpus','0.25','--memory','128m','--memory-swap','128m',
            '--pids-limit','64','--read-only','--tmpfs','/tmp:rw,size=8m,mode=1777',
            '--mount','type=volume,src='+VOLUME+',dst=/data',
            '--mount','type=bind,src='+REMOTE+'/redis.conf,dst=/usr/local/etc/redis/redis.conf,readonly',
            '--restart','unless-stopped',u.IMAGE,'redis-server','/usr/local/etc/redis/redis.conf'])
    verify(u,client,state);deadline=time.monotonic()+20
    while True:
        try:
            if cli(u,client,'PING')=='PONG':break
        except RuntimeError:pass
        if time.monotonic()>deadline:raise RuntimeError('K67_QUEUE_READY_TIMEOUT')
        time.sleep(1)
    key='termmini:k67:synthetic:boundary:'+uuid.uuid4().hex
    if cli(u,client,'SET '+key+' synthetic-progress EX 60')!='OK' or cli(u,client,'GET '+key)!='synthetic-progress' \
        or cli(u,client,'TYPE '+key)!='string' or cli(u,client,'EXPIRE '+key+' 30')!='1' \
        or cli(u,client,'DEL '+key)!='1' or cli(u,client,'GET '+key)!='':raise RuntimeError('K67_QUEUE_ROUNDTRIP_FAILED')
    for command in ['GET termtest:writing:direct:synthetic','CONFIG GET *','FLUSHALL']:
        if 'NOPERM' not in cli(u,client,command):raise RuntimeError('K67_QUEUE_SCOPE_NOT_RESTRICTED')
    if 'NOAUTH' not in cli(u,client,'PING',anonymous=True) or 'WRONGPASS' not in cli(u,client,'PING',password='wrong-synthetic'):
        raise RuntimeError('K67_QUEUE_AUTH_NOT_RESTRICTED')
    service=h.vault(Path('E:/Codex-Data/k67-backend-separation-20261006/grading-provision/service-keys.dpapi'))
    if service.get('product_id')!=PRODUCT or not re.fullmatch('[A-Za-z0-9_-]{48,96}',service.get('grading_sync','')):
        raise RuntimeError('K67_QUEUE_SERVICE_VAULT_MISMATCH')
    value=cli(u,client,'GET termmini:k67:sync_secret')
    if value not in ['',service['grading_sync']]:raise RuntimeError('K67_QUEUE_SERVICE_KEY_COLLISION')
    if not value:cli(u,client,'SET termmini:k67:sync_secret '+service['grading_sync']+' NX')
    if cli(u,client,'GET termmini:k67:sync_secret')!=service['grading_sync']:raise RuntimeError('K67_QUEUE_SERVICE_KEY_READBACK')
    state['stage']='production_queue_verified';h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'container':APP,'volume':VOLUME,
        'own_namespace':True,'foreign_denied':True,'admin_denied':True,'auth_required':True,'learner_cutover':False}


def main():
    argparse.ArgumentParser(description=__doc__).parse_args();sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    guard=load('context_guard','prepare-context-source.py');client=u.connect()
    try:return guard.run_guarded(u,h,client,lambda:prepare(u,h,guard,client),PRIVATE,caller_path=Path(__file__))
    finally:client.close()


if __name__=='__main__':sys.exit(main())
