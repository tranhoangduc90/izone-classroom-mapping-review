"""Swap only the tested Writing module on the verified K56 production lane."""
from argparse import ArgumentParser
import copy
import fcntl
from hashlib import sha256
import json
from pathlib import Path
from runpy import run_path
import subprocess
import time
from urllib.request import urlopen

ROOT=Path('/opt/izone-k56-writing-callback-locks-20261127')
LIVE='izone-k56-term1-skill-fallback-20261121-serving'
CANDIDATE='izone-k56-writing-callback-locks-20261127-candidate'
RETAINED='izone-k56-writing-callback-locks-20261127-prior'
TARGET='/app/src/term-test-writing-grading.js'
FILE=ROOT/'term-test-writing-grading.js'
BASE='3f2f3757f6cf77b8f59d9a093d8202a7b9589a92e233975bef39757f6db1ce64'
AFTER='c78aa862d731a77da3ed2b9a3a6a00b9fb82161d6cce9f360c280f66fa296b02'
BUILD='e9e6d75b2a71ffe3d7587dea241bdd5a9cc75d1d'
IMAGE='sha256:6e1b6b769352e4fd58e21bf3103270c676c05b39219762f1b6ae5b22f33389e0'
HELPER='/opt/term-mini-k67/releases/20261112-submit-compat/rehearse-k67-docker-switch-20261112.py'
WINDOW_JS=r"""
import {loadConfig} from '/app/src/config.js';
import {createDatabasePool} from '/app/src/db.js';
const pool=createDatabasePool(loadConfig());
const client=await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='4s'");
  const {rows}=await client.query("SELECT (SELECT count(*)::int FROM assessment.term_test_exam_session WHERE superseded_at IS NULL AND listening_submitted_at IS NULL AND listening_deadline_at>now()) AS active_listening, (SELECT count(*)::int FROM assessment.term_test_attempt WHERE superseded_at IS NULL AND ((reading_submitted_at IS NULL AND reading_deadline_at>now()) OR (writing_submitted_at IS NULL AND writing_deadline_at>now()))) AS active_reading_writing, (SELECT count(*)::int FROM assessment.term_test_writing_grading_job WHERE status='processing' AND lease_until>now()) AS active_leases");
  console.log(JSON.stringify(rows[0]));
} finally {await client.query('ROLLBACK'); client.release(); await pool.end();}
"""

def docker(*args, data=None, timeout=15):
    return subprocess.run(['docker',*args],input=data,text=True,stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE,check=True,timeout=timeout).stdout.strip()

def inspect(name):
    return json.loads(docker('inspect','--type','container',name))[0]

def inspect_if_present(name):
    identifiers=docker('ps','-aq','--filter',f'name=^/{name}$')
    return inspect(name) if identifiers else None

def window(container):
    return json.loads(docker('exec','-i',container,'node','--input-type=module',data=WINDOW_JS))

def mounts(row):
    return {m['Destination']:(m['Source'],m['Type'],m['RW'],m['Propagation']) for m in row['Mounts']}

def ready(name, wanted_hash, tries=18):
    for trial in range(tries):
        try:
            r=inspect(name)
            assert r['State']['Running'] and r['Image']==IMAGE
            probe=r['State'].get('Health',{}).get('Status')
            assert probe in {'starting','healthy'}
            with urlopen('http://127.0.0.1:19861/health',timeout=1.5) as response:
                h=json.load(response)
            assert h['ok'] is True and h['build']['sha']==BUILD
            assert h['deploymentProfile']=='k56-ic2264'
            assert docker('exec',name,'sha256sum',TARGET).split()[0]==wanted_hash
            return {'containerId':r['Id'],'build':BUILD,'moduleSha256':wanted_hash,'dockerHealth':probe}
        except Exception:
            if trial==tries-1:
                raise
            time.sleep(0.5)

def stage():
    assert sha256(FILE.read_bytes()).hexdigest()==AFTER
    before=inspect(LIVE)
    assert before['Image']==IMAGE and before['HostConfig']['RestartPolicy']['Name']=='unless-stopped'
    assert before['HostConfig']['PortBindings']=={'8788/tcp':[{'HostIp':'127.0.0.1','HostPort':'19861'}]}
    assert not inspect_if_present(RETAINED)
    ready(LIVE,BASE)
    helper=run_path(HELPER)
    engine=helper['engine']
    engine.__globals__['SOCKET']=Path('/var/run/docker.sock')
    proposed=inspect_if_present(CANDIDATE)
    if not proposed:
        source=helper['clone_payload'](copy.deepcopy(before),{TARGET:FILE})
        source['HostConfig']['RestartPolicy']={'Name':'no','MaximumRetryCount':0}
        engine('POST',f'/v1.48/containers/create?name={CANDIDATE}',source,(201,))
        proposed=inspect(CANDIDATE)
    assert proposed['State']['Status']=='created' and proposed['Image']==before['Image']
    assert mounts(proposed)==mounts(before)|{TARGET:(str(FILE),'bind',False,'rprivate')}
    assert proposed['Config']['Env']==before['Config']['Env']
    for key in ('User','Entrypoint','Cmd','WorkingDir','Healthcheck','Labels'):
        assert proposed['Config'][key]==before['Config'][key],key
    for key in ('PortBindings','NetworkMode','Memory','NanoCpus','PidsLimit','CapDrop','SecurityOpt',
                'ReadonlyRootfs','Tmpfs','LogConfig'):
        assert proposed['HostConfig'][key]==before['HostConfig'][key],key
    assert set(proposed['NetworkSettings']['Networks'])==set(before['NetworkSettings']['Networks'])
    assert proposed['HostConfig']['RestartPolicy']['Name']=='no'
    proof={'liveId':before['Id'],'candidateId':proposed['Id'],'moduleSha256':AFTER}
    (ROOT/'stage-state.json').write_text(json.dumps(proof)+'\n')
    return proof|{'window':window(LIVE)}

def rollback(prior_id, new_id):
    new=inspect(new_id)
    if new['State']['Running']:
        docker('stop','--time','7',new_id)
    if new['Name']=='/'+LIVE:
        docker('rename',new_id,CANDIDATE)
    old=inspect(prior_id)
    if old['Name']=='/'+RETAINED:
        docker('rename',prior_id,LIVE)
    if not old['State']['Running']:
        docker('start',prior_id)
    return ready(LIVE,BASE)

def switch():
    proof=json.loads((ROOT/'stage-state.json').read_text())
    old=inspect(LIVE)
    new=inspect(CANDIDATE)
    assert old['Id']==proof['liveId'] and new['Id']==proof['candidateId']
    assert new['State']['Status']=='created'
    ready(LIVE,BASE)
    quiet=window(LIVE)
    if any(quiet.values()):
        return {'state':'waiting_for_quiet_window','window':quiet}
    try:
        started=time.monotonic()
        docker('stop','--time','7',old['Id'])
        docker('rename',old['Id'],RETAINED)
        docker('rename',new['Id'],LIVE)
        docker('start',new['Id'])
        proof_after=ready(LIVE,AFTER)
        docker('update','--restart','unless-stopped',new['Id'])
        return proof_after|{'state':'live','retained':RETAINED,'elapsed_ms':round((time.monotonic()-started)*1000)}
    except Exception as error:
        return rollback(old['Id'],new['Id'])|{'state':'rolled_back','error':type(error).__name__}

parser=ArgumentParser()
parser.add_argument('action',choices=('window','stage','switch','rollback'))
action=parser.parse_args().action
with (ROOT/'cutover.lock').open('a') as guard:
    fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if action=='window':
        outcome=window(LIVE)
    elif action=='stage':
        outcome=stage()
    elif action=='switch':
        outcome=switch()
    else:
        quiet=window(LIVE)
        if any(quiet.values()):
            outcome={'state':'waiting_for_quiet_window','window':quiet}
        else:
            current,prior=inspect(LIVE),inspect(RETAINED)
            proof=json.loads((ROOT/'stage-state.json').read_text())
            assert (prior['Id'],current['Id'])==(proof['liveId'],proof['candidateId'])
            outcome=rollback(prior['Id'],current['Id'])|{'state':'rolled_back'}
print(json.dumps(outcome))
