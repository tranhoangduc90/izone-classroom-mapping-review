"""Kiểm ranh giới Test Google Docs trước/sau phát hành bằng nguồn và SQL giả.
Nhận snapshot API, workflow, Apps Script và trigger; xác nhận không mở writer khác.
Không chạy lại D03/E03 và không dùng fixture thay kết quả bài học viên.
"""
import hashlib
from operational_receipt import context, hashes, need, raw, read, workflow_equal

WORKFLOWS = {'WKTYNc49hZQJqebU', 'wZyYaiH3nJ77JSja', 'zxSd0xBPJzMqQlWt',
             'KqWtSbjkHDMSAgbN', '5nuFIICMYwh6C50v', 'G9FweE3mZo8eaSAe'}
CASES = {'delivery_google_docs_only', 'equal_replay_no_duplicate', 'wrong_doc_rolls_back',
         'wrong_report_hash_rolls_back', 'external_result_url_rejected',
         'group_complete_only_after_all_tasks', 'completed_docs_not_notified_again',
         'live_audit_triggers_no_external_writer'}


def validate(item, config, snapshots, root):
    contract, refs, before, after = context(item, config, snapshots, root, 'docs_boundary')
    need(set(refs) == {'before', 'after', 'fixture', 'fixture_log'}, 'docs_artifact_set')
    for key in ('api', 'writer', 'triggers', 'indirect_closure'):
        need(before[key] == after[key], 'docs_preservation_' + key)
    api = after['api']
    need(api['image'] == contract['image'] and api['health'] == 'healthy'
         and api['restart_count'] == 0 and hashes(api['source_hashes'])
         and api['source_hashes'] == contract['source_hashes'], 'docs_api_runtime')
    need(api['env_hash'] == contract['env_hash'], 'docs_api_environment')
    old = {w['id']: w for w in before['workflows']}
    new = {w['id']: w for w in after['workflows']}
    need(len(before['workflows']) == len(after['workflows']) == 6
         and set(old) == set(new) == WORKFLOWS, 'docs_workflow_set')
    for key in sorted(WORKFLOWS):
        workflow_equal(old[key], new[key])
    writer = after['writer']
    need(type(writer['immutable_version']) is int and writer['immutable_version'] > 0
         and writer['immutable_version'] == contract['writer_version']
         and writer['endpoint_matches_unique_deployment'] is True
         and writer['all_profiles_checked'] is True and hashes(writer['source_files'])
         and writer['source_files'] == contract['writer_sources'], 'docs_writer_identity')
    catalog, closure = after['triggers'], after['indirect_closure']
    need(catalog['database'] == closure['database'] == 'mapping_db'
         and catalog['readonly'] == closure['readonly'] == 'on'
         and len(catalog['triggers']) == 25 and len(closure['functions']) == 3
         and closure['audit_rules'] == closure['audit_triggers'] == [], 'docs_trigger_closure')
    workflow = new['KqWtSbjkHDMSAgbN']
    nodes = {n['name']: n for n in workflow['nodes']}
    branch = 'Đây là bài Test cần ghi nhận xét?'
    condition = nodes[branch]['parameters']['conditions']['conditions'][0]['leftValue']
    need("sourceType === 'term_test'" in condition, 'docs_test_condition')
    entry = workflow['connections'][branch]['main'][0][0]['node']
    need(entry == 'Chuẩn bị ghi nhận xét vào đầu Test', 'docs_test_entry')
    reached, pending, writers = set(), [entry], 0
    while pending:
        name = pending.pop()
        if name in reached:
            continue
        reached.add(name)
        node = nodes[name]
        need(node['type'] != 'n8n-nodes-base.executeWorkflow', 'docs_child_writer_reachable')
        if node['type'] == 'n8n-nodes-base.httpRequest':
            url = node['parameters']['url']
            is_docs = url.startswith('https://script.google.com/macros/s/')
            is_stage = url.startswith('http://writing-task1-practice-api:8790/api/v1/internal/writing-flow/stages/')
            need(is_docs or is_stage, 'docs_external_writer_reachable')
            if is_docs:
                need(hashlib.sha256(url.encode()).hexdigest() == contract['writer_endpoint_sha256'],
                     'docs_writer_endpoint_changed')
                writers += 1
        for groups in workflow['connections'].get(name, {}).values():
            for group in groups:
                pending.extend(edge['node'] for edge in group)
    need(writers == 1, 'docs_writer_count')
    fixture = read(root, refs['fixture'])
    need(refs['fixture']['sha256'] == contract['fixture_sha256']
         and refs['fixture_log']['sha256'] == contract['fixture_log_sha256'], 'docs_fixture_pin')
    log = read(root, refs['fixture_log'])
    need(fixture['schema'] == 'd08-docs-boundary-negative-fixture/v1'
         and fixture['status'] == 'passed_fixture' and set(fixture['cases']) == CASES
         and len(fixture['cases']) == 8 and fixture['sources'] == contract['fixture_sources']
         and all(api['source_hashes'].get(k) == v for k, v in fixture['sources'].items()), 'docs_fixture_source_or_cases')
    need(fixture['readback'] == [{'destination': 'google_docs', 'status': 'complete',
                                'result_url': None, 'readback_ok': True}], 'docs_destination_readback')
    counts = fixture['counts']
    need(all(type(counts[k]) is int and counts[k] == 0 for k in ('portal_jobs', 'lark_jobs', 'portal_writes'))
         and type(counts['audit_events']) is int and counts['audit_events'] > 0
         and fixture['network'] == [] and fixture['triggers_loaded'] == 25
         and fixture['trigger_functions_loaded'] == 3, 'docs_negative_writer_readback')
    need(log == {'status': 'passed_fixture', 'cases': 8, **counts}, 'docs_fixture_log')
    return {'status': 'passed', 'scope': 'unchanged_docs_boundary_with_separate_negative_sql_fixture',
            'student_docs_reexecuted': False, 'workflows_checked': 6}
