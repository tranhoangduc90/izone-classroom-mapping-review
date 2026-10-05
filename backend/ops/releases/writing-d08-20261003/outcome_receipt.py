"""Đối soát bằng chứng sau phát hành, không thực hiện thao tác ghi.
Nhận bundle, ledger và artifact có hash; kiểm đủ API, giao diện, ranh giới và vận hành.
Thiếu hoặc sai một bằng chứng trả lỗi để D08 giữ unknown, không coi cờ success là đạt.
"""
import importlib.util
import datetime
import hashlib
import json
import re
from canary_remote import child_tables,NAMES
from pathlib import Path

CHILDREN = {'term_test_exam_session', 'term_test_writing_grading_run',
            'term_test_writing_grading_final', 'term_test_writing_planning', 'term_test_portal_sync_job'}
API_CASES = {'start_does_not_change_draft', 'save_newest_two_tasks',
             'stale_base_cannot_overwrite', 'same_snapshot_retry',
             'old_client_missing_base_blocked', 'negative_base_blocked'}
UI_CLIENTS = {'shared', 'k56-shared', 'k56-mini-shared', 'k56-test2-shared'}
ROLES = {'ledger', 'api_database', 'browser', 'browser_ledger', 'docs_boundary',
         'attendance_preservation', 'runtime_observation'}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def artifact(root, reference):
    # File phải nằm trong kho bằng chứng của lần chạy; không nhận đường dẫn ngoài hay symlink.
    filename = reference.get('path', '')
    require(isinstance(filename, str) and filename and not Path(filename).is_absolute(), 'artifact_path_invalid')
    path = root / filename
    require('..' not in Path(filename).parts, 'artifact_path_escape')
    require(path.resolve().is_relative_to(root.resolve()) and path.is_file() and not path.is_symlink(), 'artifact_outside_or_missing')
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == reference.get('sha256'), 'artifact_hash_mismatch')
    return json.loads(raw.decode('utf-8'))


def timestamp(value):
    require(isinstance(value, str) and re.search(r'(Z|[+-]\d\d:\d\d)$', value), 'receipt_time_missing_offset')
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(datetime.timezone.utc)


def zero_children(value, target=NAMES[0]):
    return isinstance(value, dict) and set(value) == set(child_tables({'name':target})) and all(type(n) is int and n == 0 for n in value.values())


def validate_api(value, ledger, manifest):
    require(value.get('status') == 'passed_api_database' and value.get('runtime_unchanged') is True,
            'api_receipt_not_passed')
    require(value.get('before') == value.get('after'), 'api_runtime_changed')
    rows = value.get('before', [])
    require(len(rows) == 3 and [r.get('name') for r in rows] == [t['name'] for t in manifest['targets']], 'api_target_set_mismatch')
    require(all(r.get('image') == t['candidate_image'] and r.get('running') is True and r.get('healthy') == 'healthy'
                for r, t in zip(rows, manifest['targets'])), 'api_image_or_health_mismatch')
    receipts = value.get('receipts', [])
    require(len(receipts) == 3 and [r.get('target') for r in receipts] == [i['name'] for i in ledger['identities']], 'api_receipt_targets_missing')
    for receipt, identity in zip(receipts, ledger['identities']):
        validate_api_receipt(receipt,identity)


def validate_api_receipt(receipt, identity):
    core = receipt.get('api_database', {})
    require(receipt.get('status') == 'passed' and core.get('status') == 'passed'
            and core.get('attempt_id') == identity['attempt_id'], 'api_identity_or_status_mismatch')
    cases = core.get('receipts', [])
    require(API_CASES.issubset({c.get('case') for c in cases}), 'api_cases_missing')
    for case in cases:
        if 'payload' in case:
            require(case['payload'].get('attemptToken') == identity['attempt_id']
                    and case['payload'].get('action') in ('start', 'draft'), 'api_payload_outside_scope')
        if case.get('case') == 'database_readback':
            require(zero_children(case.get('value', {}).get('children'), identity['name'])
                    and case['value'].get('submitted') is False, 'api_readback_children_or_submit')
    final = core.get('final', {})
    require(final.get('revision') == 1 and final.get('submitted') is False
            and zero_children(final.get('children'), identity['name']), 'api_final_not_verified')
    cleanup = receipt.get('cleanup', {})
    require(cleanup.get('status') == 'passed' and cleanup.get('attempt_id') == identity['attempt_id']
            and cleanup.get('readback') == {'attempt_remaining': 0, 'marker_remaining': 0, 'children_remaining': 0},
            'api_cleanup_not_verified')


def validate(value, config, snapshots, public, root, manifest):
    root = Path(root)
    require(value.get('schema_version') == 1 and value.get('status') == 'passed', 'outcome_schema_or_status')
    require(value.get('product_revision') == config['product_revision']
            and value.get('candidate_checkpoint') == config['candidate_checkpoint'], 'outcome_revision_mismatch')
    require(value.get('release_run_id') == config['run_id'] and value.get('snapshots') == snapshots,
            'outcome_run_or_runtime_mismatch')
    require(value.get('public_assets') == public and public.get('status') == 'passed', 'outcome_public_assets_mismatch')
    at = timestamp(value.get('created_at'))
    now = datetime.datetime.now(datetime.timezone.utc)
    require(datetime.timedelta(0) <= now - at <= datetime.timedelta(hours=24), 'outcome_stale_or_future')
    refs = value.get('artifacts', [])
    require(len(refs) == len(ROLES) and {r.get('role') for r in refs} == ROLES, 'outcome_artifact_roles_missing')
    data = {r['role']: artifact(root, r) for r in refs}
    ledger = data['ledger']
    require(ledger.get('run_id') == value.get('canary_run_id') and ledger.get('manifest') == manifest,
            'outcome_ledger_mismatch')
    require(len(ledger.get('identities', [])) == 3, 'outcome_identities_missing')
    validate_api(data['api_database'], ledger, manifest)
    if config.get('acceptance_ui_resume'):
        from ui_acceptance_continuation import validate_provenance
        prior=validate_provenance(config,root,data['browser_ledger'],public,manifest)
        require(data['api_database']==prior['api'] and ledger==prior['api_ledger'],'ui_resume_api_proof_relabelled')
        api_ref=next(r for r in refs if r['role']=='api_database')
        ledger_ref=next(r for r in refs if r['role']=='ledger')
        old_refs=config['ui_resume_provenance']['artifacts']
        require(api_ref['sha256']==old_refs['old_api_database']['sha256'] and ledger_ref['sha256']==old_refs['old_api_ledger']['sha256'],'ui_resume_api_bytes_changed')
    if config.get('acceptance_resume'):
        from acceptance_provenance import validate_reuse
        validate_reuse(config,root,ledger,data['api_database'])
    browser = data['browser']
    browser_ledger_reference = next(r for r in refs if r['role'] == 'browser_ledger')
    spec = importlib.util.spec_from_file_location('browser_receipt', Path(__file__).parent/'browser_receipt.py')
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    checker.validate(browser, data['browser_ledger'], browser_ledger_reference['sha256'],
                     config, manifest, public, root)
    for role in ('docs_boundary', 'attendance_preservation', 'runtime_observation'):
        item = data[role]
        require(item.get('status') == 'passed' and item.get('product_revision') == config['product_revision']
                and item.get('release_run_id') == config['run_id'] and item.get('snapshots') == snapshots,
                role + '_missing_or_wrong_revision')
        timestamp(item.get('captured_at'))
        # Từng loại proof phải có parser riêng đã pin; không nhận observations/boolean chung.
        validator_path = Path(__file__).parent/(role + '_receipt.py')
        require(validator_path.is_file(), role + '_specific_validator_pending')
        spec = importlib.util.spec_from_file_location(role + '_receipt', validator_path)
        checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(checker)
        result = checker.validate(item, config, snapshots, root)
        require(result.get('status') == 'passed', role + '_specific_validator_not_passed')
    require(value.get('cleanup_verified') is True, 'outcome_cleanup_missing')
    return {'status': 'passed', 'checked_artifact_roles': sorted(ROLES)}
