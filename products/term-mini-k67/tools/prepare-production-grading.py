"""Chuẩn bị/chuyển bộ chấm K67 đã tạo sang cổng/kho thật, luôn inactive.

Giữ backup trước sửa và ý định API bền vững. Khi mất phản hồi chỉ đọc lại;
không tự PUT lại, bật workflow, chạy AI hoặc ghi Portal. Lỗi giữ bằng chứng.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-grading')
STATE=PRIVATE/'state.json'
SDK=ROOT/'ops/production-grading.mjs'

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def immutable(path,value):
    if path.exists():
        if json.loads(path.read_bytes())!=value:raise RuntimeError('PRODUCTION_GRADING_ARTIFACT_CHANGED')
    else:
        with path.open('x',encoding='utf-8') as stream:json.dump(value,stream,ensure_ascii=False,indent=2)

def sdk(p,input,label,attempt=None):
    return json.loads(p.call([p.NODE,str(SDK)],label,input_bytes=json.dumps(input,ensure_ascii=False).encode(),journal_id=attempt))

def inventory(p):
    manifest=json.loads((PRIVATE/'candidates/manifest.json').read_bytes())
    target=json.loads((PRIVATE/'target.json').read_bytes())
    if manifest['status']!='complete' or len(manifest['workflows'])!=49 \
      or hashlib.sha256((PRIVATE/'target.json').read_bytes()).hexdigest()!=manifest['target_sha256']:
        raise RuntimeError('PRODUCTION_GRADING_MANIFEST_CHANGED')
    original=json.loads(p.STATE.read_bytes())
    result=[]
    for row in manifest['workflows']:
        path=Path(row['path'])
        if path.parent!=PRIVATE/'candidates' or hashlib.sha256(path.read_bytes()).hexdigest()!=row['sha256']:
            raise RuntimeError('PRODUCTION_GRADING_CANDIDATE_CHANGED')
        own=original['created'][row['sourceId']]
        if row['targetId']!=own['id'] or row['profile']!=own['profile'] or row['name']!=own['name'] \
          or target['workflowIds'][row['sourceId']]!=own['id']:raise RuntimeError('PRODUCTION_GRADING_ID_CHANGED')
        result.append((row,json.loads(path.read_bytes())))
    return result

def prepare(h,p):
    PRIVATE.mkdir(parents=True,exist_ok=True)
    state=json.loads(STATE.read_bytes()) if STATE.exists() else {'intent':uuid.uuid4().hex,'rows':{}}
    if state.get('pending'):raise RuntimeError('PRODUCTION_GRADING_PENDING_RECONCILE')
    connection=json.loads((PRIVATE.parent/'production-n8n/state.json').read_bytes())
    if connection.get('stage')!='connection_verified':raise RuntimeError('PRODUCTION_GRADING_CONNECTION_NOT_VERIFIED')
    target=json.loads(p.TARGET.read_bytes());target['apiBaseUrl']='https://ducizone.ddns.net:18869/term-mini-k67-api'
    redis_keys=[key for key in target['credentials'] if ':redis:' in key]
    if redis_keys!=['default:redis:nD12IAhtWT5GU4YV']:raise RuntimeError('PRODUCTION_GRADING_REDIS_BINDINGS_CHANGED')
    target['credentials'][redis_keys[0]]=connection['redis_credential']
    immutable(PRIVATE/'target.json',target)
    if not (PRIVATE/'candidates').exists():p.export(PRIVATE/'target.json',PRIVATE/'candidates')
    for row,candidate in inventory(p):
        key=row['sourceId'];saved=state['rows'].get(key)
        if saved:
            if hashlib.sha256(Path(saved['before']).read_bytes()).hexdigest()!=saved['before_sha256']:
                raise RuntimeError('PRODUCTION_GRADING_BACKUP_CHANGED')
            continue
        p.validate(Path(row['path']))
        observed=sdk(p,{'operation':'snapshot','profile':row['profile'],'sourceId':key},'production-grading-before-'+key)['workflow']
        # Phải khớp baseline đã tạo/đã phục hồi; không nhận bản sửa ngoài task.
        baseline=json.loads((p.PRIVATE/'final-candidates'/Path(row['path']).name).read_bytes())
        if p.workflow_body(observed)!=p.workflow_body(baseline):raise RuntimeError('PRODUCTION_GRADING_BASELINE_CHANGED')
        path=PRIVATE/('before-'+row['targetId']+'.private.json');immutable(path,observed)
        state['rows'][key]={'before':str(path),'before_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'validated_sha256':row['sha256']}
        h.atomic(STATE,state)
        print(json.dumps({'outcome':'progress','backed_up':len(state['rows']),'expected':49,'active':False}),flush=True)
    state['stage']='prepared_inactive';h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'workflows':49,'active':False,'learner_cutover':False}

def update(h,p):
    state=json.loads(STATE.read_bytes())
    if len(state['rows'])!=49:raise RuntimeError('PRODUCTION_GRADING_BACKUPS_INCOMPLETE')
    for row,candidate in inventory(p):
        key=row['sourceId'];saved=state['rows'][key]
        if saved['validated_sha256']!=row['sha256'] or hashlib.sha256(Path(saved['before']).read_bytes()).hexdigest()!=saved['before_sha256']:
            raise RuntimeError('PRODUCTION_GRADING_BACKUP_CHANGED')
        before=json.loads(Path(saved['before']).read_bytes())
        payload={'operation':'inspect','profile':row['profile'],'sourceId':key,'before':before,'candidate':candidate}
        observed=sdk(p,payload,'production-grading-inspect-'+key)
        pending=state.get('pending')
        if pending and pending['sourceId']!=key:
            if saved.get('after_version') and observed['classification']=='candidate':continue
            raise RuntimeError('PRODUCTION_GRADING_PENDING_ORDER_CHANGED')
        if pending and observed['classification']!='candidate':raise RuntimeError('PRODUCTION_GRADING_MUTATION_OUTCOME_UNKNOWN')
        if observed['classification']=='before':
            state['pending']={'sourceId':key,'attempt':uuid.uuid4().hex};h.atomic(STATE,state)
            observed=sdk(p,{**payload,'operation':'update'},'production-grading-update-'+key,state['pending']['attempt'])
        if observed['classification']!='candidate':raise RuntimeError('PRODUCTION_GRADING_UPDATE_NOT_READBACK')
        immutable(PRIVATE/('after-'+row['targetId']+'-'+observed['workflow']['versionId']+'.private.json'),observed['workflow'])
        saved['after_version']=observed['workflow']['versionId'];state.pop('pending',None);h.atomic(STATE,state)
        print(json.dumps({'outcome':'progress','updated':sum('after_version' in value for value in state['rows'].values()),'expected':49,'active':False}),flush=True)
    state['stage']='production_bound_inactive';h.atomic(STATE,state)
    return {'outcome':'success','stage':state['stage'],'workflows':49,'active':False,'learner_cutover':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__);modes=parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--prepare',action='store_true');modes.add_argument('--update-inactive',action='store_true');args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    h=load('http_util','prepare-http-fixture.py');u=load('redis_util','prepare-redis-fixture.py')
    p=load('grading_provision','provision-grading-bundle.py');guard=load('context_guard','prepare-context-source.py')
    PRIVATE.mkdir(parents=True,exist_ok=True)
    fixture=load('grading_fixture_lock','prepare-grading-fixture.py')
    with fixture.single_owner(PRIVATE/'operation.lock'):
        client=u.connect()
        try:return guard.run_guarded(u,h,client,lambda:prepare(h,p) if args.prepare else update(h,p),PRIVATE,caller_path=Path(__file__))
        finally:client.close()

if __name__=='__main__':sys.exit(main())
