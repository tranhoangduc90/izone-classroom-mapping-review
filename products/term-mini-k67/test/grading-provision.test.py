"""Kiểm graph/ý định dựng K67; API giả, không tạo workflow hoặc đọc secret."""
from pathlib import Path
import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
import ast
import io

spec = importlib.util.spec_from_file_location('provision', Path(__file__).resolve().parents[1] / 'tools/provision-grading-bundle.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def source(key, children=(), profile='default'):
    return {'profile': profile, 'workflow': {'id': key, 'nodes': [
        {'type': 'n8n-nodes-base.executeWorkflow', 'parameters': {'workflowId': {'value': child}}} for child in children]}}


class ProvisionSafety(unittest.TestCase):
    def test_reconcile_receipt_saved_before_state_failure_resumes_same_evidence(self):
        # Evidence đã ghi nhưng state chưa lưu: đọc lại cùng receipt và API, không create mới.
        with tempfile.TemporaryDirectory() as tmp:
            location=Path(tmp)
            candidate={'name':'K67 test','nodes':[],'connections':{},'settings':p.SETTINGS}
            path=location/'candidate-newrole.private.json'
            p.write(path,candidate)
            at=datetime.now(timezone.utc)-timedelta(seconds=10)
            attempt='a'*32
            state={'source_ids':['oldsource'],'created':{},'pending':{'operation':'create','profile':'default','key':'newrole','name':candidate['name'],
                'candidate_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'attempt_id':attempt,'at':at.isoformat()}}
            state_path=location/'state.json'
            p.write(state_path,state)
            base=location/('create-newrole-'+attempt)
            Path(str(base)+'.stdout.log').write_text('',encoding='utf-8')
            Path(str(base)+'.stderr.log').write_text('error: n8n API request failed: getaddrinfo ENOTFOUND ducizone.ddns.net (ENOTFOUND)\nhint: Check that N8N_HOST is reachable and your network is up.',encoding='utf-8')
            real_write=p.write
            def fail_state(path,value):
                if path==state_path: raise RuntimeError('STATE_WRITE_LOST')
                real_write(path,value)
            with patch.object(p,'PRIVATE',location),patch.object(p,'STATE',state_path),patch.object(p,'ctl',return_value=[]),patch.object(p,'write',side_effect=fail_state):
                with self.assertRaisesRegex(RuntimeError,'STATE_WRITE_LOST'): p.reconcile(state)
            receipt=location/('reconciled-'+attempt+'.json')
            before=receipt.read_bytes()
            state=json.loads(state_path.read_text(encoding='utf-8'))
            with patch.object(p,'PRIVATE',location),patch.object(p,'STATE',state_path),patch.object(p,'ctl',return_value=[]) as api:
                p.reconcile(state)
            self.assertEqual(receipt.read_bytes(),before)
            self.assertNotIn('pending',json.loads(state_path.read_text(encoding='utf-8')))
            self.assertEqual(api.call_count,1)

    def test_reconcile_dns_absence_and_created_body_without_create_api(self):
        for exists in [False, True]:
            with self.subTest(exists=exists), tempfile.TemporaryDirectory() as tmp:
                location = Path(tmp)
                candidate = {'name':'K67 test','nodes':[], 'connections':{}, 'settings':p.SETTINGS}
                path = location/'candidate-newrole.private.json'
                p.write(path, candidate)
                at = datetime.now(timezone.utc)-timedelta(seconds=10)
                attempt = 'a'*32
                intent = {'operation':'create','profile':'default','key':'newrole','name':candidate['name'],
                          'candidate_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'attempt_id':attempt,'at':at.isoformat()}
                state = {'source_ids':['oldsource'], 'created':{}, 'pending':intent}
                base = location/('create-newrole-'+attempt)
                Path(str(base)+'.stdout.log').write_text('',encoding='utf-8')
                Path(str(base)+'.stderr.log').write_text('error: n8n API request failed: getaddrinfo ENOTFOUND ducizone.ddns.net (ENOTFOUND)\nhint: Check that N8N_HOST is reachable and your network is up.\n',encoding='utf-8')
                observed = {**candidate, 'id':'newk67id123', 'active':False, 'createdAt':datetime.now(timezone.utc).isoformat()}
                returns = [[observed],observed] if exists else [[]]
                with patch.object(p,'PRIVATE',location), patch.object(p,'STATE',location/'state.json'), \
                     patch.object(p,'ctl',side_effect=returns) as api:
                    p.reconcile(state)
                self.assertNotIn('pending',state)
                self.assertEqual(state['last_reconciliation']['status'],'created_readback' if exists else 'not_created_dns_failure')
                self.assertEqual([call.args[1:3] for call in api.call_args_list], [('workflow','list'),('workflow','get')] if exists else [('workflow','list')])
                if exists: self.assertEqual(state['created']['newrole']['id'],'newk67id123')

    def test_reconcile_unknown_stale_ambiguous_and_mismatched_identity_stay_pending(self):
        for fault in ['timeout','stale','duplicate','different-body','old-created-at','active','changed-candidate']:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                location=Path(tmp)
                candidate={'name':'K67 test','nodes':[], 'connections':{}, 'settings':p.SETTINGS}
                path=location/'candidate-newrole.private.json'
                p.write(path,candidate)
                at=datetime.now(timezone.utc)-timedelta(seconds=10)
                attempt='a'*32
                state={'source_ids':['oldsource'],'created':{},'pending':{'operation':'create','profile':'default','key':'newrole',
                    'name':candidate['name'],'candidate_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'attempt_id':attempt,'at':at.isoformat()}}
                base=location/('create-newrole-'+attempt)
                stdout=Path(str(base)+'.stdout.log')
                stderr=Path(str(base)+'.stderr.log')
                stdout.write_text('',encoding='utf-8')
                stderr.write_text('timeout' if fault=='timeout' else 'error: n8n API request failed: getaddrinfo ENOTFOUND ducizone.ddns.net (ENOTFOUND)\nhint: Check that N8N_HOST is reachable and your network is up.',encoding='utf-8')
                if fault=='stale': os.utime(stderr,(at.timestamp()-5,at.timestamp()-5))
                if fault=='changed-candidate': p.write(path,{**candidate,'nodes':[{}]})
                observed={**candidate,'id':'newk67id123','active':fault=='active','createdAt':datetime.now(timezone.utc).isoformat()}
                if fault=='different-body': observed['nodes']=[{'unexpected':True}]
                if fault=='old-created-at': observed['createdAt']=(at-timedelta(seconds=10)).isoformat()
                inventory=[] if fault in ['timeout','stale','changed-candidate'] else [observed]* (2 if fault=='duplicate' else 1)
                with patch.object(p,'PRIVATE',location), patch.object(p,'STATE',location/'state.json'), \
                     patch.object(p,'ctl',side_effect=[inventory,observed]) as api:
                    with self.assertRaises(RuntimeError): p.reconcile(state)
                self.assertIn('pending',state)
                self.assertFalse(state['created'])
                self.assertFalse(any(call.args[2]=='deploy' for call in api.call_args_list))

    def test_stage_failure_not_masked_by_closed_idle_ssh(self):
        # Giả lập DNS lỗi sau lượt dựng dài; kết nối đọc guard cũ đã đóng.
        with tempfile.TemporaryDirectory() as tmp:
            location = Path(tmp)
            p.write(location/'state.json', {'product_id':'PRODUCT-TERM-MINI-K67','source_ids':[], 'created':{}})
            stale = SimpleNamespace(close=lambda: None)
            fresh = SimpleNamespace(close=lambda: None)
            def protected(client):
                if client is stale and protected.seen:
                    raise RuntimeError('IDLE_SSH_CLOSED')
                protected.seen = True
                return {'shared':'unchanged'}
            protected.seen = False
            fixture = SimpleNamespace(connect=lambda: stale, protected=protected)
            connects = iter([stale,fresh])
            fixture.connect = lambda: next(connects)
            fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
            with patch.object(p,'PRIVATE',location), patch.object(p,'STATE',location/'state.json'), \
                 patch.object(p,'sources',return_value=[]), patch.object(p,'call',return_value=b'v24.15.0'), \
                 patch.object(p,'resolve'), patch.object(p,'source_versions',return_value={}), \
                 patch.object(p,'deploy',side_effect=RuntimeError('CLI_ENOTFOUND')), \
                 patch.object(p.importlib.util,'spec_from_file_location',return_value=fake_spec), \
                 patch.object(p.importlib.util,'module_from_spec',return_value=fixture), \
                 patch.object(p.sys,'argv',['provision','--deploy-inactive']):
                with self.assertRaisesRegex(RuntimeError,'^CLI_ENOTFOUND$'): p.main()
            import json
            audit = json.loads(next(location.glob('protected-*.json')).read_text(encoding='utf-8'))
            self.assertEqual(audit['after'], audit['before'])
            self.assertEqual(audit['operation_error'],'CLI_ENOTFOUND')
            self.assertEqual(audit['outcome'],'failure')

    def test_leaf_ids_ready_before_parent(self):
        rows = [source('parent', ['middle', 'leaf']), source('middle', ['leaf']), source('leaf')]
        self.assertEqual(p.dependencies(rows), ['leaf', 'middle', 'parent'])

    def test_outside_cross_instance_and_cycle_stop(self):
        for rows in [[source('a', ['missing'])], [source('a', ['b']), source('b', profile='izone-ai')],
                     [source('a', ['b']), source('b', ['a'])], [source('a'), source('a')]]:
            with self.subTest(rows=rows), self.assertRaises(RuntimeError): p.dependencies(rows)

    def test_lost_ack_keeps_intent_and_next_call_does_not_create(self):
        state = {'created': {}, 'source_ids': ['oldsource']}
        candidate = {'name': 'K67 test'}
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'PRIVATE', Path(tmp)), patch.object(p, 'STATE', Path(tmp)/'state.json'), \
             patch.object(p, 'validate'), patch.object(p, 'ctl', side_effect=RuntimeError('CLI_TIMEOUT_OUTCOME_UNKNOWN')) as api:
            with self.assertRaisesRegex(RuntimeError, 'OUTCOME_UNKNOWN'): p.create(state, 'default', 'newrole', candidate)
            self.assertEqual(state['pending']['key'], 'newrole')
            with self.assertRaisesRegex(RuntimeError, 'RECONCILE_FIRST'): p.create(state, 'default', 'newrole', candidate)
            self.assertEqual(api.call_count, 1)

    def test_registration_failure_resumes_same_id_without_second_create(self):
        state = {'created': {}, 'source_ids': ['oldsource']}
        candidate = {'name': 'K67 test', 'nodes': [], 'connections': {}, 'settings': p.SETTINGS}
        observed = {**candidate, 'id': 'newk67id123', 'active': False}
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'PRIVATE', Path(tmp)), patch.object(p, 'STATE', Path(tmp)/'state.json'), \
             patch.object(p, 'validate'), patch.object(p, 'resolve'), \
             patch.object(p, 'ctl', side_effect=[{'created': True, 'activated': False, 'workflowId': 'newk67id123'}, observed]) as api, \
             patch.object(p, 'register', side_effect=[RuntimeError('TAG_FAILED'), None]):
            with self.assertRaisesRegex(RuntimeError, 'TAG_FAILED'): p.create(state, 'default', 'newrole', candidate)
            self.assertNotIn('pending', state)
            self.assertFalse(state['created']['newrole']['registered'])
            self.assertEqual(p.create(state, 'default', 'newrole', candidate), 'newk67id123')
            self.assertEqual([call.args[1:3] for call in api.call_args_list], [('workflow', 'deploy'), ('workflow', 'get')])

    def test_lifecycle_record_written_but_ack_lost_resumes_same_id(self):
        state = {'created': {}, 'source_ids': ['oldsource']}
        candidate = {'name': 'K67 test', 'nodes': [], 'connections': {}, 'settings': p.SETTINGS}
        observed = {**candidate, 'id': 'newk67id123', 'active': False}
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp)/'lifecycle.json'
            p.write(ledger, {'schemaVersion':1,'taskId':'k67-grading-separation-20261006','workflows':[]})
            def lifecycle_call(argv, label, input_bytes=None):
                if 'register' not in argv: return b''
                import json
                if json.loads(ledger.read_text(encoding='utf-8'))['workflows']: raise RuntimeError('ALREADY_REGISTERED')
                p.write(ledger, {'schemaVersion':1, 'taskId':'k67-grading-separation-20261006', 'workflows':[
                    {'id':'newk67id123','name':'K67 test','purpose':'Tách bộ chấm K67, kiểm mô phỏng trước nhận bài',
                     'kind':'temporary','status':'open','expiresAt':'2026-10-13T00:00:00.000Z'}]})
                raise RuntimeError('ACK_LOST_AFTER_LIFECYCLE_WRITE')
            with patch.object(p, 'PRIVATE', Path(tmp)), patch.object(p, 'STATE', Path(tmp)/'state.json'), \
                 patch.object(p, 'LIFECYCLE', ledger), patch.object(p, 'validate'), patch.object(p, 'resolve'), \
                 patch.object(p, 'ctl', side_effect=[{'created':True,'activated':False,'workflowId':'newk67id123'}, observed]) as api, \
                 patch.object(p, 'call', side_effect=lifecycle_call):
                with self.assertRaisesRegex(RuntimeError, 'ACK_LOST'): p.create(state, 'default', 'newrole', candidate)
                self.assertFalse(state['created']['newrole']['registered'])
                self.assertEqual(p.create(state, 'default', 'newrole', candidate), 'newk67id123')
                self.assertEqual([call.args[1:3] for call in api.call_args_list], [('workflow','deploy'), ('workflow','get')])


    def test_existing_lifecycle_wrong_owner_or_identity_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp)/'lifecycle.json'
            p.write(ledger, {'schemaVersion':1,'taskId':'k67-grading-separation-20261006','workflows':[
                {'id':'newk67id123','name':'Một luồng khác','purpose':'Tách bộ chấm K67, kiểm mô phỏng trước nhận bài',
                 'kind':'temporary','status':'open','expiresAt':'2026-10-13T00:00:00.000Z'}]})
            with patch.object(p,'LIFECYCLE',ledger), patch.object(p,'call',return_value=b'') as api:
                with self.assertRaisesRegex(RuntimeError,'LIFECYCLE_ENTRY_MISMATCH'): p.register('default','newk67id123','K67 test')
                self.assertEqual(api.call_count,1)


class RunnerStatusSafety(unittest.TestCase):
    def test_native_pass_with_guard_failure_must_return_nonzero(self):
        # Chạy đúng biểu thức exit của wrapper với outcome giả, không import runner SSH.
        path=Path(__file__).resolve().parents[1]/'tools/run-vps-tests.py'
        tree=ast.parse(path.read_text(encoding='utf-8'))
        block=next(node for node in tree.body if isinstance(node,ast.Try))
        calls=[node.value for node in block.body if isinstance(node,ast.Expr) and isinstance(node.value,ast.Call)
            and isinstance(node.value.func,ast.Attribute) and isinstance(node.value.func.value,ast.Name)
            and node.value.func.value.id=='sys' and node.value.func.attr=='exit']
        self.assertEqual(len(calls),1)
        expression=compile(ast.Expression(calls[0]),str(path),'eval')
        for code,outcome,expected in [(0,'passed',0),(0,'failed',1),(7,'failed',7)]:
            with self.subTest(native_code=code,outcome=outcome):
                actual=eval(expression,{'sys':SimpleNamespace(exit=lambda value:value),'code':code,'outcome':outcome})
                self.assertEqual(actual,expected)


class RepairFileSafety(unittest.TestCase):
    # Mô phỏng SFTP chỉ để kiểm giới hạn file/CAS và mất ACK; không nối VPS.
    def setUp(self):
        spec = importlib.util.spec_from_file_location('repair', Path(__file__).resolve().parents[1]/'tools/repair-grading-fixture.py')
        self.repair = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.repair)
        self.helper = SimpleNamespace(REMOTE='/opt/k67-fake',sha=lambda value:hashlib.sha256(value).hexdigest())
        self.path = self.helper.REMOTE+'/source/ops/fixture-gateway.mjs'
        self.old=b'old gateway'; self.new=b'new gateway'
        self.files={self.path:self.old}; self.modes={self.path:0o644}; self.renames=0; self.lose_ack=False
        owner=self
        class Buffer(io.BytesIO):
            def __init__(self,path): super().__init__(); self.path=path
            def close(self):
                if not self.closed: owner.files[self.path]=self.getvalue()
                super().close()
        class Sftp:
            def open(self,path,mode):
                if mode=='rb': return io.BytesIO(owner.files[path])
                if mode=='wx':
                    if path in owner.files: raise FileExistsError(path)
                    return Buffer(path)
                raise AssertionError('Unexpected file mode')
            def chmod(self,path,mode): owner.modes[path]=mode
            def posix_rename(self,source,target):
                owner.files[target]=owner.files.pop(source); owner.renames+=1
                owner.modes[target]=owner.modes.pop(source)
                if owner.lose_ack: raise TimeoutError('ACK lost after atomic rename')
            def close(self): pass
        self.client=SimpleNamespace(open_sftp=lambda:Sftp())

    def replace(self,path=None):
        return self.repair.replace_owned_file(self.helper,self.client,path or self.path,self.helper.sha(self.old),self.new)

    def test_replace_owned_file_then_readback_and_repeat_without_mutation(self):
        self.replace(); self.assertEqual(self.files[self.path],self.new); self.assertEqual(self.renames,1)
        # Source phải đọc được bởi user node không phải root của container.
        self.assertEqual(self.modes[self.path],0o644)
        self.replace(); self.assertEqual(self.files[self.path],self.new); self.assertEqual(self.renames,1)

    def test_changed_file_is_preserved_instead_of_overwritten(self):
        self.files[self.path]=b'Another task changed the file'
        with self.assertRaisesRegex(RuntimeError,'OWN_FILE_CHANGED_NO_OVERWRITE'): self.replace()
        self.assertEqual(self.files[self.path],b'Another task changed the file'); self.assertEqual(self.renames,0)

    def test_foreign_file_is_rejected_before_open_or_write(self):
        with self.assertRaisesRegex(RuntimeError,'REPLACE_PATH_OUTSIDE_FIXTURE'): self.replace('/etc/nginx/nginx.conf')
        self.assertEqual(self.files,{self.path:self.old}); self.assertEqual(self.renames,0)

    def test_lost_rename_ack_reconciles_new_content_without_second_rename(self):
        self.lose_ack=True
        with self.assertRaises(TimeoutError): self.replace()
        self.assertEqual(self.files[self.path],self.new)
        self.replace(); self.assertEqual(self.renames,1)


class FaultReconciliationSafety(unittest.TestCase):
    def test_proof_saved_then_interrupted_resumes_original_without_post_or_backup_write(self):
        # Journal đã có proof nhưng chưa verified: nhận lại đúng bản gốc, không gửi hoặc ghi backup lần nữa.
        spec=importlib.util.spec_from_file_location('native_verifier',Path(__file__).resolve().parents[1]/'tools/verify-grading-fixture.py')
        verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)
        with tempfile.TemporaryDirectory() as tmp:
            backup=Path(tmp)/'original.json'
            original={'payload':{'attemptToken':'synthetic'},'tree_revision':'original-tree','http_status':200,'response':{'invalid_json':True}}
            helper=SimpleNamespace(atomic=lambda path,value:path.write_text(json.dumps(value),encoding='utf-8'))
            self.assertEqual(verifier.fault_original_record(helper,original,backup),original)
            before=backup.read_bytes()
            # Mô phỏng crash ngay sau proofSTATE; bản gốc và progress có trách nhiệm khác nhau.
            progress={**original,'executionId':'1818405','native_status':'error','consumer':{'rejected':True},
                'proof_tree_revision':'current-tree','reconciliation':{'no_post_replay':True}}
            with patch.object(verifier.requests,'post',side_effect=AssertionError('Must not POST')) as post, \
                 patch.object(helper,'atomic',side_effect=AssertionError('Must not rewrite original')) as write:
                self.assertEqual(verifier.fault_original_record(helper,progress,backup),original)
                post.assert_not_called();write.assert_not_called()
            self.assertEqual(backup.read_bytes(),before)
            changed={**progress,'payload':{'attemptToken':'another-entity'}}
            with self.assertRaisesRegex(RuntimeError,'OLD_FAULT_RECORD_CHANGED'):
                verifier.fault_original_record(helper,changed,backup)

if __name__ == '__main__': unittest.main(verbosity=2)
