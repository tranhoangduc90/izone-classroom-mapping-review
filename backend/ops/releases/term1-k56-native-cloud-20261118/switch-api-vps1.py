"""Verify the loopback K56 native logging candidate and switch its HTTPS proxy."""
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
from runpy import run_path
import subprocess
import sys
import tempfile
import time

ROOT=Path('/opt/izone-term1-k56-native-cloud-20261118')
OLD='a8c8911c72b28fb92757cc9cf071cff73be1ed215045ba54a45903e36a8212aa'
OLD_BUILD='c9ca22fe93b135b5abd473a0f85ab8efb7296d71'
stage=json.loads((ROOT/'stage-api.json').read_bytes())
NEW=stage['newApi']
BUILD=stage['build']
HOST='ducizone.ddns.net'
PUBLIC='https://'+HOST+'/mapping-api-k56'
PREVIOUS='http://127.0.0.1:19807'
TARGET='http://127.0.0.1:19808'
NGINX=Path('/etc/nginx/snippets/izone-k56-route.conf')
ORIGIN='https://tranhoangduc90.github.io'

def run(*args,timeout=15):
    return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=timeout)

def inspect(name):
    return json.loads(run('docker','inspect',name))[0]

def get(base,path,payload=None,origin=ORIGIN):
    options=['--resolve',HOST+':443:127.0.0.1'] if base==PUBLIC else []
    if payload is not None:
        options+=['-H','Content-Type: application/json','-H','Origin: '+origin,'--data',json.dumps(payload)]
    output=run('curl','-sS','--noproxy','*','--max-time','6','--write-out','\n%{http_code}',*options,base+path)
    body,_,status=output.rpartition(b'\n')
    return int(status),body

def build(base):
    status,body=get(base,'/health')
    value=json.loads(body)
    assert status==200 and value['ok'] is True
    return value['build']['sha']

def idle():
    ops=run_path('/opt/izone-mini-k56-recovery-20261112/operator.py')
    live=ops['switch'].inspect(OLD)
    _,sql=ops['private_db'](live)
    ops['check_idle'](sql)

def verify(base):
    assert build(base)==BUILD
    for slug in ['term-test-1-k56','term-test-2-k56','mini-test-k56']:
        path='/api/term-tests/'+slug+'/journal-pilot-context'
        assert get(base,path,{})==get(PREVIOUS,path,{}),path
        assert get(base,path,{},origin='https://unauthorized.invalid')[0]==get(PREVIOUS,path,{},origin='https://unauthorized.invalid')[0]
    old=inspect(OLD);new=inspect(NEW)
    env=lambda c:dict(row.split('=',1) for row in c['Config']['Env'])
    expected=env(old)|{'BUILD_SHA':BUILD,'K56_TERM1_NATIVE_ROUTE_FILE':'/run/k56-term1-native-cloud/route.json',
      'K56_TERM1_NATIVE_SPOOL_KEY_FILE':'/run/k56-term1-native-cloud/producer.key',
      'K56_TERM1_NATIVE_SPOOL_ENDPOINT':'https://ducizone.ddns.net/exam-journal-20261024/producer-spool/term-mini-k56-term1-cbt-cloud'}
    assert env(new)==expected and new['Image']==old['Image'] and new['Config']['Cmd']==old['Config']['Cmd']
    for name in ['k56-exam-order.js','term1-skill-offline-core.mjs','term1-parallel-entry.mjs','term2-parallel-entry.mjs']:
        assert run('docker','exec',NEW,'sha256sum','/app/src/'+name).split()[0]==run('docker','exec',OLD,'sha256sum','/app/src/'+name).split()[0]
    assert run('docker','exec',NEW,'sha256sum','/app/src/exam-journal-runtime/adapters/term-k56-offline.mjs').split()[0]==b'f7c1aadc3c89a0c481d851fae1dfa0c65b6c87277e52329b8e30aaae6ed5e35f'
    manifest=json.loads((ROOT/'api-overlay-manifest.json').read_bytes())
    for file,sha in manifest['files'].items():
        assert run('docker','exec',NEW,'sha256sum','/app/src/exam-journal-runtime/'+file).decode().split()[0]==sha

def save(name,value):
    record={'at':datetime.now(timezone.utc).isoformat(),'build':BUILD,**value}
    with (ROOT/name).open('x') as stream:
        json.dump(record,stream,indent=2)
    print(json.dumps(record))

def replace(data,metadata):
    with tempfile.NamedTemporaryFile(dir=NGINX.parent,prefix='.k56-native-',delete=False) as stream:
        temporary=Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(),metadata.st_mode&0o777)
            os.fchown(stream.fileno(),metadata.st_uid,metadata.st_gid)
            os.replace(temporary,NGINX)
        finally:
            temporary.unlink(missing_ok=True)

def start():
    assert inspect(OLD)['State']['Running'] and build(PUBLIC)==OLD_BUILD
    candidate=inspect(NEW)
    assert candidate['State']['Status']=='created' or (candidate['State']['Status']=='exited'
        and candidate['State']['ExitCode']==1 and candidate['HostConfig']['RestartPolicy']['Name']=='no')
    assert json.loads((ROOT/'policy/route.json').read_bytes())['mode']=='collector'
    idle()
    from urllib.parse import urlsplit,unquote
    service_user=unquote(urlsplit(dict(row.split('=',1) for row in inspect(NEW)['Config']['Env'])['DATABASE_URL']).username)
    assert service_user.replace('_','').isalnum()
    ops=run_path('/opt/izone-mini-k56-recovery-20261112/operator.py');_,sql=ops['private_db'](inspect(NEW))
    for table in ['term1_offline_run','term1_offline_operation','term_test_attempt','term_test_exam_session']:
        assert ops['scalar'](sql,"SELECT has_table_privilege('"+service_user+"','assessment_k56."+table+"','SELECT')")== 't',table
    run('docker','start',NEW)
    for _ in range(20):
        assert inspect(NEW)['State']['Running']
        try:
            if build(TARGET)==BUILD:
                break
        except subprocess.SubprocessError:
            pass
        time.sleep(.5)
    verify(TARGET)
    output=subprocess.check_output(['docker','logs','--since','2m',NEW],stderr=subprocess.STDOUT,timeout=12)
    assert b'TERM1_K56_NATIVE_SPOOL_CONFIG_INVALID' not in output
    save('API_LOOPBACK.json',{'phase':'loopback_verified','candidateId':NEW,'policy':'collector'})

def apply():
    assert (ROOT/'API_LOOPBACK.json').exists() and not (ROOT/'API_PROXY.json').exists()
    assert build(PUBLIC)==build(PREVIOUS)==OLD_BUILD
    verify(TARGET)
    idle()
    original=NGINX.read_bytes()
    assert original.count(PREVIOUS.encode())==3 and TARGET.encode() not in original
    metadata=NGINX.stat()
    with (ROOT/'izone-k56-route.before-native.conf').open('xb') as backup:
        backup.write(original)
    try:
        assert NGINX.read_bytes()==original
        replace(original.replace(PREVIOUS.encode(),TARGET.encode()),metadata)
        run('nginx','-t')
        run('systemctl','reload','nginx')
        for _ in range(15):
            if build(PUBLIC)==BUILD:
                break
            time.sleep(.5)
        verify(PUBLIC)
        run('docker','update','--restart','unless-stopped',NEW)
    except BaseException:
        replace(original,metadata)
        run('nginx','-t')
        run('systemctl','reload','nginx')
        assert build(PUBLIC)==OLD_BUILD
        raise
    save('API_PROXY.json',{'phase':'switched','oldApi':OLD,'newApi':NEW,'oldBuild':OLD_BUILD,'policy':'collector'})

assert stage['oldApi']==OLD and ROOT.resolve()==ROOT
with (ROOT/'api-switch.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    mode,=sys.argv[1:]
    assert mode in ('start','apply')
    start() if mode=='start' else apply()
