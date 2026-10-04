"""Sai bytes/content sổ bị chặn trước guard/SQL/HTTP; chỉ packet giả."""
import hashlib,json,unittest
from unittest.mock import patch
import ui_rpc_remote as remote
from exercise_ui_rpc_docker import ledger_for
from pathlib import Path
class RemoteBinding(unittest.TestCase):
    def setUp(self):
        self.manifest=json.loads((Path(__file__).parent/'candidate.json').read_text(encoding='utf-8'))
        ledger=ledger_for(self.manifest,'7'*32)
        source=json.dumps(ledger,ensure_ascii=False,indent=2).replace('\n','\r\n')
        self.packet={'scope':'production_fixture','ledger':ledger,'ledger_source':source,'manifest':self.manifest,'expected':[],
                     'request':{'case_id':ledger['entries'][0]['case_id'],'ledger_sha256':hashlib.sha256(source.encode('utf-8')).hexdigest()}}
        self.packet['database_bindings']={}
        from ui_rpc_guard import canonical_hash
        self.packet['request']['database_bindings_sha256']=canonical_hash({})
    def test_wrong_raw_sha_blocks_backend(self):
        self.packet['request']['ledger_sha256']='0'*64
        with patch.object(remote,'ProductionBackend') as backend:
            with self.assertRaisesRegex(ValueError,'raw_ledger_binding'):remote.perform(self.packet)
            backend.assert_not_called()
    def test_matching_raw_sha_wrong_content_blocks_backend(self):
        self.packet['ledger']['bundle_revision']='8'*64
        with patch.object(remote,'ProductionBackend') as backend:
            with self.assertRaisesRegex(ValueError,'raw_ledger_content'):remote.perform(self.packet)
            backend.assert_not_called()
    def test_crlf_exact_source_reaches_executor_unchanged(self):
        with patch.object(remote,'Journal'),patch.object(remote,'ProductionBackend'),patch.object(remote,'execute',return_value={'fixture':'verified'}) as execute:
            self.assertEqual(remote.perform(self.packet),{'fixture':'verified'})
            self.assertEqual(execute.call_args.args[:3],(self.packet['request'],self.packet['ledger'],self.manifest))
    def test_changed_database_binding_blocks_backend(self):
        self.packet['database_bindings']={'wrong_target':{}}
        with patch.object(remote,'ProductionBackend') as backend:
            with self.assertRaisesRegex(ValueError,'database_binding_packet_wrong'):remote.perform(self.packet)
            backend.assert_not_called()
if __name__=='__main__':unittest.main()
