"""Chỉ tạo ledger C giả và mock preflight; không SSH/HTTP hoặc mutation thật."""
import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import ui_producer as p
from browser_receipt import ENTRIES
from ui_rpc_guard import validate_ledger

class Producer(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.manifest=json.loads((p.HERE/'candidate.json').read_text(encoding='utf-8'))
        assets={};hashes={}
        for key in ('app','config','css','examOrder'):
            file=self.root/(key+'.txt');file.write_text('synthetic asset '+key,encoding='utf-8')
            assets[key]=str(file);hashes[key]=hashlib.sha256(file.read_bytes()).hexdigest()
        self.template={'schema':'d08-ui-production-plan/v1','scope':'production_fixture','pages_checkpoint':self.manifest['pages_candidate'],
          'entries':[{'case_id':case,'client':client,'assets':assets,'asset_hashes':hashes,'public_asset_urls':{key:'https://example.invalid/'+key for key in assets}} for case,(client,target) in ENTRIES.items()]}
        self.template_path=self.root/'template.json'
        self.config_path=self.root/'config.json'
        self.config={'evidence_dir':str(self.root/'evidence'),'bundle_revision':'4'*64,'product_revision':'d08-bundle:'+'4'*64,
         'ui_rpc_config':str(self.config_path),'ui_plan_template':str(self.template_path)}
        self.write()
    def write(self):
        self.template_path.write_text(json.dumps(self.template),encoding='utf-8');self.config_path.write_text(json.dumps(self.config),encoding='utf-8')
    def prepared(self):return p.prepare(self.config)
    def test_prepare_no_external_calls(self):
        with patch.object(p.adapter,'remote',side_effect=AssertionError('external forbidden')):result=self.prepared()
        self.assertFalse(result['production_mutated']);self.assertEqual(result['entries'],7)
        folder=Path(self.config['evidence_dir']);ledger=json.loads((folder/'production-ui-ledger.json').read_text(encoding='utf-8'))
        self.assertEqual(len(validate_ledger(ledger,self.manifest)),7)
        plan=json.loads((folder/'production-ui-plan.json').read_text(encoding='utf-8'));self.assertTrue(all(not e['fixture_seeded'] for e in plan['entries']))
        actual=hashlib.sha256((folder/'production-ui-ledger.json').read_bytes()).hexdigest()
        self.assertTrue(all(e['binding']['ledger_sha256']==actual for e in plan['entries']))
    def test_prepare_cannot_overwrite_ledger(self):
        self.prepared()
        with self.assertRaises(FileExistsError):self.prepared()
    def test_wrong_bundle(self):
        self.config['bundle_revision']='z'*64;self.write()
        with self.assertRaisesRegex(ValueError,'bundle'):self.prepared()
    def test_wrong_pages_revision(self):
        self.template['pages_checkpoint']='0'*40;self.write()
        with self.assertRaisesRegex(ValueError,'template_revision'):self.prepared()
    def test_config_file_mismatch(self):
        self.config['evidence_dir']=str(self.root/'different')
        with self.assertRaisesRegex(ValueError,'rpc_config'):self.prepared()
    def test_asset_changed_before_ledger(self):
        Path(self.template['entries'][0]['assets']['app']).write_text('tampered',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'asset_changed'):self.prepared()
        self.assertFalse((Path(self.config['evidence_dir'])/'production-ui-ledger.json').exists())
    def test_run_wrong_public_assets_blocks_seed(self):
        self.prepared()
        public={'status':'passed','assets':[]}
        for client in ('shared','k56-shared','k56-mini-shared','k56-test2-shared'):
            for name in ('app.js','config.js','styles.css'):public['assets'].append({'path':'term-tests/'+client+'/'+name,'sha256':'9'*64})
        public['assets'].append({'path':'term-tests/k56-exam-order.js','sha256':'9'*64})
        with patch.object(p.adapter,'checkpoint_inputs'),patch.object(p.adapter,'public_readback',return_value=public),patch.object(p,'call') as call:
            with self.assertRaisesRegex(ValueError,'assets_wrong_bundle'):p.run(self.config)
            call.assert_not_called()
        self.assertTrue((Path(self.config['evidence_dir'])/'ui-producer.executor.json').is_file())

if __name__=='__main__':unittest.main()
