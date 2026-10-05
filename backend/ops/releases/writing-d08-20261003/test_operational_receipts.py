"""Kiểm các cổng bằng fixture riêng, không tạo bằng chứng production.
Đổi đúng một dữ kiện mỗi lần để kiểm thiếu nguồn, sai đích, ghi Portal hoặc log lỗi.
"""
import copy
import datetime
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import attendance_preservation_receipt as attendance
import docs_boundary_receipt as docs
import runtime_observation_receipt as runtime

HERE = Path(__file__).parent


class OperationalGuard(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = datetime.datetime.now(datetime.timezone.utc)
        self.before_time = (self.now - datetime.timedelta(minutes=5)).isoformat()
        self.started = (self.now - datetime.timedelta(minutes=3)).isoformat()
        self.after_time = (self.now - datetime.timedelta(seconds=1)).isoformat()
        self.snapshots = {'api': 'fixture-only'}
        self.config = {'product_revision': 'fixture-only', 'run_id': 'a'*32,
                       'release_started_at': self.started, 'operational_contract': {}}
        self.sequence = 0

    def file(self, value, binary=False):
        self.sequence += 1
        path = self.root/(str(self.sequence)+'.json')
        content = value if binary else json.dumps(value, ensure_ascii=False).encode()
        path.write_bytes(content)
        return {'path': path.name, 'sha256': hashlib.sha256(content).hexdigest()}

    def base(self, role, before, after, contract, extra=None):
        refs = {'before': self.file(before), 'after': self.file(after), **(extra or {})}
        self.config['operational_contract'][role] = {**contract, 'before_sha256': refs['before']['sha256']}
        return {'schema': 'd08-'+role.replace('_', '-')+'/v1', 'status': 'passed',
                'product_revision': self.config['product_revision'], 'release_run_id': self.config['run_id'],
                'captured_at': self.now.isoformat(), 'snapshots': self.snapshots, 'artifacts': refs}

    def change(self, item, role, mutate):
        reference = item['artifacts'][role]
        value = json.loads((self.root/reference['path']).read_text(encoding='utf-8'))
        mutate(value)
        item['artifacts'][role] = self.file(value)

    def doc_fixture(self):
        source = {name: '1'*64 for name in ('writing-flow-stage.js', 'writing-flow-test.js',
                  'writing-flow-test-components.js', 'writing-flow-notifier.js', 'db.js',
                  'service.js', 'writing-flow-crypto.js')}
        url = 'https://script.google.com/macros/s/FIXTURE/exec'
        workflow = {'id': 'KqWtSbjkHDMSAgbN', 'versionId': 'fixture-v1', 'active': True,
                    'settings': {}, 'nodes': [
                        {'name': 'Đây là bài Test cần ghi nhận xét?', 'type': 'n8n-nodes-base.if',
                         'parameters': {'conditions': {'conditions': [{'leftValue': "sourceType === 'term_test'"}]}}},
                        {'name': 'Chuẩn bị ghi nhận xét vào đầu Test', 'type': 'n8n-nodes-base.httpRequest',
                         'parameters': {'url': url}}],
                    'connections': {'Đây là bài Test cần ghi nhận xét?': {'main': [[
                        {'node': 'Chuẩn bị ghi nhận xét vào đầu Test'}]]}}}
        workflows = [workflow if key == workflow['id'] else {**workflow, 'id': key} for key in sorted(docs.WORKFLOWS)]
        api = {'image': 'fixture-image', 'health': 'healthy', 'restart_count': 0,
               'source_hashes': source, 'env_hash': '2'*64}
        writer = {'immutable_version': 11, 'endpoint_matches_unique_deployment': True,
                  'all_profiles_checked': True, 'source_files': {'source.js': '3'*64}}
        snapshot = {'captured_at': self.before_time, 'api': api, 'writer': writer, 'workflows': workflows,
                    'triggers': {'database': 'mapping_db', 'readonly': 'on', 'triggers': [{}]*25},
                    'indirect_closure': {'database': 'mapping_db', 'readonly': 'on',
                                         'functions': [{}]*3, 'audit_rules': [], 'audit_triggers': []}}
        after = {**copy.deepcopy(snapshot), 'captured_at': self.after_time}
        fixture = {'schema': 'd08-docs-boundary-negative-fixture/v1', 'status': 'passed_fixture',
                   'cases': sorted(docs.CASES), 'sources': source, 'triggers_loaded': 25,
                   'trigger_functions_loaded': 3, 'network': [], 'readback': [
                       {'destination': 'google_docs', 'status': 'complete', 'result_url': None, 'readback_ok': True}],
                   'counts': {'portal_jobs': 0, 'lark_jobs': 0, 'portal_writes': 0, 'audit_events': 32}}
        refs = {'fixture': self.file(fixture), 'fixture_log': self.file({'status': 'passed_fixture', 'cases': 8, **fixture['counts']})}
        contract = {'image': api['image'], 'source_hashes': source, 'env_hash': api['env_hash'],
                    'writer_version': 11, 'writer_sources': writer['source_files'], 'fixture_sources': source,
                    'writer_endpoint_sha256': hashlib.sha256(url.encode()).hexdigest(),
                    'fixture_sha256': refs['fixture']['sha256'], 'fixture_log_sha256': refs['fixture_log']['sha256']}
        return self.base('docs_boundary', snapshot, after, contract, refs)

    def attendance_fixture(self):
        targets = []
        for name in attendance.TARGETS:
            enabled = name == attendance.TARGETS[0]
            targets.append({'name': name, 'image': 'candidate-'+name, 'running': True,
                            'health': 'healthy', 'restart_count': 0, 'learning_enabled': enabled,
                            'attendance_environment': {k: {'present': enabled, 'sha256': '1'*64} for k in attendance.ENV},
                            'worker_sources': {'server.js': '2'*64}, 'observation': {
                                'database': 'izone_mapping_demo' if name == attendance.TARGETS[2] else 'mapping_db',
                                'role': 'fixture-role', 'read_only': 'on', 'queue': {
                                    'job_type': 'sync_portal_attendance', 'expired_leases': 0, 'review_required': 0,
                                    'queued': 0, 'processing': 0, 'retry_wait': 0, 'failed': 0, 'complete': 102,
                                    'total': 102, 'unknown_statuses': 0}}})
        names = ('Nhận yêu cầu điểm danh', 'Đọc trạng thái lớp trên Portal', 'Chọn đúng buổi và quyết định',
                 'Trả kết quả cho Progress Log')
        workflow = {'id': 'gnk0f2qZlKr1mIES', 'versionId': 'fixture-v1', 'active': True,
                    'nodes': [{'name': n, 'type': 'fixture', 'parameters': {}} for n in names],
                    'connections': {}, 'settings': {}}
        before = {'captured_at': self.before_time, 'targets': targets, 'workflow': workflow}
        after = {**copy.deepcopy(before), 'captured_at': self.after_time}
        body = {**{key: 'fixture-'+key for key in attendance.IDENTITY}, 'commit': False}
        returned = {**{key: body[key] for key in attendance.IDENTITY}, 'status': 'conflict', 'ok': True}
        rows = [{'body': body}, {'fixture': True}, {'status': 'conflict', 'needsWrite': False}, returned]
        runs = {n: [{'data': {'main': [[{'json': row}]]}}] for n, row in zip(names, rows)}
        execution = {'workflowId': workflow['id'], 'workflowData': workflow, 'finished': True, 'status': 'success',
                     'startedAt': self.started, 'stoppedAt': self.after_time, 'data': {'resultData': {'runData': runs}}}
        refs = {'request': self.file({'packet': {'preview': {'body': body}}}),
                'response': self.file({'httpStatus': 200, 'response': returned, 'commit': False}),
                'execution': self.file(execution)}
        contract = {'candidate_images': {t['name']: t['image'] for t in targets},
                    'worker_sources': {t['name']: t['worker_sources'] for t in targets}}
        return self.base('attendance_preservation', before, after, contract, refs)

    def runtime_fixture(self):
        names = list(attendance.TARGETS)
        before = {'captured_at': self.before_time,
                  'targets': [{'name': name, 'config_hash': '1'*64} for name in names]}
        parser_sha = hashlib.sha256((HERE/'runtime_observation_receipt.py').read_bytes()).hexdigest()
        contract = {'target_names': names, 'candidate_images': {n: 'candidate-'+n for n in names},
                    'source_hashes': {n: {'server.js': '2'*64} for n in names},
                    'log_parser_sha256': parser_sha, 'minimum_observation_seconds': 60}
        observations = []
        for seconds in (120, 60, 1):
            at = (self.now - datetime.timedelta(seconds=seconds)).isoformat()
            targets = []
            for name in names:
                targets.append({'name': name, 'image': 'candidate-'+name, 'running': True,
                                'healthy': 'healthy', 'restart_count': 0, 'oom_killed': False,
                                'source_hashes': {'server.js': '2'*64}, 'config_hash': '1'*64,
                                'activity': {'listening': 0, 'reading': 0, 'writing': 0}, 'log_window': {
                                    'start': self.started, 'end': at, 'truncated': False,
                                    'error_count': 0, 'transport_exit_code': 0, 'parser_sha256': parser_sha,
                                    'artifact': self.file((at+' {"level":"info","message":"fixture only"}\n').encode(), True)}})
            observations.append({'captured_at': at, 'targets': targets})
        after = {'captured_at': self.after_time, 'observations': observations}
        return self.base('runtime_observation', before, after, contract)

    def validate(self, module, item):
        return module.validate(item, self.config, self.snapshots, self.root)

    def test_complete_docs_synthetic_contract(self):
        self.assertEqual(self.validate(docs, self.doc_fixture())['status'], 'passed')

    def test_complete_attendance_synthetic_contract(self):
        result = self.validate(attendance, self.attendance_fixture())
        self.assertEqual(result['status'], 'passed')
        self.assertFalse(result['new_attendance_job_verified'])

    def test_complete_runtime_synthetic_contract(self):
        self.assertEqual(self.validate(runtime, self.runtime_fixture())['status'], 'passed')

    def test_common_contract_rejections(self):
        for module, factory in ((docs, self.doc_fixture), (attendance, self.attendance_fixture), (runtime, self.runtime_fixture)):
            for mutation in ('schema', 'run', 'time', 'hash', 'baseline', 'contract', 'path'):
                with self.subTest(module=module.__name__, mutation=mutation):
                    item = factory()
                    if mutation == 'schema': item['schema'] = 'generic-passed'
                    if mutation == 'run': item['release_run_id'] = 'other'
                    if mutation == 'time': item['captured_at'] = '2026-10-04T01:00:00'
                    if mutation == 'hash': item['artifacts']['after']['sha256'] = '0'*64
                    if mutation == 'baseline': item['artifacts']['before'] = item['artifacts']['after']
                    if mutation == 'contract': self.config['operational_contract'] = {}
                    if mutation == 'path': item['artifacts']['after']['path'] = '../outside.json'
                    with self.assertRaises((ValueError, KeyError)): self.validate(module, item)

    def test_docs_preservation_rejections(self):
        for key in ('api', 'writer', 'triggers', 'indirect_closure', 'workflows'):
            with self.subTest(key=key):
                item = self.doc_fixture()
                self.change(item, 'after', lambda v: v.update({key: {}}))
                with self.assertRaises((ValueError, KeyError, TypeError)): self.validate(docs, item)

    def test_docs_fixture_pin_cannot_be_replaced_by_labels(self):
        item = self.doc_fixture()
        self.change(item, 'fixture', lambda v: v['counts'].update({'portal_writes': 1}))
        with self.assertRaisesRegex(ValueError, 'fixture_pin'): self.validate(docs, item)

    def test_docs_endpoint_contract_wrong(self):
        item = self.doc_fixture()
        self.config['operational_contract']['docs_boundary']['writer_endpoint_sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'endpoint'): self.validate(docs, item)

    def test_docs_writer_version_must_match_reviewed_contract(self):
        item = self.doc_fixture()
        self.config['operational_contract']['docs_boundary']['writer_version'] = 19
        with self.assertRaisesRegex(ValueError, 'writer_identity'): self.validate(docs, item)

    def test_attendance_changed_secret_or_target(self):
        for mutation in ('secret', 'database', 'image', 'worker', 'queue'):
            with self.subTest(mutation=mutation):
                item = self.attendance_fixture()
                def change(v):
                    row = v['targets'][0]
                    if mutation == 'secret': row['attendance_environment']['ERP_SYNC_SECRET']['sha256'] = '0'*64
                    if mutation == 'database': row['observation']['database'] = 'other'
                    if mutation == 'image': row['image'] = 'other'
                    if mutation == 'worker': row['worker_sources']['server.js'] = '0'*64
                    if mutation == 'queue': row['observation']['queue']['expired_leases'] = 1
                self.change(item, 'after', change)
                with self.assertRaises(ValueError): self.validate(attendance, item)

    def test_attendance_write_node_is_not_readonly(self):
        item = self.attendance_fixture()
        self.change(item, 'execution', lambda v: v['data']['resultData']['runData'].update({'Ghi có mặt vào Portal': [{}]}))
        with self.assertRaisesRegex(ValueError, 'executed_write'): self.validate(attendance, item)

    def test_attendance_incomplete_queue_counts_do_not_hide_failure(self):
        for key in ('failed', 'total', 'unknown_statuses'):
            with self.subTest(key=key):
                item = self.attendance_fixture()
                self.change(item, 'after', lambda v: v['targets'][0]['observation']['queue'].update({key: 1}))
                with self.assertRaisesRegex(ValueError, 'queue_counts'): self.validate(attendance, item)

    def test_attendance_commit_true_blocks(self):
        item = self.attendance_fixture()
        self.change(item, 'request', lambda v: v['packet']['preview']['body'].update({'commit': True}))
        with self.assertRaisesRegex(ValueError, 'readonly_request'): self.validate(attendance, item)

    def test_attendance_identity_or_source_change_blocks(self):
        for mutation in ('identity', 'source', 'time', 'status'):
            with self.subTest(mutation=mutation):
                item = self.attendance_fixture()
                def change(v):
                    if mutation == 'identity':
                        v['data']['resultData']['runData']['Trả kết quả cho Progress Log'][0]['data']['main'][0][0]['json']['studentId'] = 'other'
                    if mutation == 'source': v['workflowData']['nodes'][0]['parameters']['unknown'] = True
                    if mutation == 'time': v['startedAt'] = self.before_time
                    if mutation == 'status': v['status'] = 'error'
                self.change(item, 'execution', change)
                with self.assertRaises(ValueError): self.validate(attendance, item)

    def test_runtime_state_rejections(self):
        for mutation in ('restart', 'config', 'source', 'health', 'oom', 'activity', 'log'):
            with self.subTest(mutation=mutation):
                item = self.runtime_fixture()
                def change(v):
                    row = v['observations'][0]['targets'][0]
                    if mutation == 'restart': row['restart_count'] = 1
                    if mutation == 'config': row['config_hash'] = '0'*64
                    if mutation == 'source': row['source_hashes']['server.js'] = '0'*64
                    if mutation == 'health': row['healthy'] = 'unhealthy'
                    if mutation == 'oom': row['oom_killed'] = True
                    if mutation == 'activity': row['activity']['writing'] = -1
                    if mutation == 'log': row['log_window']['truncated'] = True
                self.change(item, 'after', change)
                with self.assertRaises(ValueError): self.validate(runtime, item)

    def test_runtime_short_window_blocks(self):
        item = self.runtime_fixture()
        self.change(item, 'after', lambda v: v.update({'observations': [v['observations'][-1]]*3}))
        with self.assertRaisesRegex(ValueError, 'too_short'): self.validate(runtime, item)

    def test_runtime_raw_error_not_hidden_by_zero_label(self):
        item = self.runtime_fixture()
        def change(v):
            row = v['observations'][0]['targets'][0]
            row['log_window']['artifact'] = self.file((v['observations'][0]['captured_at']+' {"level":"error"}\n').encode(), True)
        self.change(item, 'after', change)
        with self.assertRaisesRegex(ValueError, 'count_mismatch'): self.validate(runtime, item)

    def test_runtime_log_unparseable_blocks(self):
        for content in (b'no timestamp\n', b'2026-10-01T00:00:00Z old\n', b'\xff'):
            with self.subTest(content=content):
                item = self.runtime_fixture()
                self.change(item, 'after', lambda v: v['observations'][0]['targets'][0]['log_window'].update({'artifact': self.file(content, True)}))
                with self.assertRaises((ValueError, UnicodeError)): self.validate(runtime, item)


if __name__ == '__main__':
    unittest.main(verbosity=2)
