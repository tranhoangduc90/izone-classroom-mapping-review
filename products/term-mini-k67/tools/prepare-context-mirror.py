"""Dựng tiến trình K67 nhận lớp/quyền qua HTTPS riêng mỗi30giây.

Chỉ ghi bộ đệm ngữ cảnh trong DB K67 bằng role riêng; đối soát hai lần cập
nhật tự động, hash nội dung và bảo toàn13bảng bài thi. Không chuyển học viên.
"""
from pathlib import Path
from urllib.parse import quote
import argparse
import hashlib
import importlib.util
import json
import re
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/context-mirror')
STATE=PRIVATE/'state.json'
APP='term-mini-k67-context-sync'
REMOTE='/opt/'+APP
FILES=['src/context-sync-server.js','src/context-sync.js','src/context-contract.js']
PRODUCT='PRODUCT-TERM-MINI-K67'


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def sha(raw):return hashlib.sha256(raw).hexdigest()


def environment(db,source,route):
    password=db.keys()['roles']['k67_context_sync']
    return ('K67_CONTEXT_DATABASE_URL=postgresql://k67_context_sync:'+quote(password,safe='')
        +'@term-mini-k67-postgres:5432/term_mini_k67\n'
        +'K67_CONTEXT_API_URL='+route.PUBLIC+'/term-mini-k67-context/v1/snapshot\n'
        +'K67_CONTEXT_API_SECRET='+source.secret_values()['api']+'\n').encode()


def verify_container(u,client,state,env):
    row=json.loads(u.remote(client,['docker','inspect',APP]))[0];host=row['HostConfig']
    actual=dict(x.split('=',1) for x in row['Config']['Env'] if '=' in x)
    expected=dict(x.split('=',1) for x in env.decode().splitlines())
    if row['Image']!=state['image'] or not row['State']['Running'] \
        or row['Config']['Cmd']!=['node','src/context-sync-server.js'] or row['Config']['User']!='node' \
        or row['Config'].get('Labels',{}).get('com.izone.product')!=PRODUCT \
        or row['Config'].get('Labels',{}).get('com.izone.purpose')!='context-sync-v1' \
        or row['Config'].get('Labels',{}).get('com.izone.intent')!=state['intent'] \
        or any(actual.get(k)!=v for k,v in expected.items()) or row['Mounts'] \
        or host['NanoCpus']!=250000000 or host['Memory']!=134217728 or host['PidsLimit']!=64 \
        or not host['ReadonlyRootfs'] or host['NetworkMode']!='n8n-net' or host['PortBindings']:
        raise RuntimeError('K67_CONTEXT_MIRROR_CONTAINER_MISMATCH')
    raw=u.remote(client,['docker','exec',APP,'sha256sum',*FILES]).decode()
    hashes={line.split(None,1)[1].strip():line.split()[0] for line in raw.splitlines()}
    if hashes!=state['source_hashes']:raise RuntimeError('K67_CONTEXT_MIRROR_SOURCE_MISMATCH')


def observe(u,client):
    # Chỉ trả metadata; bản ghi người/lớp và mật khẩu không ra stdout.
    script="""import pg from 'pg';
import {createContextSnapshot} from './src/context-contract.js';
const p=new pg.Pool({connectionString:process.env.K67_CONTEXT_DATABASE_URL,max:1,statement_timeout:5000,connectionTimeoutMillis:5000});
const c=await p.connect();try{
await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
const state=(await c.query('SELECT api_version,product_id,source_revision,captured_at,applied_at FROM mapping.k67_context_state WHERE singleton=true')).rows[0];
if(!state){console.log(JSON.stringify({ready:false}));}else{
const payload={apiVersion:state.api_version,productId:state.product_id};
const reads=[
['classes','SELECT erp_course_class_id,erp_class_name_snapshot FROM mapping.classroom_course_mapping ORDER BY erp_course_class_id::text'],
['students','SELECT public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot,status FROM mapping.student_mapping_review ORDER BY public_id::text'],
['memberships','SELECT erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot,source_state FROM mapping.erp_class_membership_snapshot ORDER BY erp_course_class_id::text,erp_student_contact_id::text'],
['accounts','SELECT email,google_subject,display_name,role,status,can_access_all_classes FROM mapping.reviewer_account ORDER BY email'],
['access','SELECT reviewer_email,erp_course_class_id FROM mapping.reviewer_class_access ORDER BY reviewer_email,erp_course_class_id::text']];
for(const [key,sql] of reads)payload[key]=(await c.query(sql)).rows;
const snapshot=createContextSnapshot(payload,new Date(state.captured_at).getTime());
const age=Date.now()-new Date(state.captured_at).getTime();
if(age< -5000||age>65000||snapshot.sourceRevision!==state.source_revision){
const error=new Error('MIRROR_INTEGRITY_INVALID');
error.observation={ageMs:age,expectedRevision:state.source_revision,readbackRevision:snapshot.sourceRevision};throw error;
}
console.log(JSON.stringify({ready:true,sourceRevision:snapshot.sourceRevision,capturedAt:snapshot.capturedAt,
appliedAt:new Date(state.applied_at).toISOString(),ageMs:age,
counts:Object.fromEntries(reads.map(([key])=>[key,payload[key].length]))}));}
await c.query('ROLLBACK');
}catch(error){
const known=['MIRROR_INTEGRITY_INVALID','CONTEXT_INVALID_PAYLOAD','CONTEXT_DUPLICATE','CONTEXT_OUTSIDE_SCOPE'];
const code=known.includes(error?.message)?error.message:(/^[0-9A-Z]{5}$/.test(error?.code||'')?error.code:'OBSERVATION_ERROR');
console.log(JSON.stringify({ready:false,error:code,...(error.observation||{})}));
}finally{c.release();await p.end();}
"""
    return json.loads(u.remote(client,['docker','exec',APP,'node','--input-type=module','-e',script],timeout=12))


def prepare(u,h,source,db,route,migration,client):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    route_state=json.loads(route.STATE.read_text(encoding='utf-8'))
    if route_state['stage']!='context_route_verified':raise RuntimeError('K67_CONTEXT_ROUTE_NOT_VERIFIED')
    route.verify(source)
    db_state=json.loads(db.STATE.read_text(encoding='utf-8'));db.verify_container(u,client,db_state);db.verify_schema(u,client,db_state)
    assessment_before=db.query(u,client,migration.row_query())
    if any(row['count'] for row in assessment_before.values()):raise RuntimeError('K67_MIRROR_PRE_CUTOVER_DATABASE_NOT_EMPTY')
    names=u.remote(client,['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    image=json.loads(source.STATE.read_text(encoding='utf-8'))['image']
    hashes={file:sha((ROOT/file).read_bytes()) for file in FILES}
    if STATE.exists():
        state=json.loads(STATE.read_text(encoding='utf-8'))
        if state['image']!=image or state['source_hashes']!=hashes or not re.fullmatch('[0-9a-f]{32}',state['intent']):
            raise RuntimeError('K67_CONTEXT_MIRROR_STATE_CHANGED')
    else:
        if APP in names:raise RuntimeError('K67_CONTEXT_MIRROR_NAME_COLLISION')
        state={'intent':uuid.uuid4().hex,'image':image,'source_hashes':hashes,'stage':'intent'};h.atomic(STATE,state)
    image_hash=u.remote(client,['docker','exec',source.APP,'sha256sum',*FILES]).decode()
    if {line.split(None,1)[1].strip():line.split()[0] for line in image_hash.splitlines()}!=hashes:
        raise RuntimeError('K67_CONTEXT_MIRROR_IMAGE_SOURCE_MISMATCH')
    env=environment(db,source,route);sftp=client.open_sftp()
    try:
        marker=json.dumps({'intent':state['intent'],'product':PRODUCT},sort_keys=True).encode()
        source.owned_directory_files(sftp,REMOTE,{'identity.json':(marker,0o600),'sync.env':(env,0o600)})
    finally:sftp.close()
    if APP not in names:
        state['stage']='container_create_intent';h.atomic(STATE,state)
        u.remote(client,['docker','run','--detach','--name',APP,'--label','com.izone.product='+PRODUCT,
            '--label','com.izone.purpose=context-sync-v1','--label','com.izone.intent='+state['intent'],
            '--network','n8n-net','--cpus','0.25','--memory','128m','--pids-limit','64','--read-only',
            '--security-opt','no-new-privileges','--cap-drop','ALL','--tmpfs','/tmp:rw,noexec,nosuid,size=16m',
            '--env-file',REMOTE+'/sync.env','--restart','unless-stopped',image,'node','src/context-sync-server.js'])
    verify_container(u,client,state,env)
    deadline=time.monotonic()+45;first=last=None
    while time.monotonic()<deadline:
        observed=observe(u,client)
        if observed.get('error'):raise RuntimeError('K67_CONTEXT_MIRROR_'+observed['error'])
        if observed['ready']:
            if first is None:first=observed
            elif observed['capturedAt']!=first['capturedAt']:last=observed;break
        time.sleep(1)
    if last is None:raise RuntimeError('K67_CONTEXT_MIRROR_TWO_CYCLES_TIMEOUT')
    assessment_after=db.query(u,client,migration.row_query())
    if assessment_after!=assessment_before:raise RuntimeError('K67_CONTEXT_MIRROR_ASSESSMENT_CHANGED')
    state['stage']='continuous_mirror_verified';state['first']=first;state['second']=last
    state['assessment_unchanged']=True;h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'container':APP,'cycles':2,
        'counts':last['counts'],'assessment_unchanged':True,'learner_cutover':False}


def main():
    argparse.ArgumentParser(description=__doc__).parse_args();sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    u=load('redis_util','prepare-redis-fixture.py');h=load('http_util','prepare-http-fixture.py')
    source=load('context_guard','prepare-context-source.py');db=load('production_db','prepare-production-database.py')
    route=load('public_route','prepare-k67-route.py');migration=load('migration','rehearse-migration.py');client=u.connect()
    try:return source.run_guarded(u,h,client,lambda:prepare(u,h,source,db,route,migration,client),PRIVATE,with_catalog=True,caller_path=Path(__file__))
    finally:client.close()


if __name__=='__main__':sys.exit(main())
