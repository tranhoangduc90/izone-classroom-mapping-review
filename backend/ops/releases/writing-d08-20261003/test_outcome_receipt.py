"""Kiểm cổng biên nhận bằng dữ liệu giả; không tạo bằng chứng production.
Thiếu case/client/hash/đích/cleanup hoặc dùng fixture phải bị chặn.
"""
import copy
import datetime
import hashlib
import importlib.util
import json
import tempfile
import shutil
import unittest
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('outcome_receipt', HERE/'outcome_receipt.py')
o = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o)


class OutcomeGuard(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'product_revision': 'fixture-bundle', 'candidate_checkpoint': '1'*40, 'run_id': '2'*32}
        self.manifest = {'targets': [{'name': 'api'+str(i), 'candidate_image': 'image'+str(i)} for i in range(3)]}
        self.snapshots = {'api': 'fixture-only'}
        fixture_spec = importlib.util.spec_from_file_location('browser_fixture', HERE/'test_browser_receipt.py')
        fixture_module = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixture_module)
        fixture = fixture_module.BrowserGuard('test_complete_synthetic_contract')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.config.update(fixture.config)
        self.manifest = fixture.manifest
        self.public = fixture.public
        shutil.copytree(fixture.root, self.root/'browser')
        browser = copy.deepcopy(fixture.aggregate)
        for reference in browser['children']:
            reference['path'] = 'browser/' + reference['path']
        browser_ledger = fixture.ledger

        ledger = {'run_id': '3'*32, 'manifest': self.manifest,
                  'identities': [{'name': t['name'], 'attempt_id': 'fixture-id-'+str(i)} for i,t in enumerate(self.manifest['targets'])]}
        rows = [{'name': t['name'], 'image': t['candidate_image'], 'running': True, 'healthy': 'healthy'} for t in self.manifest['targets']]
        zero = {k: 0 for k in o.CHILDREN}
        receipts = []
        for identity in ledger['identities']:
            identifier = identity['attempt_id']
            core = {'status': 'passed', 'attempt_id': identifier,
                    'receipts': [{'case': c} for c in sorted(o.API_CASES)] + [
                        {'case': 'database_readback', 'value': {'children': zero, 'submitted': False}}],
                    'final': {'revision': 1, 'submitted': False, 'children': zero}}
            receipts.append({'target': identity['name'], 'status': 'passed', 'api_database': core,
                             'cleanup': {'status': 'passed', 'attempt_id': identifier,
                                         'readback': {'attempt_remaining': 0, 'marker_remaining': 0, 'children_remaining': 0}}})
        api = {'status': 'passed_api_database', 'runtime_unchanged': True, 'before': rows, 'after': rows, 'receipts': receipts}
        (self.root/'fixture-trace.zip').write_bytes(b'not-a-real-browser-trace; test-only')
        trace = {'path': 'fixture-trace.zip', 'sha256': hashlib.sha256((self.root/'fixture-trace.zip').read_bytes()).hexdigest()}
        observation = {'status': 'passed', 'product_revision': self.config['product_revision'], 'release_run_id': self.config['run_id'],
                       'snapshots': self.snapshots, 'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       'observations': [{'fixture': True}], 'sources': {'fixture': True}}
        self.data = {'ledger': ledger, 'api_database': api, 'browser': browser,
                     'browser_ledger': browser_ledger, 'docs_boundary': observation, 'attendance_preservation': observation, 'runtime_observation': observation}
        self.value = {'schema_version': 1, 'status': 'passed', **self.config, 'release_run_id': self.config['run_id'],
                      'canary_run_id': ledger['run_id'], 'snapshots': self.snapshots, 'public_assets': self.public,
                      'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cleanup_verified': True}
        self.write()

    def write(self):
        refs = []
        for role, data in self.data.items():
            path = self.root/(role+'.json')
            path.write_text(json.dumps(data, sort_keys=True), encoding='utf-8')
            refs.append({'role': role, 'path': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        self.value['artifacts'] = refs

    def change_browser(self, mutate):
        reference = self.data['browser']['children'][0]
        path = self.root/reference['path']
        child = json.loads(path.read_text(encoding='utf-8'))
        mutate(child)
        path.write_text(json.dumps(child), encoding='utf-8')
        reference['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()

    def validate(self):
        return o.validate(self.value, self.config, self.snapshots, self.public, self.root, self.manifest)

    def test_generic_operational_labels_still_blocked(self):
        with self.assertRaisesRegex(ValueError, 'docs_boundary_schema'):
            self.validate()

    def test_fields_only_old_receipt_blocked(self):
        self.value = {'status': 'passed', 'snapshots': self.snapshots, 'cleanup_verified': True}
        with self.assertRaises(ValueError): self.validate()

    def test_wrong_bundle_blocked(self):
        self.value['product_revision'] = 'other'
        with self.assertRaisesRegex(ValueError, 'revision'): self.validate()

    def test_missing_role_blocked(self):
        self.value['artifacts'].pop()
        with self.assertRaisesRegex(ValueError, 'roles'): self.validate()

    def test_hash_change_blocked(self):
        (self.root/'ledger.json').write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'hash'): self.validate()

    def test_path_escape_blocked(self):
        self.value['artifacts'][0]['path'] = '../outside.json'
        with self.assertRaisesRegex(ValueError, 'escape'): self.validate()

    def test_fixture_cannot_be_production(self):
        self.change_browser(lambda child: child.update({'scope': 'offline_actual_sql'})); self.write()
        with self.assertRaisesRegex(ValueError, 'offline'): self.validate()

    def test_browser_client_missing_blocked(self):
        self.data['browser']['children'].pop(); self.write()
        with self.assertRaisesRegex(ValueError, 'child_set'): self.validate()

    def test_browser_trace_changed_blocked(self):
        child_path = self.root/self.data['browser']['children'][0]['path']
        (child_path.parent/'trace-0.zip').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'hash'): self.validate()

    def test_api_case_missing_blocked(self):
        self.data['api_database']['receipts'][0]['api_database']['receipts'].pop(0); self.write()
        with self.assertRaisesRegex(ValueError, 'cases'): self.validate()

    def test_wrong_database_target_blocked(self):
        self.data['api_database']['before'][0]['image'] = 'other'; self.write()
        with self.assertRaises(ValueError): self.validate()

    def test_cleanup_remaining_blocked(self):
        self.data['api_database']['receipts'][0]['cleanup']['readback']['marker_remaining'] = 1; self.write()
        with self.assertRaisesRegex(ValueError, 'cleanup'): self.validate()

    def test_submit_or_child_blocks(self):
        self.data['api_database']['receipts'][0]['api_database']['final']['submitted'] = True; self.write()
        with self.assertRaisesRegex(ValueError, 'final'): self.validate()

    def test_untimed_outcome_blocked(self):
        self.value['created_at'] = '2026-10-04T06:00:00'
        with self.assertRaisesRegex(ValueError, 'offset'): self.validate()

    def test_future_or_old_outcome_blocked(self):
        for delta in (-25, 1):
            self.value['created_at'] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=delta)).isoformat()
            with self.assertRaisesRegex(ValueError, 'stale_or_future'): self.validate()


if __name__ == '__main__':
    unittest.main(verbosity=2)
