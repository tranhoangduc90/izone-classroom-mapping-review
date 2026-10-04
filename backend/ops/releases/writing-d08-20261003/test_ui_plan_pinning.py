"""Plan bị thay một trường phải bị chặn trước public/seed; không gọi hệ thống ngoài."""
import json,unittest
from pathlib import Path
from unittest.mock import patch
import ui_producer as producer
import test_ui_producer as fixtures
class PlanPinning(unittest.TestCase):
    setUp=fixtures.Producer.setUp
    write=fixtures.Producer.write
    prepared=fixtures.Producer.prepared
    def blocked(self,change):
        self.prepared();file=Path(self.config['evidence_dir'])/'production-ui-plan.json'
        plan=json.loads(file.read_text(encoding='utf-8'));change(plan)
        file.write_text(json.dumps(plan),encoding='utf-8')
        with patch.object(producer.adapter,'checkpoint_inputs'),patch.object(producer.adapter,'public_readback') as public,patch.object(producer.adapter,'remote') as remote,patch.object(producer,'call') as seed:
            with self.assertRaises(ValueError):producer.run(self.config)
            public.assert_not_called();remote.assert_not_called();seed.assert_not_called()
        self.assertFalse((file.parent/'ui-producer.executor.json').exists())
    def test_missing_case(self):self.blocked(lambda p:p['entries'].pop())
    def test_duplicate_case(self):self.blocked(lambda p:p['entries'].__setitem__(1,p['entries'][0]))
    def test_changed_client(self):self.blocked(lambda p:p['entries'][0].__setitem__('client','k56-shared'))
    def test_changed_identity(self):self.blocked(lambda p:p['entries'][0]['identity'].__setitem__('marker','other'))
    def test_changed_destination(self):self.blocked(lambda p:p['entries'][0]['destination'].__setitem__('database','other'))
    def test_changed_raw_hash(self):self.blocked(lambda p:p['entries'][0]['binding'].__setitem__('ledger_sha256','9'*64))
    def test_changed_bundle(self):self.blocked(lambda p:p['entries'][0]['binding'].__setitem__('bundle_revision','9'*64))
    def test_changed_rpc_config(self):self.blocked(lambda p:p['entries'][0].__setitem__('rpc_config','other'))
    def test_preseeded_plan(self):self.blocked(lambda p:p['entries'][0].__setitem__('fixture_seeded',True))
    def test_asset_hash_changed(self):self.blocked(lambda p:p['entries'][0]['asset_hashes'].__setitem__('app','9'*64))
    def test_missing_asset(self):self.blocked(lambda p:p['entries'][0]['assets'].pop('css'))
if __name__=='__main__':unittest.main()
