"""Kiểm nguồn Mapping cũ trước tái dùng; không đổi nhãn aggregate unknown cũ.
Mỗi artifact có hash, UUID, runtime, helper và gói đã duyệt riêng.
"""
import hashlib
import json
from pathlib import Path
from canary_remote import NAMES
from outcome_receipt import artifact,require,validate_api_receipt

ROLES={'old_plan','old_approval','old_config','old_ledger','old_api_database','old_executor','old_journal'}
SOURCES={'canary_contract.mjs','canary_remote.py','canary_producer.py'}

def canonical_sha(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()

def validate_prior(config,root,ledger,expected):
    root=Path(root);spec=config['acceptance_resume'];proof=config.get('api_resume_provenance',{})
    refs=proof.get('artifacts',{})
    require(set(refs)==ROLES,'reuse_artifact_roles_missing')
    data={role:artifact(root,reference) for role,reference in refs.items()}
    plan=data['old_plan'];approval=data['old_approval'];old_config=data['old_config']
    require(plan.get('plan_digest')==canonical_sha({k:v for k,v in plan.items() if k!='plan_digest'}),'reuse_old_plan_digest_invalid')
    require(plan['plan_digest']==spec['approved_package_digest']==approval.get('plan_digest') and approval.get('acceptance_authorized') is True and approval.get('production_authorized') is True,'reuse_old_approval_invalid')
    require(refs['old_config']['sha256']==plan['checked_inputs'].get(plan.get('config')),'reuse_old_config_bytes_unapproved')
    old_ledger_path=str(Path(old_config['evidence_dir'])/'production-canary-ledger.json')
    require(refs['old_ledger']['sha256']==plan['checked_inputs'].get(old_ledger_path),'reuse_old_ledger_bytes_unapproved')
    require(plan.get('helper_checkpoint')==old_config.get('candidate_checkpoint')==proof.get('helper_checkpoint') and plan.get('runtime_checkpoint')==config.get('runtime_candidate_checkpoint')==old_config.get('runtime_candidate_checkpoint'),'reuse_source_checkpoint_invalid')
    require(old_config.get('acceptance_binding')==plan.get('acceptance_binding')==spec['previous_binding'],'reuse_old_binding_invalid')
    require(old_config.get('run_id')==config['run_id'] and old_config.get('product_revision')==config['product_revision'],'reuse_release_revision_invalid')
    previous=data['old_executor']
    require(refs['old_executor']['sha256']==spec['executor_sha256'] and previous.get('generation')==2 and previous.get('status')=='unknown' and previous.get('binding')==spec['previous_binding'],'reuse_executor_invalid')
    journal=data['old_journal'];api=data['old_api_database'];old_ledger=data['old_ledger']
    require(refs['old_journal']['sha256']==spec['journal_sha256'],'reuse_journal_digest_invalid')
    require(journal.get('status')==api.get('status')=='unknown' and journal.get('runtime_unchanged') is True and api.get('runtime_unchanged') is True and journal.get('before')==journal.get('after')==api.get('before')==api.get('after')==expected,'reuse_runtime_invalid')
    require(api.get('snapshots')==plan.get('expected_after'),'reuse_old_snapshot_unapproved')
    require(old_ledger.get('run_id')==ledger.get('run_id')==config['acceptance_binding']['acceptance_run_id'] and old_ledger.get('identities')==ledger.get('identities') and old_ledger.get('manifest')==ledger.get('manifest'),'reuse_ledger_invalid')
    require(old_ledger.get('acceptance_binding')==spec['previous_binding'] and ledger.get('acceptance_binding')==config['acceptance_binding'],'reuse_ledger_binding_invalid')
    require(len(journal.get('receipts',[]))==len(api.get('receipts',[]))==2 and journal['receipts']==api['receipts'],'reuse_receipts_changed')
    receipt=journal['receipts'][0]
    require(receipt.get('target')==NAMES[0] and canonical_sha(receipt)==spec['reuse_receipt_sha256'],'reuse_mapping_receipt_invalid')
    validate_api_receipt(receipt,ledger['identities'][0])
    # Nội dung producer cũ được giữ riêng; hash phải có trong đúng gói cũ đã duyệt.
    sources=proof.get('sources',{});require(set(sources)==SOURCES and set(api.get('producer_sources',{}))==SOURCES,'reuse_producer_sources_missing')
    for name,reference in sources.items():
        filename=reference.get('path','');path=root/filename
        require(isinstance(filename,str) and filename and not Path(filename).is_absolute() and '..' not in Path(filename).parts and path.resolve().is_relative_to(root.resolve()) and path.is_file() and not path.is_symlink(),'reuse_source_path_invalid')
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        require(digest==reference.get('sha256')==api['producer_sources'][name] and plan['checked_inputs'].get(reference.get('original_path'))==digest,'reuse_producer_source_mismatch')
    return receipt

def validate_reuse(config,root,ledger,value):
    receipt=validate_prior(config,root,ledger,value['before'])
    require(value.get('acceptance_resume')==config['acceptance_resume'] and value['receipts'][0]==receipt,'reuse_aggregate_changed')
    spec=config['acceptance_resume'];expected={name:({'epoch':'reused','journal_sha256':spec['journal_sha256'],'receipt_sha256':spec['reuse_receipt_sha256']} if index==0 else {'epoch':'current','acceptance_digest':config['acceptance_binding']['acceptance_digest']}) for index,name in enumerate(NAMES)}
    require(value.get('receipt_provenance')==expected,'reuse_target_provenance_invalid')
    old_api=artifact(Path(root),config['api_resume_provenance']['artifacts']['old_api_database'])
    require(value.get('snapshots')==old_api.get('snapshots'),'reuse_runtime_revision_mismatch')
    require(value.get('producer_sources')==config.get('api_current_producer_sources') and set(value.get('producer_sources',{}))==SOURCES,'current_producer_sources_invalid')
    return {'status':'passed','reused_target':NAMES[0],'new_targets':list(NAMES[1:])}
