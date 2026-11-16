"""Install one native K56 journal lane and roll back by changing its own policy."""
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from types import FunctionType
import copy
import fcntl
import json
import os
import runpy
import stat
import sys
import time

ROOT = Path('/opt/izone-k56-term1-journal-261116')
HELPER = '/opt/izone-mini-k56-recovery-20261112/operator.py'
API = 'izone-k56-ic2264-api'
OLD = API + '-before-term1-journal-261116'
NEW = API + '-term1-journal-candidate-261116'
BASE = '4f54c36218d35cdcdcedc546b6fd7504880f45e6'
CONTAINER = '1252da5cb6def7d315913d80dca23742891554a5147a2e9e2ef4c80cde488185'
APP = '/app/src/app.js'
DIR = '/run/k56-term1-journal-pilot'
MODULES = '/app/src/term1-journal-cloud'
MIGRATION = 'enrollment.sql'
SOURCE = {'src/app.js', 'src/term1-journal-cloud/mount.mjs', 'src/term1-journal-cloud/k67-pilot-ticket.mjs'}
POLICY = ROOT / 'policy' / 'config.json'
TERM1_POLICY = POLICY
TERM = 1
OPEN = '2026-11-16T18:00:00'
PRODUCT = '/app/src/exam-journal-runtime/src/product.mjs'


def configure_term2():
    global ROOT, OLD, NEW, BASE, CONTAINER, DIR, SOURCE, POLICY, TERM, OPEN
    ROOT = Path('/opt/izone-k56-term2-journal-261116')
    OLD = API + '-before-term2-journal-261116'
    NEW = API + '-term2-journal-candidate-261116'
    BASE = '249ca17ddc2414f9e69413729d95978e0d1bb2a3'
    CONTAINER = json.loads((ROOT/'manifest.json').read_text())['container']
    DIR = '/run/k56-term2-journal-pilot'
    SOURCE = SOURCE | {PRODUCT.removeprefix('/app/')}
    POLICY = ROOT / 'policy' / 'config.json'
    TERM = 2
    OPEN = '2026-11-16T18:15:00'


def digest(data):
    return sha256(data).hexdigest()


def when(value):
    return int(datetime.fromisoformat(value+'+07:00').timestamp()*1000)


def write_policy(enabled, path=None):
    path = path or POLICY
    policy = json.loads(path.read_text()) if path.is_file() else dict(opensAt=when(OPEN),
                 closesAt=when('2026-11-17T00:00:00'), renewUntil=when('2026-11-24T00:00:00'))
    policy['enabled'] = enabled
    pending = path.with_name('.config.next')
    with pending.open('x') as handle:
        json.dump(policy, handle)
        handle.write('\n')
        os.fchown(handle.fileno(), 0, 1000)
        os.fchmod(handle.fileno(), 0o640)
        handle.flush()
        os.fsync(handle.fileno())
    pending.replace(path)
    return policy


def route_check(policy, term):
    source = """
const target='http://127.0.0.1:'+(process.env.PORT||'8788')+'/api/term-tests/term-test-__TERM__-k56';
const options={method:'POST',headers:{Origin:'https://tranhoangduc90.github.io','Content-Type':'application/json'},
  body:'{}',signal:AbortSignal.timeout(3000)};
const results=await Promise.all([target+'/journal-pilot-context',target+'/listening/report',
  target+'/journal-collector-sealed'].map(async url=>{
  const response=await fetch(url,options);
  return {status:response.status,body:await response.json()};
}));
console.log(JSON.stringify(results));""".replace('__TERM__',str(term))
    row = json.loads(cmd('docker','exec','-i',API,'node','--input-type=module','-',data=source.encode(),timeout=10))
    decision = row[0]
    now = time.time() * 1000
    expected = (200, {'ok':True, 'destination':'collector-v1', 'reason':'pilot_disabled'})
    if policy['enabled']:
        in_window = policy['opensAt'] <= now < policy['closesAt'] < policy['renewUntil']
        expected = (401, {'ok':False, 'error':'JOURNAL_OWNER_DENIED'}) if in_window else (
            200, {'ok':True, 'destination':'collector-v1', 'reason':'outside_pilot_window'})
    must((decision['status'],decision['body'])==expected,'K56_JOURNAL_CONTEXT_CHANGED')
    must(row[1]['status'] == 400 and row[1]['body'].get('error') == 'LISTENING_REPORT_INVALID', 'K56_LISTENING_REPORT_CHANGED')
    must(row[2]['status'] == 409 and row[2]['body'].get('error') == 'PILOT_BATCH_HASH_MISMATCH', 'K56_SEALED_COLLECTOR_CHANGED')
    return {'journalStatus':decision['status'],'journal':decision['body'],'listeningReport':row[1]['status'],
            'sealedCollector':row[2]['status']}


def both_routes():
    routes = {f'term{TERM}':route_check(json.loads(POLICY.read_text()),TERM)}
    if TERM == 2:
        routes['term1'] = route_check(json.loads(TERM1_POLICY.read_text()),1)
    return routes


def preflight():
    manifest = json.loads((ROOT/'manifest.json').read_text())
    old = switch.inspect(API)
    must(old['Id']==CONTAINER and old['State']['Running'] and env_of(old)['BUILD_SHA']==BASE, 'K56_JOURNAL_BASE_CHANGED')
    must(old['Config']['User']=='node', 'K56_JOURNAL_RUNTIME_USER_CHANGED')
    must(set(manifest['files'])==SOURCE | {MIGRATION}, 'K56_JOURNAL_SOURCE_SET_CHANGED')
    must(all(digest((ROOT/name).read_bytes())==value for name,value in manifest['files'].items()), 'K56_JOURNAL_HASH_CHANGED')
    live_paths={('/app/'+name):value for name,value in manifest['live'].items()}
    must(ops['h']['fingerprints'](API,list(live_paths))==live_paths, 'K56_JOURNAL_SOURCE_DRIFT')
    if TERM == 2:
        must(manifest['base']==BASE and set(manifest['live'])==SOURCE,'K56_TERM2_BASE_FINGERPRINTS_CHANGED')
        route_check(json.loads(TERM1_POLICY.read_text()),1)
    must(json.loads(POLICY.read_text())['enabled'] is False, 'K56_JOURNAL_POLICY_MUST_BE_OFF')
    key = ROOT/'policy'/'append.key'
    must(key.stat().st_mode & 0o777==0o440 and key.stat().st_gid==1000 and key.stat().st_uid==0, 'K56_JOURNAL_KEY_MODE')
    for source in SOURCE:
        cmd('docker','exec','-i',API,'node','--input-type=module','--check',data=(ROOT/source).read_bytes(),timeout=10)
    command, sql = ops['private_db'](old)
    ops['check_idle'](sql)
    ops['rpc']()
    targets={APP:ROOT/'src/app.js',MODULES:ROOT/'src/term1-journal-cloud',DIR:ROOT/'policy'}
    if TERM == 2:
        targets[PRODUCT] = ROOT/PRODUCT.removeprefix('/app/')
    delta={'BUILD_SHA':manifest['release'],f'K56_TERM{TERM}_JOURNAL_POLICY_FILE':DIR+'/config.json',
           f'K56_TERM{TERM}_JOURNAL_APPEND_KEY_FILE':DIR+'/append.key'}
    old_for_compose=copy.deepcopy(old)
    binds=old_for_compose['HostConfig'].get('Binds') or []
    for target in targets:
        if not any(target==bind.split(':',2)[1] for bind in binds):
            mounts = [row for row in old['Mounts'] if row['Destination']==target]
            if mounts:
                mount, = mounts
                must(not mount['RW'] and mount['Type']=='bind','K56_JOURNAL_REPLACED_MOUNT_UNEXPECTED')
                binds.append(f"{mount['Source']}:{target}:ro")
    old_for_compose['HostConfig']['Binds']=binds
    preserve=ops['persistent']
    persist=FunctionType(preserve.__code__,{**preserve.__globals__,'ROOT':ROOT})
    compose=persist(old_for_compose,targets,delta)
    clone=copy.deepcopy(old)
    for endpoint in clone['NetworkSettings']['Networks'].values():
        endpoint['IPAMConfig']=None
    payload,expected,addresses=ops['container_spec'](clone,targets,delta)
    return manifest,old,command,sql,targets,compose,payload,expected,addresses


def activate(manifest,old,command,sql,targets,compose,payload,expected,addresses):
    config,before,after=compose
    must(config.read_bytes()==before, 'K56_JOURNAL_COMPOSE_DRIFT')
    stamp=ops['mini']['data_digest'](sql)
    dump=command('pg_dump','--format=custom','--schema=assessment_k56','--lock-wait-timeout=4s')
    listing=cmd('docker','exec','-i','mapping-postgres','pg_restore','--list',data=dump,timeout=35)
    must(dump.startswith(b'PGDMP') and 'term_test_attempt' in listing, 'K56_JOURNAL_BACKUP_FAILED')
    atomic(ROOT/'database-before.private.dump',dump)
    atomic(ROOT/'compose-before.private.yml',before)
    sql((ROOT/MIGRATION).read_text())
    must(ops['scalar'](sql,"SELECT bool_and(has_table_privilege('k56_shared_api', "
         f"'assessment_k56.journal_term{TERM}_cloud_enrollment',needed)) FROM unnest(ARRAY['INSERT','SELECT']) need(needed)")=='t',
         'K56_JOURNAL_GRANT_MISSING')
    must(ops['mini']['data_digest'](sql)==stamp, 'K56_JOURNAL_BUSINESS_DATA_DRIFT')
    names=set(cmd('docker','ps','-a','--format','{{.Names}}').splitlines())
    must(not {OLD,NEW}&names, 'K56_JOURNAL_CONTAINER_EXISTS')
    pending=switch.engine('POST','/v1.48/containers/create?name='+NEW,payload,(201,))['Id']
    switch.compare_mounts(expected,switch.inspect(pending),targets)
    ops['check_idle'](sql)
    must(switch.inspect(API)['Id']==old['Id'], 'K56_JOURNAL_NATIVE_CHANGED')
    started=time.monotonic()
    try:
        cmd('docker','stop','--time','10',old['Id'])
        cmd('docker','rename',old['Id'],OLD)
        cmd('docker','rename',pending,API)
        cmd('docker','start',pending)
        ops['ready'](manifest['release'])
        current=switch.inspect(API)
        must(current['Id']==pending and addresses=={key:value['IPAddress'] for key,value in current['NetworkSettings']['Networks'].items()},
             'K56_JOURNAL_NETWORK_CHANGED')
        switch.compare_mounts(expected,current,targets)
        verified={'/app/'+key:manifest['files'][key] for key in SOURCE}
        must(ops['h']['fingerprints'](API,list(verified))==verified, 'K56_JOURNAL_LIVE_HASH_CHANGED')
        ops['rpc']()
        routes=both_routes()
        must(config.read_bytes()==before, 'K56_JOURNAL_COMPOSE_CHANGED')
        atomic(config,after,stat.S_IMODE(config.stat().st_mode))
    except Exception:
        if switch.state(pending):
            cmd('docker','stop','--time','10',pending)
        if switch.inspect(pending)['Name']=='/'+API:
            cmd('docker','rename',pending,NEW)
        if switch.inspect(old['Id'])['Name']!='/'+API:
            cmd('docker','rename',old['Id'],API)
        if not switch.state(old['Id']):
            cmd('docker','start',old['Id'])
        if config.read_bytes()==after:
            atomic(config,before,stat.S_IMODE(config.stat().st_mode))
        ops['ready'](BASE)
        raise
    receipt=dict(build=manifest['release'],live=pending,previous=old['Id'],routes=routes,
                 backupSha=digest(dump),elapsedMs=round((time.monotonic()-started)*1000))
    atomic(ROOT/'receipt.json',json.dumps(receipt).encode())
    print(json.dumps(receipt),flush=True)


if __name__=='__main__':
    os.umask(0o077)
    if sys.argv[2:] == ['--term2']:
        configure_term2()
    elif len(sys.argv)!=2:
        raise RuntimeError('K56_JOURNAL_MODE_REQUIRED')
    if os.geteuid()!=0 or Path.cwd()!=ROOT:
        raise RuntimeError('K56_JOURNAL_DIRECTORY_INVALID')
    mode=sys.argv[1]
    ops=runpy.run_path(HELPER)
    cmd,must,switch,env_of,atomic=(ops[key] for key in ('cmd','must','switch','env_of','atomic'))
    with (ROOT/'switch.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if mode=='init-policy':
            must(not POLICY.exists(),'K56_JOURNAL_POLICY_EXISTS')
            write_policy(False)
        elif mode in ('enable','disable','check','disable-term1'):
            live=json.loads((ROOT/'receipt.json').read_text())['live']
            must(switch.inspect(API)['Id']==live,'K56_JOURNAL_LIVE_CHANGED')
            if mode=='check':
                print(json.dumps(both_routes()),flush=True)
            elif mode=='disable-term1':
                must(TERM==2,'K56_TERM2_OPERATOR_REQUIRED')
                write_policy(False,TERM1_POLICY)
                print(json.dumps(both_routes()),flush=True)
            else:
                enabled=mode=='enable'
                config=write_policy(enabled)
                try:
                    routes=both_routes()
                except Exception:
                    if enabled:
                        write_policy(False)
                    raise
                print(json.dumps({'scope':'all-verified-classes','policy':config,'routes':routes}),flush=True)
        else:
            must(mode in ('preflight','apply'),'K56_JOURNAL_MODE_REQUIRED')
            state=preflight()
            if mode=='apply':
                activate(*state)
            else:
                print(f'K56_TERM{TERM}_JOURNAL_PREFLIGHT_PASSED',flush=True)
