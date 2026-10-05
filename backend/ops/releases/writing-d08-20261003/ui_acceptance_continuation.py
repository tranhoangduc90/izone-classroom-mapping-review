"""Tiếp tục sáu ca UI, giữ nguyên API và Shared đã đạt của gói F7.
Đầu vào là bytes có hash và danh tính mới; CAS không seed, HTTP hay cleanup.
Mất phản hồi hoặc lỗi sau CAS giữ trạng thái unknown, không tự gửi lại.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import acceptance_cas as cas
from acceptance_resume import sender_stopped

SHARED='shared-mapping'
FAILED='k56-shared-k56'
APPROVED_F7='cd7adb9864c49907528d2c30b6f7e11752da21cd5b817971c870e7768fb08ee4'
ROLES={'old_plan','old_approval','old_config','old_api_ledger','old_api_database',
       'old_ui_ledger','old_public','old_shared','old_executor','old_journal',
       'old_shared_state','old_shared_cleanup','old_failed_state','old_failed_cleanup'}
SOURCES={'ui-canary.cjs','canary_contract.mjs','canary_remote.py','canary_producer.py'}

def check(value,code):
    if not value:raise ValueError(code)

def canonical(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()

def validate_spec(binding,spec):
    from browser_receipt import ENTRIES
    from canary_remote import acceptance_path
    acceptance_path(binding)
    required={'schema','previous_binding','executor_sha256','journal_sha256',
              'approved_package_digest','run_cases','reuse_cases','replaced_case','old_ui_journals'}
    check(isinstance(spec,dict) and set(spec)==required and spec['schema']=='d08-ui-continuation/v1','ui_resume_contract_invalid')
    check(binding.get('expected_generation')==4 and type(binding.get('expected_generation')) is int,'ui_resume_generation_invalid')
    old=spec['previous_binding']
    acceptance_path(old)
    check(old.get('expected_generation')==2 and all(old.get(k)==binding.get(k) for k in ('release_run_id','acceptance_run_id','original_plan_digest')),
          'ui_resume_previous_binding_invalid')
    check(old.get('acceptance_digest')!=binding.get('acceptance_digest') and old.get('ui_ledger_sha256')!=binding.get('ui_ledger_sha256'),'ui_resume_epoch_unchanged')
    check(spec['approved_package_digest']==APPROVED_F7,'ui_resume_approved_package_wrong')
    check(spec['run_cases']==[case for case in ENTRIES if case!=SHARED] and spec['reuse_cases']==[SHARED] and spec['replaced_case']==FAILED,'ui_resume_scope_invalid')
    check(set(spec['old_ui_journals'])=={SHARED,FAILED},'ui_resume_old_journal_set')
    for digest in (spec['executor_sha256'],spec['journal_sha256'],*[v.get(k) for v in spec['old_ui_journals'].values() for k in ('state_sha256','cleanup_sha256')]):
        check(isinstance(digest,str) and re.fullmatch('[a-f0-9]{64}',digest),'ui_resume_digest_invalid')
    check(all(set(v)=={'state_sha256','cleanup_sha256'} for v in spec['old_ui_journals'].values()),'ui_resume_old_journal_fields')
    return spec

def validate_ledgers(old,new,manifest):
    from ui_rpc_guard import validate_ledger
    validate_ledger(old,manifest);validate_ledger(new,manifest)
    check(old['run_id']==new['run_id'] and old['bundle_revision']==new['bundle_revision'],'ui_resume_ledger_epoch_changed')
    before={e['case_id']:e for e in old['entries']};after={e['case_id']:e for e in new['entries']}
    check(set(before)==set(after),'ui_resume_ledger_scope_changed')
    old_ids={v for e in before.values() for k,v in e['identity'].items() if k in ('attempt_id','student_ref','marker','course_id','student_id')}
    for case,entry in after.items():
        previous=before[case]
        if case!=FAILED:
            check(entry==previous,'ui_resume_unfailed_identity_changed')
        else:
            check({k:v for k,v in entry.items() if k!='identity'}=={k:v for k,v in previous.items() if k!='identity'},'ui_resume_failed_destination_changed')
            check(entry['identity']['class_code']==previous['identity']['class_code'],'ui_resume_failed_class_changed')
            check(all(entry['identity'][key]!=previous['identity'][key] and entry['identity'][key] not in old_ids for key in ('attempt_id','student_ref','marker','course_id','student_id')),
                  'ui_resume_failed_identity_reused')
    return before,after

def validate_cleaned(state,cleanup,entry,ledger_hash,ledger):
    from ui_rpc_guard import validate_cleanup,canonical_hash
    check(state.get('phase')=='cleaned' and type(state.get('sequence')) is int and state['sequence']>0,'ui_resume_old_case_not_cleaned')
    binding={'case_id':entry['case_id'],'bundle_revision':ledger['bundle_revision'],
             'ledger_canonical_sha256':canonical_hash(ledger),'ledger_sha256':ledger_hash}
    stored=state.get('binding',{})
    check(all(stored.get(k)==v for k,v in binding.items()) and set(stored)==set(binding)|{'database_bindings_sha256'}
          and re.fullmatch('[a-f0-9]{64}',stored.get('database_bindings_sha256','')),'ui_resume_old_case_binding_wrong')
    validate_cleanup(cleanup,entry)

def validate_provenance(config,root,new_ledger,public,manifest):
    """Chỉ đọc: giữ raw API cũ và kiểm đầy đủ Shared bằng parser nghiệp vụ."""
    from outcome_receipt import artifact,validate_api
    from acceptance_provenance import validate_reuse
    from browser_receipt import validate
    root=Path(root);spec=validate_spec(config['acceptance_binding'],config['acceptance_ui_resume'])
    check(not config.get('acceptance_resume'),'ui_resume_api_resume_ambiguous')
    proof=config.get('ui_resume_provenance',{});refs=proof.get('artifacts',{})
    check(set(refs)==ROLES,'ui_resume_proof_roles_missing')
    data={key:artifact(root,ref) for key,ref in refs.items()}
    plan=data['old_plan'];old_config=data['old_config'];old_ledger=data['old_ui_ledger'];old_api=data['old_api_database']
    check(plan.get('plan_digest')==canonical({k:v for k,v in plan.items() if k!='plan_digest'})==spec['approved_package_digest'],'ui_resume_old_plan_invalid')
    approval=data['old_approval']
    check(approval.get('plan_digest')==spec['approved_package_digest'] and approval.get('acceptance_authorized') is True and approval.get('production_authorized') is True,'ui_resume_old_approval_invalid')
    check(refs['old_config']['sha256']==plan['checked_inputs'].get(plan.get('config')),'ui_resume_old_config_unapproved')
    for role,filename in (('old_ui_ledger','production-ui-ledger.json'),('old_api_ledger','production-canary-ledger.json')):
        check(refs[role]['sha256']==plan['checked_inputs'].get(str(Path(old_config['evidence_dir'])/filename)),'ui_resume_old_ledger_unapproved')
    check(old_config.get('acceptance_binding')==plan.get('acceptance_binding')==spec['previous_binding'],'ui_resume_old_binding_invalid')
    for key in ('run_id','product_revision','runtime_candidate_checkpoint'):
        check(old_config.get(key)==config.get(key),'ui_resume_product_release_changed')
    check(plan.get('helper_checkpoint')==old_config.get('candidate_checkpoint') and plan.get('runtime_checkpoint')==config.get('runtime_candidate_checkpoint'),'ui_resume_old_source_checkpoint_wrong')
    sources=proof.get('sources',{});check(set(sources)==SOURCES,'ui_resume_source_set')
    for name,source in sources.items():
        filename=source.get('path','');path=root/filename
        check(filename and not Path(filename).is_absolute() and '..' not in Path(filename).parts and path.resolve().is_relative_to(root.resolve()) and path.is_file() and not path.is_symlink(),'ui_resume_source_path_invalid')
        producer=old_config.get('ui_producer_sha256') if name=='ui-canary.cjs' else old_api.get('producer_sources',{}).get(name)
        check(cas.sha(path.read_bytes())==source.get('sha256')==producer==plan['checked_inputs'].get(source.get('original_path')),'ui_resume_old_producer_unapproved')
    check(data['old_public']==public and public.get('status')=='passed','ui_resume_public_changed')
    check(old_api.get('snapshots')==plan.get('expected_after'),'ui_resume_old_snapshot_unapproved')
    validate_api(old_api,data['old_api_ledger'],manifest)
    validate_reuse(old_config,(root/refs['old_config']['path']).parent,data['old_api_ledger'],old_api)
    check(refs['old_executor']['sha256']==spec['executor_sha256'] and refs['old_journal']['sha256']==spec['journal_sha256'],'ui_resume_remote_proof_digest')
    check(data['old_executor'].get('generation')==4 and data['old_executor'].get('status')=='api_passed' and data['old_executor'].get('binding')==spec['previous_binding'],'ui_resume_old_executor_invalid')
    journal=data['old_journal']
    check(journal.get('status')=='passed_api_database' and journal.get('runtime_unchanged') is True and journal.get('before')==journal.get('after')==old_api.get('before')==old_api.get('after') and journal.get('receipts')==old_api.get('receipts'),'ui_resume_old_journal_invalid')
    before,_=validate_ledgers(old_ledger,new_ledger,manifest)
    raw_new=(root/'production-ui-ledger.json').read_bytes()
    check(cas.sha(raw_new)==config['acceptance_binding']['ui_ledger_sha256'] and json.loads(raw_new)==new_ledger,'ui_resume_new_ledger_unbound')
    check(old_ledger['bundle_revision']==config.get('bundle_revision')==old_config.get('bundle_revision')
          and config['product_revision']=='d08-bundle:'+old_ledger['bundle_revision'],'ui_resume_bundle_changed')
    check(refs['old_ui_ledger']['sha256']==spec['previous_binding']['ui_ledger_sha256'],'ui_resume_old_ui_hash_wrong')
    check(canonical(data['old_api_ledger']['manifest'])==canonical(manifest),'ui_resume_manifest_changed')
    for case,prefix in ((SHARED,'old_shared'),(FAILED,'old_failed')):
        hashes=spec['old_ui_journals'][case]
        check(refs[prefix+'_state']['sha256']==hashes['state_sha256'] and refs[prefix+'_cleanup']['sha256']==hashes['cleanup_sha256'],'ui_resume_old_ui_journal_digest')
        validate_cleaned(data[prefix+'_state'],data[prefix+'_cleanup'],before[case],refs['old_ui_ledger']['sha256'],old_ledger)
    shared_ref={'case_id':SHARED,**refs['old_shared']}
    validate({'schema':'d08-ui-production-outcome/v1','status':'passed','children':[shared_ref]},old_ledger,refs['old_ui_ledger']['sha256'],old_config,manifest,public,root,case_subset={SHARED})
    return {'shared_ref':shared_ref,'old_config':old_config,'old_ledger_hash':refs['old_ui_ledger']['sha256'],'api':old_api,'api_ledger':data['old_api_ledger']}

def inspect_previous(request,c):
    """Đọc journal/API và các danh tính cũ/mới; không gọi endpoint sản phẩm."""
    from outcome_receipt import validate_api
    binding=request['acceptance_binding'];spec=validate_spec(binding,request.get('acceptance_ui_resume'))
    c.validate(request)
    path=c.acceptance_path(binding)
    check(request['run_id']==binding['acceptance_run_id'],'ui_resume_run_mismatch')
    old_raw=path.read_bytes();check(cas.sha(old_raw)==spec['executor_sha256'],'ui_resume_executor_changed')
    state=json.loads(old_raw)
    check(state.get('generation')==4 and state.get('status')=='api_passed' and state.get('binding')==spec['previous_binding'],'ui_resume_executor_binding_wrong')
    check(sender_stopped(state.get('pid')),'ui_resume_old_pid_alive')
    journal_path=c.r.RELEASE_ROOT/request['run_id']/'canary.generation-3.json'
    raw=journal_path.read_bytes();check(cas.sha(raw)==spec['journal_sha256'],'ui_resume_api_journal_changed')
    journal=json.loads(raw);api=request['api_receipt']
    check(journal.get('status')=='passed_api_database' and journal.get('runtime_unchanged') is True and journal.get('before')==journal.get('after')==api.get('before')==api.get('after')==request['expected'] and journal.get('receipts')==api.get('receipts'),'ui_resume_api_journal_not_passed')
    check([{k:i[k] for k in ('name','attempt_id','marker','course_id','student_id')} for i in journal['identities']]==[{k:i[k] for k in ('name','attempt_id','marker','course_id','student_id')} for i in request['identities']],'ui_resume_api_identity_changed')
    validate_api(api,{'identities':request['identities']},request['manifest'])
    old_source=request['old_ui_ledger_source'];new_source=request['ui_ledger_source']
    check(cas.sha(old_source.encode('utf-8'))==spec['previous_binding']['ui_ledger_sha256'] and cas.sha(new_source.encode('utf-8'))==binding['ui_ledger_sha256'],'ui_resume_ui_ledger_bytes_wrong')
    old=json.loads(old_source);new=json.loads(new_source);before,after=validate_ledgers(old,new,request['manifest'])
    check(not (c.r.RELEASE_ROOT/new['run_id']/'ui-canary-generation-6').exists(),'ui_resume_new_namespace_preexisting')
    for case,entry in before.items():
        folder=c.r.RELEASE_ROOT/old['run_id']/'ui-canary'/case
        if case in spec['old_ui_journals']:
            hashes=spec['old_ui_journals'][case];raw_state=(folder/'state.json').read_bytes();old_state=json.loads(raw_state)
            cleanup_raw=(folder/(str(old_state['sequence'])+'.response.json')).read_bytes()
            check(cas.sha(raw_state)==hashes['state_sha256'] and cas.sha(cleanup_raw)==hashes['cleanup_sha256'],'ui_resume_remote_ui_journal_changed')
            check(not (folder/'executor.lock').exists() and not (folder/'unknown.json').exists(),'ui_resume_remote_ui_unknown')
            validate_cleaned(old_state,json.loads(cleanup_raw),entry,spec['previous_binding']['ui_ledger_sha256'],old)
        else:check(not folder.exists(),'ui_resume_unrun_case_has_journal')
    check(c.r.probe(request['manifest'])==request['expected'],'ui_resume_runtime_changed')
    unique={i['attempt_id']:i for i in request['identities']}
    for entry in list(before.values())+list(after.values()):
        item={'name':entry['destination']['container'],**entry['identity']};unique[item['attempt_id']]=item
    for item in unique.values():
        item=dict(item);item['_database_binding']=c.binding.resolve(item,c.destination)
        schema,_,database=c.destination(item);counts=c.child_expression(schema,item['attempt_id'],item)
        sql=f"BEGIN READ ONLY; DO $$ BEGIN {c.topology_guard_sql(item)} {c.demo_course_guard_sql(item)} END $$; SELECT jsonb_build_object('database',current_database(),'existing',(SELECT count(*) FROM {schema}.term_test_attempt WHERE id='{item['attempt_id']}'::uuid OR class_name_snapshot='{item['marker']}' OR erp_student_contact_id={item['student_id']}{c.course_collision_sql(item)}),'children',({counts}))::text; COMMIT;"
        check(c.admin_query(item,sql)==[{'database':database,'existing':0,'children':0}],'ui_resume_fixture_not_zero')
    return journal,new

def acquire(request,c):
    """CAS4→5 rồi journal bền/gen6; crash sau CAS vẫn khóa, không replay."""
    journal,ledger=inspect_previous(request,c);spec=request['acceptance_ui_resume'];binding=request['acceptance_binding']
    path=c.acceptance_path(binding);out=c.r.RELEASE_ROOT/request['run_id']/'ui-continuation.generation-5.json'
    check(not out.exists(),'ui_resume_continuation_journal_exists')
    next_state={'generation':5,'binding':binding,'status':'ui_continuation_started','pid':os.getpid(),
                'ui_continuation':spec,'ui_ledger':ledger,'expected':request['expected']}
    cas.claim(path,spec['executor_sha256'],4,next_state,lambda state:inspect_previous(request,c))
    try:
        check(c.r.probe(request['manifest'])==request['expected'],'ui_resume_runtime_changed_after_cas')
        value={'status':'passed_api_database','api_reused':True,'api_journal_sha256':spec['journal_sha256'],
               'acceptance_binding':binding,'run_cases':spec['run_cases'],'reuse_cases':spec['reuse_cases'],
               'runtime_unchanged':True,'before':request['expected'],'after':request['expected']}
        cas.save_exclusive(out,value)
        owned=json.loads(path.read_bytes());check(owned==next_state,'ui_resume_owned_pointer_changed')
        cas.replace_durable(path,{**next_state,'generation':6,'status':'api_passed'})
        return value
    except Exception as error:
        if not out.exists():cas.save_exclusive(out,{'status':'unknown','no_seed_sent':True,'error_type':type(error).__name__,'acceptance_binding':binding})
        owned=json.loads(path.read_bytes())
        if owned==next_state:cas.replace_durable(path,{**next_state,'generation':6,'status':'unknown'})
        raise
