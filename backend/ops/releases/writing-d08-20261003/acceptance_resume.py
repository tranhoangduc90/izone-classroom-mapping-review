"""Tiếp tục API K56/demo, giữ nguyên bằng chứng Mapping từ phiên bị gián đoạn.
CAS khóa đúng generation2 và byte journal cũ; không chạy lại đích đã đạt.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import acceptance_cas as cas

def check(condition,reason):
    if not condition:raise RuntimeError(reason)

def sender_stopped(pid):
    # Chỉ VPS POSIX; os.kill(pid,0) trên Windows không phải phép dò an toàn.
    check(os.name=='posix','resume_requires_posix_process_probe')
    check(type(pid) is int and pid>1,'resume_old_pid_invalid')
    try:os.kill(pid,0)
    except ProcessLookupError:return True
    return False

def validate_spec(request,c):
    value=request['acceptance_binding'];spec=request.get('acceptance_resume',{})
    check(request['run_id']==value['acceptance_run_id'],'resume_request_run_id_mismatch')
    check(value['expected_generation']==2,'resume_generation_invalid')
    required={'previous_binding','executor_sha256','journal_sha256','reuse_receipt_sha256','run_targets','reuse_targets','approved_package_digest'}
    check(set(spec)==required,'resume_contract_invalid')
    old=spec['previous_binding']
    check(old['expected_generation']==0 and old['release_run_id']==value['release_run_id'] and old['acceptance_run_id']==value['acceptance_run_id'] and old['original_plan_digest']==value['original_plan_digest'] and old['ui_ledger_sha256']==value['ui_ledger_sha256'],'resume_previous_binding_invalid')
    check(old['acceptance_digest']!=value['acceptance_digest'],'resume_source_epoch_unchanged')
    for key in ('executor_sha256','journal_sha256','reuse_receipt_sha256','approved_package_digest'):
        check(isinstance(spec[key],str) and re.fullmatch('[a-f0-9]{64}',spec[key]),'resume_digest_invalid')
    check(spec['run_targets']==list(c.NAMES[1:]) and spec['reuse_targets']==[c.NAMES[0]],'resume_target_scope_invalid')
    return spec

def inspect_previous(request,c):
    spec=validate_spec(request,c);value=request['acceptance_binding']
    state_path=c.acceptance_path(value);journal_path=c.r.RELEASE_ROOT/request['run_id']/'canary.json'
    raw=journal_path.read_bytes();check(cas.sha(raw)==spec['journal_sha256'],'resume_old_journal_changed')
    old=json.loads(raw)
    check(old.get('status')=='unknown' and old.get('runtime_unchanged') is True and old.get('before')==old.get('after')==request['expected'],'resume_runtime_or_old_status_invalid')
    check([{k:i[k] for k in ('name','attempt_id','marker','course_id','student_id')} for i in old['identities']]==[{k:i[k] for k in ('name','attempt_id','marker','course_id','student_id')} for i in request['identities']],'resume_identities_changed')
    receipts=old.get('receipts',[])
    check(len(receipts)==2 and [r.get('target') for r in receipts]==list(c.NAMES[:2]),'resume_old_receipt_scope_invalid')
    mapping=receipts[0]
    check(hashlib.sha256(json.dumps(mapping,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()==spec['reuse_receipt_sha256'],'resume_reuse_receipt_changed')
    from outcome_receipt import validate_api_receipt
    validate_api_receipt(mapping,request['identities'][0])
    failed=receipts[1];cleanup=failed.get('cleanup',{})
    check(failed.get('status')=='failed' and failed.get('api_database',{}).get('error')=='23514' and failed.get('api_database',{}).get('attempt_id')==request['identities'][1]['attempt_id'] and cleanup.get('attempt_id')==request['identities'][1]['attempt_id'] and cleanup.get('status')=='passed' and cleanup.get('removal')=={'removed':0} and cleanup.get('readback')=={'attempt_remaining':0,'marker_remaining':0,'children_remaining':0},'resume_failed_seed_not_reconciled')
    raw_state=state_path.read_bytes();check(cas.sha(raw_state)==spec['executor_sha256'],'resume_old_executor_changed')
    state=json.loads(raw_state)
    check(state.get('generation')==2 and state.get('status')=='unknown' and state.get('binding')==spec['previous_binding'],'resume_old_executor_binding_changed')
    check(sender_stopped(state.get('pid')),'resume_old_sender_still_alive')
    check(c.r.probe(request['manifest'])==request['expected'],'resume_live_runtime_changed')
    return old

def acquire(request,c):
    previous=inspect_previous(request,c);spec=request['acceptance_resume'];value=request['acceptance_binding']
    next_state={'generation':3,'binding':value,'status':'api_started','pid':os.getpid(),'previous_binding':spec['previous_binding'],'previous_journal_sha256':spec['journal_sha256'],'approved_previous_package_digest':spec['approved_package_digest']}
    cas.claim(c.acceptance_path(value),spec['executor_sha256'],2,next_state,lambda state:inspect_previous(request,c))
    return previous
