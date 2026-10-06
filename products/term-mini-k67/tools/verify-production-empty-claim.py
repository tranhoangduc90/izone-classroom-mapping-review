"""Chạy parent K67 thật trên hàng chờ trống: kiểm đích mới, không chấm/gửi điểm.

Chỉ chạy khi kho production chưa có bài/job; ghi ý định trước execution, giữ
ID và readback. Mất phản hồi không chạy lại. Không bật schedule/webhook.
"""
from pathlib import Path
import importlib.util
import json
import sys
import uuid
ROOT=Path(__file__).resolve().parents[1]
PRIVATE=Path('E:/Codex-Data/k67-backend-separation-20261006/production-empty-claim')
STATE=PRIVATE/'state.json'
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def empty(db,u,client):
    value=db.query(u,client,"SELECT jsonb_build_object('attempts',(SELECT count(*) FROM assessment.term_test_attempt),'jobs',(SELECT count(*) FROM assessment.term_test_writing_grading_job),'runs',(SELECT count(*) FROM assessment.term_test_writing_grading_run),'finals',(SELECT count(*) FROM assessment.term_test_writing_grading_final))")
    if value!={'attempts':0,'jobs':0,'runs':0,'finals':0}:raise RuntimeError('PRODUCTION_CLAIM_NOT_EMPTY')
    return value
def verify(h,u,p,db,g,client):
    state=json.loads(STATE.read_bytes()) if STATE.exists() else {'intent':uuid.uuid4().hex}
    bound=json.loads(g.STATE.read_bytes())
    if bound.get('stage')!='production_bound_inactive':raise RuntimeError('PRODUCTION_GRADING_NOT_BOUND')
    matches=[(row,candidate) for row,candidate in g.inventory(p) if row['sourceId']=='SGtuBV91Yc9oxEVt']
    row,candidate=matches[0];before=json.loads(Path(bound['rows'][row['sourceId']]['before']).read_bytes())
    inspected=g.sdk(p,{'operation':'inspect','profile':row['profile'],'sourceId':row['sourceId'],'before':before,'candidate':candidate},'production-empty-claim-inspect')
    if inspected['classification']!='candidate':raise RuntimeError('PRODUCTION_PARENT_CHANGED')
    counts=empty(db,u,client)
    if state.get('execution_id'):
        identity=state['execution_id']
    elif state.get('pending'):
        journal=p.PRIVATE/('production-empty-claim-run-'+state['pending']+'.stdout.log')
        if not journal.exists():raise RuntimeError('PRODUCTION_EMPTY_CLAIM_OUTCOME_UNKNOWN')
        result=json.loads(journal.read_bytes());identity=str(result['executionId'])
        state['execution_id']=identity;h.atomic(STATE,state)
    else:
        state['pending']=uuid.uuid4().hex;h.atomic(STATE,state)
        result=p.ctl('default','workflow','run',row['targetId'],'--trigger','Chạy thử bằng tay','--wait','--timeout','60000',
          label='production-empty-claim-run',journal_id=state['pending'])
        if result.get('workflowId')!=row['targetId'] or result.get('status')!='success':raise RuntimeError('PRODUCTION_EMPTY_CLAIM_EXECUTION_FAILED')
        identity=str(result['executionId']);state['execution_id']=identity;h.atomic(STATE,state)
    observed=p.ctl('default','execution','get',identity,'--logs',label='production-empty-claim-readback')
    if observed.get('workflowId')!=row['targetId'] or observed.get('status')!='success':raise RuntimeError('PRODUCTION_EMPTY_CLAIM_READBACK_FAILED')
    runs=observed['data']['resultData']['runData']
    if len(runs.get('Nhận việc chấm',[]))!=1 or runs['Nhận việc chấm'][0].get('error'):
        raise RuntimeError('PRODUCTION_EMPTY_CLAIM_NOT_EXECUTED')
    claim_outputs=runs['Nhận việc chấm'][0]['data']['main']
    if claim_outputs!=[[]] or any('Chấm' in name or 'Ghi kết quả' in name for name in runs):
        raise RuntimeError('PRODUCTION_EMPTY_CLAIM_NOT_EMPTY_OUTPUT')
    if empty(db,u,client)!=counts:raise RuntimeError('PRODUCTION_EMPTY_CLAIM_WROTE_DATA')
    g.immutable(PRIVATE/('execution-'+identity+'.private.json'),observed)
    state['stage']='verified';state.pop('pending',None);h.atomic(STATE,state)
    return {'outcome':'success','execution_id':identity,'native_claim_executed':True,'claimed_jobs':0,'ai_calls':0,'portal_calls':0,'learner_cutover':False}
def main():
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True);PRIVATE.mkdir(parents=True,exist_ok=True)
    h=load('http_util','prepare-http-fixture.py');u=load('redis_util','prepare-redis-fixture.py');p=load('grading_provision','provision-grading-bundle.py')
    db=load('production_database','prepare-production-database.py');g=load('production_grading','prepare-production-grading.py');guard=load('context_guard','prepare-context-source.py')
    fixture=load('grading_lock','prepare-grading-fixture.py')
    with fixture.single_owner(g.PRIVATE/'operation.lock'):
        client=u.connect()
        try:return guard.run_guarded(u,h,client,lambda:verify(h,u,p,db,g,client),PRIVATE,caller_path=Path(__file__))
        finally:client.close()
if __name__=='__main__':sys.exit(main())
