"""VPS1 scoped K56 release; preserve all serving overlays and native journal flags.

Run inspect, stage, migrate, switch separately. Rollback restores the proxy only;
the additive compatible schema is retained so accepted answers are never undone.
"""
from datetime import datetime, timezone
from hashlib import sha256
import fcntl
import json
import os
from pathlib import Path
from runpy import run_path
import subprocess
import sys
import tempfile
import time

ROOT=Path('/opt/izone-mini-k56-cbt-parallel-entry-20261118')
OLD='586c4dda2899adb47138b977333bcb5adb8799513de7529e1e5e23c11dd7d2e0'
OLD_BUILD='a97761314ebd14d7b29b5c351c6f8f0402be339d'
NEW_NAME='izone-mini-k56-cbt-parallel-entry-20261118'
HOST='ducizone.ddns.net'
PUBLIC='https://'+HOST+'/mapping-api-k56'
PREVIOUS='http://127.0.0.1:19808'
TARGET='http://127.0.0.1:19809'
NGINX=Path('/etc/nginx/snippets/izone-k56-route.conf')
FILES=('k56-exam-order.js','mini-k56-recovery-core.mjs','mini-offline.mjs','mini-cbt-parallel-entry.mjs','exam-journal-runtime/adapters/term-k56-offline.mjs')

def run(*args,timeout=15):
    return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=timeout)

def inspect(name):
    return json.loads(run('docker','inspect',name))[0]

def env(container):
    return dict(row.split('=',1) for row in container['Config']['Env'])

def get(base,path,payload=None,origin='https://tranhoangduc90.github.io'):
    options=['--resolve',HOST+':443:127.0.0.1'] if base==PUBLIC else []
    if payload is not None:
        options+=['-H','Content-Type: application/json','-H','Origin: '+origin,'--data',json.dumps(payload)]
    output=run('curl','-sS','--noproxy','*','--max-time','6','--write-out','\n%{http_code}',*options,base+path)
    body,_,status=output.rpartition(b'\n')
    return int(status),body

def build(base):
    status,body=get(base,'/health');value=json.loads(body)
    assert status==200 and value['ok'] is True
    return value['build']['sha']

def save(name,value):
    value={'at':datetime.now(timezone.utc).isoformat(),**value}
    target=ROOT/name
    if target.exists():target=ROOT/(target.stem+'-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+target.suffix)
    value['recordFile']=target.name
    with target.open('x') as stream:json.dump(value,stream,indent=2)
    print(json.dumps(value),flush=True)

def mounted(container):
    return {m['Destination']:(m['Source'],m['RW']) for m in container['Mounts']}

def check_old():
    old=inspect(OLD)
    assert old['State']['Running'] and build(PREVIOUS)==OLD_BUILD
    assert env(old)['BUILD_SHA']==OLD_BUILD
    for name,item in manifest['files'].items():
        if item['preimage'] is None:
            assert subprocess.run(['docker','exec',OLD,'test','!','-e','/app/src/'+name],timeout=10).returncode==0,name
        else:
            assert run('docker','exec',OLD,'sha256sum','/app/src/'+name).decode().split()[0]==item['preimage'],name
    return old

ops=run_path('/opt/izone-mini-k56-recovery-20261112/operator.py')
_,sql=ops['private_db'](inspect(OLD))
scalar=lambda query:ops['scalar'](sql,query)

def fingerprint():
    return json.loads(scalar("""SELECT json_build_object(
      'attempts',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(
        md5((to_jsonb(a)-'mini_cbt_parallel_entry'-'mini_cbt_official_submission')::text),'' ORDER BY id),'')))
        FROM assessment_k56.term_test_attempt a),
      'sessions',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(
        md5((to_jsonb(s)-'mini_cbt_parallel_entry')::text),'' ORDER BY id),'')))
        FROM assessment_k56.term_test_exam_session s))"""))

def preflight():
    check_old();assert build(PUBLIC)==OLD_BUILD
    ops['check_idle'](sql)
    assert NGINX.read_text().count(PREVIOUS)==3 and TARGET not in NGINX.read_text()
    print(json.dumps({'phase':'preflight','oldBuild':OLD_BUILD,'payloads':fingerprint()}),flush=True)

def capacity():
    from urllib.parse import urlsplit,unquote
    role=unquote(urlsplit(env(inspect(OLD))['DATABASE_URL']).username)
    assert role.replace('_','').isalnum()
    stats=json.loads(scalar("SELECT json_build_object('max',current_setting('max_connections')::int,'total',(SELECT count(*) FROM pg_stat_activity),'roleLimit',(SELECT rolconnlimit FROM pg_roles WHERE rolname='"+role+"'),'roleConnections',(SELECT count(*) FROM pg_stat_activity WHERE usename='"+role+"'))"))
    assert stats['total']+10<=stats['max']-3,stats
    assert stats['roleLimit']<0 or stats['roleConnections']+10<=stats['roleLimit'],stats
    return stats

def stage():
    preflight();old=check_old();capacity()
    assert not run('ss','-H','-ltn','sport = :19809').strip()
    assert NEW_NAME not in run('docker','ps','-a','--format','{{.Names}}').decode().splitlines()
    helper=run_path('/opt/term-mini-k67/releases/20261112-submit-compat/rehearse-k67-docker-switch-20261112.py')
    engine=helper['engine'];engine.__globals__['SOCKET']=Path('/var/run/docker.sock')
    old['HostConfig'].setdefault('Mounts',[])
    overlays={'/app/src/'+name:str(ROOT/'src'/name) for name in FILES}
    payload=helper['clone_payload'](old,overlays)
    assert payload['HostConfig']['PortBindings']['8788/tcp']==[{'HostIp':'127.0.0.1','HostPort':'19808'}]
    payload['HostConfig']['PortBindings']['8788/tcp'][0]['HostPort']='19809'
    payload['HostConfig']['RestartPolicy']={'Name':'no','MaximumRetryCount':0}
    expected=env(old)|{'BUILD_SHA':BUILD,'K56_MINI_CBT_PARALLEL_ENTRY_MODE':'on'}
    payload['Env']=[key+'='+value for key,value in expected.items()]
    result=engine('POST','/v1.48/containers/create?name='+NEW_NAME,payload,(201,))
    new=inspect(result['Id'])
    assert new['State']['Status']=='created' and new['Image']==old['Image']
    assert env(new)==expected and new['Config']['Cmd']==old['Config']['Cmd']
    assert mounted(new)==mounted(old)|{target:(source,False) for target,source in overlays.items()}
    run('docker','start',new['Id'])
    for _ in range(20):
        assert inspect(new['Id'])['State']['Running']
        try:
            if build(TARGET)==BUILD:break
        except subprocess.SubprocessError:pass
        time.sleep(.5)
    verify(TARGET)
    save('STAGED.json',{'phase':'loopback_verified','newApi':new['Id'],'build':BUILD,'oldApi':OLD,'oldBuild':OLD_BUILD})

def verify(base,mode='on',name=NEW_NAME):
    assert build(base)==BUILD
    new=inspect(name)
    assert env(new)==env(check_old())|{'BUILD_SHA':BUILD,'K56_MINI_CBT_PARALLEL_ENTRY_MODE':mode}
    for name,item in manifest['files'].items():
        assert run('docker','exec',new['Id'],'sha256sum','/app/src/'+name).decode().split()[0]==item['sha256'],name
    for slug in ['term-test-1-k56','term-test-2-k56','mini-test-k56']:
        path='/api/term-tests/'+slug+'/journal-pilot-context'
        assert get(base,path,{})==get(PREVIOUS,path,{}),path
        assert get(base,path,{},origin='https://unauthorized.invalid')[0]==get(PREVIOUS,path,{},origin='https://unauthorized.invalid')[0]

def migrate():
    assert (ROOT/'STAGED.json').is_file() and not (ROOT/'MIGRATED.json').exists()
    preflight();verify(TARGET)
    assert int(scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='assessment_k56' AND column_name IN ('mini_cbt_parallel_entry','mini_cbt_official_submission')"))==0
    before=fingerprint()
    indexes=json.loads(scalar("SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname='assessment_k56' AND indexname IN ('uq_term_test_exam_session_one_active_student','uq_term_test_attempt_one_active_student')"))
    assert len(indexes)==2 and all('term2_parallel_entry' in item and 'term1_parallel_entry' in item for item in indexes)
    with (ROOT/'indexes.before.sql').open('x') as output:output.write(';\n'.join(indexes)+';\n')
    ops['check_idle'](sql)
    migration=(ROOT/'migration.sql').read_text().replace('assessment.','assessment_k56.')
    assert migration.startswith('BEGIN;') and migration.rstrip().endswith('COMMIT;')
    # Read and compare both tables while the migration transaction holds its locks.
    expected=json.dumps(before,separators=(',',':'))
    check="""DO $check$ DECLARE actual jsonb; BEGIN
      SELECT jsonb_build_object(
        'attempts',(SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5((to_jsonb(a)-'mini_cbt_parallel_entry'-'mini_cbt_official_submission')::text),'' ORDER BY id),''))) FROM assessment_k56.term_test_attempt a),
        'sessions',(SELECT jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5((to_jsonb(s)-'mini_cbt_parallel_entry')::text),'' ORDER BY id),''))) FROM assessment_k56.term_test_exam_session s)) INTO actual;
      IF actual <> '%s'::jsonb THEN RAISE EXCEPTION 'K56_PAYLOAD_CHANGED'; END IF;
    END $check$;
    """%expected
    output=sql(migration.replace('BEGIN;','BEGIN; SET LOCAL statement_timeout=30000;',1).replace('COMMIT;',check+'COMMIT;')).decode()
    assert 'COMMIT' in output
    after=fingerprint();assert after==before
    assert int(scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='assessment_k56' AND column_name IN ('mini_cbt_parallel_entry','mini_cbt_official_submission')"))==3
    save('MIGRATED.json',{'phase':'migrated','payloadsBefore':before,'payloadsAfter':after,'historicalPayloadsUnchanged':True})

def replace(data,metadata):
    with tempfile.NamedTemporaryFile(dir=NGINX.parent,prefix='.k56-first-valid-',delete=False) as stream:
        temporary=Path(stream.name)
        try:
            stream.write(data);stream.flush();os.fsync(stream.fileno())
            os.fchmod(stream.fileno(),metadata.st_mode&0o777);os.fchown(stream.fileno(),metadata.st_uid,metadata.st_gid)
            os.replace(temporary,NGINX)
        finally:temporary.unlink(missing_ok=True)

def switch():
    assert (ROOT/'MIGRATED.json').is_file() and not (ROOT/'SWITCHED.json').exists()
    preflight();verify(TARGET)
    original=NGINX.read_bytes();metadata=NGINX.stat()
    with (ROOT/'nginx.before.conf').open('xb') as output:output.write(original)
    try:
        assert NGINX.read_bytes()==original
        replace(original.replace(PREVIOUS.encode(),TARGET.encode()),metadata)
        run('nginx','-t');run('systemctl','reload','nginx')
        for _ in range(15):
            if build(PUBLIC)==BUILD:break
            time.sleep(.5)
        verify(PUBLIC)
        run('docker','update','--restart','unless-stopped',NEW_NAME)
    except BaseException:
        replace(original,metadata);run('nginx','-t');run('systemctl','reload','nginx')
        assert build(PUBLIC)==OLD_BUILD
        raise
    save('SWITCHED.json',{'phase':'switched','oldApi':OLD,'newApi':inspect(NEW_NAME)['Id'],'build':BUILD,'databaseCorrectionRetainedOnRollback':True})

def rollback():
    assert (ROOT/'SWITCHED.json').exists() and build(PUBLIC)==BUILD
    ops['check_idle'](sql)
    assert int(scalar('SELECT count(*) FROM assessment_k56.term_test_attempt WHERE mini_cbt_parallel_entry'))==0,'Issued Mini scopes require drain with the compatible code, not the old proxy'
    original=(ROOT/'nginx.before.conf').read_bytes()
    assert NGINX.read_bytes()==original.replace(PREVIOUS.encode(),TARGET.encode())
    replace(original,NGINX.stat());run('nginx','-t');run('systemctl','reload','nginx')
    assert build(PUBLIC)==OLD_BUILD
    save('ROLLED_BACK.json',{'phase':'api_proxy_rolled_back','databaseCorrectionRetained':True})


def drain():
    assert (ROOT/'SWITCHED.json').exists()
    assert build(PUBLIC)==BUILD
    name=NEW_NAME+'-drain';target='http://127.0.0.1:19810'
    capacity();old=inspect(NEW_NAME)
    expected=env(old)|{'K56_MINI_CBT_PARALLEL_ENTRY_MODE':'drain'}
    if name in run('docker','ps','-a','--format','{{.Names}}').decode().splitlines():
        new=inspect(name)
        assert new['Image']==old['Image'] and mounted(new)==mounted(old) and env(new)==expected
        assert new['HostConfig']['PortBindings']['8788/tcp']==[{'HostIp':'127.0.0.1','HostPort':'19810'}]
    else:
        assert not run('ss','-H','-ltn','sport = :19810').strip()
        helper=run_path('/opt/term-mini-k67/releases/20261112-submit-compat/rehearse-k67-docker-switch-20261112.py')
        engine=helper['engine'];engine.__globals__['SOCKET']=Path('/var/run/docker.sock')
        old['HostConfig'].setdefault('Mounts',[])
        payload=helper['clone_payload'](old,{})
        assert payload['HostConfig']['PortBindings']['8788/tcp']==[{'HostIp':'127.0.0.1','HostPort':'19809'}]
        payload['HostConfig']['PortBindings']['8788/tcp'][0]['HostPort']='19810'
        payload['HostConfig']['RestartPolicy']={'Name':'no','MaximumRetryCount':0}
        payload['Env']=[key+'='+value for key,value in expected.items()]
        result=engine('POST','/v1.48/containers/create?name='+name,payload,(201,))
        new=inspect(result['Id']);assert mounted(new)==mounted(old) and env(new)==expected
    if not new['State']['Running']:run('docker','start',new['Id'])
    for _ in range(20):
        assert inspect(new['Id'])['State']['Running']
        try:
            if build(target)==BUILD:break
        except subprocess.SubprocessError:pass
        time.sleep(.5)
    verify(target,'drain',name)
    original=NGINX.read_bytes();metadata=NGINX.stat()
    assert original==(ROOT/'nginx.before.conf').read_bytes().replace(PREVIOUS.encode(),TARGET.encode())
    try:
        replace(original.replace(TARGET.encode(),target.encode()),metadata)
        run('nginx','-t');run('systemctl','reload','nginx');verify(PUBLIC,'drain',name)
        run('docker','update','--restart','unless-stopped',name)
    except BaseException:
        replace(original,metadata);run('nginx','-t');run('systemctl','reload','nginx')
        raise
    save('DRAINED.json',{'phase':'new_admission_drained','api':new['Id'],'build':BUILD,'issuedScopesRetained':True})

def resume():
    assert (ROOT/'DRAINED.json').exists()
    target='http://127.0.0.1:19810';name=NEW_NAME+'-drain'
    verify(PUBLIC,'drain',name);verify(TARGET)
    original=NGINX.read_bytes();metadata=NGINX.stat()
    assert original==(ROOT/'nginx.before.conf').read_bytes().replace(PREVIOUS.encode(),target.encode())
    try:
        replace(original.replace(target.encode(),TARGET.encode()),metadata)
        run('nginx','-t');run('systemctl','reload','nginx');verify(PUBLIC)
    except BaseException:
        replace(original,metadata);run('nginx','-t');run('systemctl','reload','nginx')
        raise
    save('RESUMED.json',{'phase':'compatible_on_after_drain','api':inspect(NEW_NAME)['Id'],'build':BUILD,'schemaAndReceiptsRetained':True})

assert os.geteuid()==0 and ROOT.is_dir() and not ROOT.is_symlink()
manifest=json.loads((ROOT/'manifest.json').read_bytes());assert set(manifest['files'])==set(FILES)
for name,item in manifest['files'].items():assert sha256((ROOT/'src'/name).read_bytes()).hexdigest()==item['sha256']
assert sha256((ROOT/'migration.sql').read_bytes()).hexdigest()==manifest['migrationSha256']
BUILD=manifest['build']
assert len(BUILD)==40 and BUILD==sha256(json.dumps(manifest['files'],sort_keys=True).encode()).hexdigest()[:40]
mode,=sys.argv[1:];assert mode in ('inspect','stage','migrate','switch','rollback','drain','resume')
with (ROOT/'release.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    {'inspect':preflight,'stage':stage,'migrate':migrate,'switch':switch,'rollback':rollback,'drain':drain,'resume':resume}[mode]()
