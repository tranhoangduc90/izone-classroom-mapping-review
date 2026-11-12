"""Mini-only K56 release and drain, with the existing K56 Compose owner preserved."""
import copy
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import time

ROOT = Path('/opt/izone-mini-k56-recovery-20261112')
API = 'izone-k56-ic2264-api'
OLD = API + '-before-mini-recovery-20261112'
NEW = API + '-mini-recovery-candidate-20261112'
OLD_BUILD = '69f92e2657384ad9a70b1f54b808c2682ce420ac'
HELP = Path('/opt/term-mini-k67/releases/20261112-submit-compat/apply-k67-phase1-20261112.py')
SCOPE = ROOT/'scope'/'config.json'
SCOPE_TARGET = '/run/mini-k56-submission-recovery'
TARGETS = {
  'app.js','sql.js','mini-offline.mjs','mini-k56-recovery-core.mjs','k56-submission-recovery.mjs',
  'term1-submission-hold.mjs','term-test-writing-grading.js',
  'exam-journal-runtime/adapters/term.mjs','exam-journal-runtime/adapters/term-k56-offline.mjs'
}
LEGACY = Path('/opt/izone-mini-k56-offline-20261107')
sys.path.insert(0,str(LEGACY))
mini = runpy.run_path(str(LEGACY/'operator.py'))
h = runpy.run_path(str(HELP))
cmd, must, sha, switch = (h[k] for k in ('cmd','must','sha','switch'))
runner = runpy.run_path(str(LEGACY/'runner.py'))
env_of, ready, atomic = (runner[k] for k in ('env_of','ready','atomic'))


def private_db(container):
    command, sql, role = mini['database'](env_of(container))
    must(role=='k56_shared_api','WRONG_K56_DATABASE_ROLE')
    return command,sql


def scalar(sql, query):
    output=sql("BEGIN READ ONLY; SET LOCAL statement_timeout='4s'; "+query+"; ROLLBACK;").decode().splitlines()
    rows=[line.strip() for line in output if line.strip() not in ('','BEGIN','SET','ROLLBACK')]
    must(len(rows)==1,'K56_EXPECTED_ONE_READONLY_RESULT')
    return rows[0]


def check_idle(sql):
    counts=json.loads(scalar(sql,"""SELECT json_build_object(
      'active',(SELECT count(*) FROM assessment_k56.term_test_attempt a
        LEFT JOIN assessment_k56.term_test_exam_session s ON s.id=a.exam_session_id
        WHERE a.superseded_at IS NULL AND a.test_slug IN ('mini-test-k56','term-test-1-k56','term-test-2-k56')
          AND ((s.listening_deadline_at>=now() AND a.listening_submitted_at IS NULL)
            OR (a.reading_deadline_at>=now() AND a.reading_submitted_at IS NULL)
            OR (a.writing_deadline_at>=now() AND a.writing_submitted_at IS NULL)
            OR (greatest(a.updated_at,s.updated_at)>=now()-interval '5 minutes'
              AND a.completed_at IS NULL))),
      'grading',(SELECT count(*) FROM assessment_k56.term_test_writing_grading_job
        WHERE status IN ('queued','processing')))"""))
    print(json.dumps({'window':counts}),flush=True)
    must(all(n==0 for n in counts.values()),'K56_WORK_IN_PROGRESS')


def rpc():
    node="""import fs from 'node:fs';
import {RemoteJournalStore} from './src/exam-journal-runtime/src/remote-store.mjs';
const config=JSON.parse(fs.readFileSync(process.env.EXAM_JOURNAL_CONFIG_FILE,'utf8'));
const endpoint=new URL(config.rpc.endpoint);
if(endpoint.protocol!=='https:'||endpoint.pathname!=='/exam-journal-20261024/rpc/term-mini-k56')process.exit(2);
const probe=new RemoteJournalStore({endpoint:endpoint.href,key:Buffer.from(config.rpc.key,'base64'),
 productId:'term-mini-k56',timeoutMs:4000});
try{if((await probe.ready)?.ok!==true)process.exitCode=3;}
finally{await probe.close();}
const denied=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(2500)});
if(denied.status!==403)process.exitCode=4;
await denied.body?.cancel();"""
    cmd('docker','exec',API,'node','--input-type=module','-e',node,timeout=14)


def fingerprints(paths):
    result=h['fingerprints'](API,['/app/src/'+name for name in paths])
    return {k.removeprefix('/app/src/'):v for k,v in result.items()}


def persistent(old, sources, delta):
    labels=old['Config']['Labels']
    must(labels['com.docker.compose.service']=='k56-ic2264-api','WRONG_K56_COMPOSE_SERVICE')
    paths=labels['com.docker.compose.project.config_files'].split(',')
    operator=Path(paths[-1])
    must(str(operator)=='/opt/izone-k56-auth-scope-r66-real-20261018/compose.override.yml'
        and not operator.is_symlink(),'WRONG_K56_COMPOSE_OWNER')
    original=operator.read_bytes()
    value=original.decode()
    must(value.count('    environment: !override\n')==1 and value.count('    volumes:\n')==1,'K56_COMPOSE_SHAPE_CHANGED')
    old_binds={entry.split(':',2)[1]:entry for entry in old['HostConfig']['Binds']}
    for target in sources:
        if target not in old_binds: continue
        line=f'      - {old_binds[target]}\n'
        must(value.count(line)==1,'K56_COMPOSE_OLD_BIND_CHANGED')
        value=value.replace(line,'',1)
    mounts=''.join(f'      - {source}:{target}:ro\n' for target,source in sources.items())
    value=value.replace('    volumes:\n','    volumes:\n'+mounts,1)
    value,n=re.subn(r'^      BUILD_SHA: .+$',f'      BUILD_SHA: "{delta["BUILD_SHA"]}"',value,flags=re.M)
    must(n==1,'K56_COMPOSE_BUILD_CHANGED')
    env_add=''.join(f'      {k}: "{v}"\n' for k,v in delta.items() if k!='BUILD_SHA')
    value=value.replace('    environment: !override\n','    environment: !override\n'+env_add,1)
    candidate=ROOT/'compose-candidate.private.yml'
    atomic(candidate,value.encode())
    compose=['docker','compose','--project-directory',labels['com.docker.compose.project.working_dir']]
    for path in paths[:-1]: compose.extend(('-f',path))
    def merged(path):
        return json.loads(cmd(*compose,'-f',str(path),'config','--no-interpolate','--format','json'))
    before,after=merged(operator),merged(candidate)
    service='k56-ic2264-api'
    config=after['services'][service]
    must(all(config['environment'][k]==v for k,v in delta.items()),'K56_COMPOSE_ENV_DIFFERS')
    mounts={item['target']:item for item in config['volumes']}
    must(all(mounts[k]['source']==str(v) and mounts[k]['read_only'] is True for k,v in sources.items()),'K56_COMPOSE_MOUNT_DIFFERS')
    for merged_doc in (before,after):
        selected=merged_doc['services'][service]
        for k in delta: selected['environment'].pop(k,None)
        selected['volumes']=[item for item in selected['volumes'] if item['target'] not in sources]
    must(before==after,'UNEXPECTED_K56_COMPOSE_CHANGE')
    return operator,original,value.encode()


def prepare():
    m=json.loads((ROOT/'manifest.json').read_text())
    old=switch.inspect(API)
    must(env_of(old)['BUILD_SHA']==OLD_BUILD and old['Id']==m['container'] and old['Image']==m['image'],'K56_BASE_CHANGED')
    must(len(old['Mounts'])==21,'K56_BASE_MOUNT_COUNT_CHANGED')
    must(set(m['files'])==TARGETS,'K56_SCOPE_CHANGED')
    must(re.fullmatch('[a-f0-9]{40}',m['buildSha']) is not None,'BAD_K56_BUILD')
    must(fingerprints(m['live'])==m['live'],'K56_LIVE_HASH_CHANGED')
    must(not any(k.startswith('K56_MINI_HOLD_') for k in env_of(old)),'K56_HOLD_ALREADY_CONFIGURED')
    sources={}
    for name,checksum in m['files'].items():
        p=ROOT/'src'/name
        must(p.is_file() and not p.is_symlink() and sha(p.read_bytes())==checksum,'K56_FILE_CHECK_FAILED')
        cmd('docker','exec','-i',API,'node','--input-type=module','--check',data=p.read_bytes())
        sources['/app/src/'+name]=p
    sources[SCOPE_TARGET]=SCOPE.parent
    must(json.loads(SCOPE.read_text())=={'classes':[]},'K56_INITIAL_HOLD_SCOPE_NOT_CLOSED')
    migration=(ROOT/'mini-k56-submission-hold.sql').read_bytes()
    must(sha(migration)==m['migration'],'K56_MIGRATION_HASH_DIFFERS')
    command,sql=private_db(old)
    check_idle(sql)
    rpc()
    delta={'BUILD_SHA':m['buildSha'],'K56_MINI_HOLD_HOURS':'24','K56_MINI_HOLD_LIMIT':'100',
           'K56_MINI_HOLD_PAPER':'true','K56_MINI_HOLD_CLASSES_FILE':SCOPE_TARGET+'/config.json'}
    return m,old,sources,migration,command,sql,delta,persistent(old,sources,delta)


def container_spec(old,sources,delta):
    expected=copy.deepcopy(old)
    # This older container describes every bind in Binds and omits Mounts.
    expected['HostConfig'].setdefault('Mounts',[])
    payload=switch.clone_payload(expected,sources)
    endpoints=payload['NetworkingConfig']['EndpointsConfig']
    addresses={k:v['IPAddress'] for k,v in old['NetworkSettings']['Networks'].items()}
    must(addresses=={'izone-k56-demo_default':'172.25.0.4','mapping-api-net':'172.20.0.16'},'K56_NETWORK_DRIFT')
    for network,address in addresses.items(): endpoints[network]['IPAMConfig']={'IPv4Address':address}
    payload['Env']=[f'{key}={val}' for key,val in {**env_of(old),**delta}.items()]
    expected['Config']['Env']=payload['Env']
    return payload,expected,addresses


def apply():
    m,old,sources,migration,command,sql,delta,(operator,original,planned)=prepare()
    payload,expected,addresses=container_spec(old,sources,delta)
    names=set(cmd('docker','ps','-a','--format','{{.Names}}').splitlines())
    must(not {OLD,NEW}&names,'K56_RELEASE_CONTAINER_ALREADY_EXISTS')
    before=mini['data_digest'](sql)
    backup_path=ROOT/'database-before.private.dump'
    backup=backup_path.read_bytes() if backup_path.exists() else command(
        'pg_dump','--format=custom','--schema=assessment_k56','--lock-wait-timeout=4s')
    listing=cmd('docker','exec','-i','mapping-postgres','pg_restore','--list',data=backup,timeout=35)
    must(backup.startswith(b'PGDMP') and 'term_test_attempt' in listing,'K56_BACKUP_VERIFICATION_FAILED')
    if not backup_path.exists(): atomic(backup_path,backup)
    compose_before=ROOT/'compose-before.private.yml'
    if compose_before.exists():
        must(compose_before.read_bytes()==original,'K56_COMPOSE_CHANGED_SINCE_BACKUP')
    else:
        atomic(compose_before,original)
    sql(migration.decode().replace('assessment.','assessment_k56.'))
    must(mini['data_digest'](sql)==before,'K56_NATIVE_DATA_DRIFT_DURING_SCHEMA_CHANGE')
    candidate=switch.engine('POST','/v1.48/containers/create?name='+NEW,payload,(201,))['Id']
    switch.compare_mounts(expected,switch.inspect(candidate),sources)
    check_idle(sql)
    started=time.monotonic()
    try:
        must(operator.read_bytes()==original and switch.inspect(API)['Id']==old['Id'],'K56_RELEASE_DRIFT')
        cmd('docker','stop','--time','10',old['Id'])
        cmd('docker','rename',old['Id'],OLD)
        cmd('docker','rename',candidate,API)
        cmd('docker','start',candidate)
        ready(m['buildSha'])
        live=switch.inspect(API)
        must(live['Id']==candidate and not switch.state(old['Id']),'K56_WRONG_RUNTIME')
        must(addresses=={k:v['IPAddress'] for k,v in live['NetworkSettings']['Networks'].items()},'K56_NETWORK_DIFFERS')
        switch.compare_mounts(expected,live,sources)
        must(fingerprints(m['files'])==m['files'],'K56_RUNTIME_FILE_MISMATCH')
        rpc()
        mini['prepared_probe']()
        atomic(operator,planned,stat.S_IMODE(operator.stat().st_mode))
    except Exception:
        if switch.state(candidate): cmd('docker','stop','--time','10',candidate)
        if switch.inspect(candidate)['Name']=='/'+API: cmd('docker','rename',candidate,NEW)
        if switch.inspect(old['Id'])['Name']!='/'+API: cmd('docker','rename',old['Id'],API)
        if not switch.state(old['Id']): cmd('docker','start',old['Id'])
        ready(OLD_BUILD);rpc()
        if operator.read_bytes()==planned: atomic(operator,original,stat.S_IMODE(operator.stat().st_mode))
        raise
    print(json.dumps({'status':'compatible_closed','build':m['buildSha'],'old':old['Id'],'live':candidate,
      'backupSha':sha(backup),'elapsedMs':round(1000*(time.monotonic()-started)),'rpc':'signed-only'}),flush=True)


def scope(mode):
    m=json.loads((ROOT/'manifest.json').read_text())
    live=switch.inspect(API)
    must(env_of(live)['BUILD_SHA']==m['buildSha'],'K56_SCOPE_WRONG_RUNTIME')
    _,sql=private_db(live)
    if mode=='enable':
        ready(m['buildSha']);rpc()
        check_idle(sql)
        must(json.loads(SCOPE.read_text())=={'classes':[]},'K56_SCOPE_ALREADY_OPEN')
    target={'classes':None if mode=='enable' else []}
    atomic(SCOPE,json.dumps(target).encode(),0o644)
    shown=cmd('docker','exec',API,'node','-e',
      "process.stdout.write(require('fs').readFileSync(process.env.K56_MINI_HOLD_CLASSES_FILE,'utf8'))")
    must(json.loads(shown)==target,'K56_SCOPE_READBACK_MISMATCH')
    print(json.dumps({'status':mode,'scope':target,'policy':{'hours':24,'classLimit':100},'build':m['buildSha']}))


if __name__=='__main__':
    os.umask(0o077)
    must(Path.cwd()==ROOT and os.geteuid()==0,'K56_RELEASE_DIRECTORY_REQUIRED')
    mode=sys.argv[1] if len(sys.argv)==2 else ''
    if mode=='preflight':
        _,old,sources,_,_,_,delta,_=prepare()
        container_spec(old,sources,delta)
        print('K56_MINI_COMPATIBILITY_PREFLIGHT_PASSED')
    elif mode=='apply': apply()
    elif mode in ('enable','drain'): scope(mode)
    else: raise SystemExit('Use preflight, apply, enable or drain')
