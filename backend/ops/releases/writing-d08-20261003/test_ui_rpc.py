"""Kiểm đường C→SSH bằng stream giả; request phải bền vững trước gửi, không đọc credential."""
import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import ui_rpc as rpc
from exercise_ui_rpc_docker import ledger_for

class Stream:
    def __init__(self,value=b'',code=0):self.value=value;self.code=code;self.channel=self;self.written=''
    def write(self,value):self.written+=value
    def shutdown_write(self):pass
    def read(self):return self.value
    def recv_exit_status(self):return self.code

class Client:
    def __init__(self,test):
        self.test=test;self.stdin=Stream();self.closed=False
    def exec_command(self,command,timeout):
        folder=self.test.root/'ui-rpc'/self.test.entry['case_id']
        self.test.assertTrue((folder/'1.request.json').is_file())
        self.test.assertTrue((folder/'1.packet.json').is_file())
        self.test.command=command
        return self.stdin,Stream(self.test.output,self.test.exitcode),Stream(b'')
    def close(self):self.closed=True

class Loader:
    def __init__(self,client):self.client=client
    def create_module(self,spec):return None
    def exec_module(self,module):module.connect=lambda host:(self.client,'fixture-only')

class CliRpc(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.manifest=json.loads((rpc.HERE/'candidate.json').read_text(encoding='utf-8'))
        self.ledger=ledger_for(self.manifest,'7'*32);self.ledger['bundle_revision']='4'*64
        (self.root/'production-ui-ledger.json').write_text(json.dumps(self.ledger,ensure_ascii=False,indent=2),encoding='utf-8')
        (self.root/'production-ui-snapshot.json').write_text('[]',encoding='utf-8')
        # Snapshot giả chỉ cho kiểm transport; không resolve hoặc query database.
        self.bindings={name:{'api_id':'a'*64,'db_id':'d'*64} for name in ('mapping-review-api','izone-k56-ic2264-api','izone-k56-demo-k56-demo-api-1')}
        (self.root/'production-ui-database-bindings.json').write_text(json.dumps(self.bindings),encoding='utf-8')
        self.entry=self.ledger['entries'][0];id=self.entry['identity']
        self.value={'attempt_id':id['attempt_id'],'marker':id['marker'],'course_id':id['course_id'],'student_id':id['student_id'],
          'destination':self.entry['destination'],'ownership_checked':True,'children':[0]*5,
          'writing':{'task1':'','task2':'','revision':0,'started':False,'submitted':False,'deadlineAt':None,'serverNow':'2026-10-04T00:00:00Z'}}
        self.config={'evidence_dir':str(self.root),'bundle_revision':'4'*64,'product_revision':'d08-bundle:'+'4'*64}
        self.output=json.dumps(self.value).encode();self.exitcode=0;self.client=Client(self)
    def call(self):
        import importlib.util
        original=importlib.util.spec_from_file_location
        def spec(name,path,*args,**kwargs):
            if name=='ssh_credentials':return importlib.util.spec_from_loader(name,Loader(self.client))
            return original(name,path,*args,**kwargs)
        with patch.object(rpc.adapter,'checkpoint_inputs'),patch.object(rpc.importlib.util,'spec_from_file_location',side_effect=spec):
            return rpc.call(self.config,self.entry['case_id'],'seed')
    def test_saved_before_sender_and_exact_response(self):
        result=self.call();self.assertEqual(result,self.value);self.assertTrue(self.client.closed)
        packet=json.loads(self.client.stdin.written)
        self.assertEqual(set(packet['files']),set(rpc.FILES));self.assertEqual(packet['request']['sequence'],1)
        self.assertEqual(packet['request']['ledger_sha256'],hashlib.sha256((self.root/'production-ui-ledger.json').read_bytes()).hexdigest())
        self.assertEqual(packet['request']['case_id'],self.entry['case_id'])
        self.assertEqual(packet['database_bindings'],self.bindings)
        self.assertEqual(packet['request']['database_bindings_sha256'],rpc.canonical_hash(self.bindings))
        folder=self.root/'ui-rpc'/self.entry['case_id'];self.assertFalse((folder/'executor.lock').exists())
        self.assertTrue((folder/'1.response.json').is_file())
    def test_exact_crlf_and_lf_bytes_survive_packet(self):
        ledger_path=self.root/'production-ui-ledger.json'
        # Mỗi kiểu newline dùng một executor riêng; không replay hoặc chuẩn hóa proof.
        for newline in ('\r\n','\n'):
            with self.subTest(newline=repr(newline)):
                raw=json.dumps(self.ledger,ensure_ascii=False,indent=2).replace('\n',newline).encode('utf-8')
                ledger_path.write_bytes(raw)
                self.call();packet=json.loads(self.client.stdin.written)
                self.assertEqual(packet['ledger_source'].encode('utf-8'),raw)
                self.assertEqual(packet['request']['ledger_sha256'],hashlib.sha256(raw).hexdigest())
                # Chỉ thư mục temp test của chính ca này, không có sender thật.
                import shutil
                shutil.rmtree(self.root/'ui-rpc')
                self.client=Client(self)
    def test_exit_failure_even_passlooking_json_is_unknown(self):
        self.exitcode=1
        with self.assertRaisesRegex(ValueError,'response_unknown'):self.call()
        folder=self.root/'ui-rpc'/self.entry['case_id'];self.assertTrue((folder/'unknown.json').is_file());self.assertTrue((folder/'executor.lock').is_file())
        self.assertFalse((folder/'1.response.json').exists())
    def test_empty_response_unknown(self):
        self.output=b''
        with self.assertRaisesRegex(ValueError,'response_unknown'):self.call()
        self.assertTrue(self.client.closed)
    def test_invalid_json_unknown(self):
        self.output=b'not json'
        with self.assertRaises(json.JSONDecodeError):self.call()
        self.assertTrue((self.root/'ui-rpc'/self.entry['case_id']/'unknown.json').exists())
    def test_wrong_identity_blocks_ack(self):
        self.value['student_id']=-9999999;self.output=json.dumps(self.value).encode()
        with self.assertRaisesRegex(ValueError,'identity_wrong'):self.call()
        self.assertTrue((self.root/'ui-rpc'/self.entry['case_id']/'unknown.json').exists())
    def test_child_nonzero_blocks_ack(self):
        self.value['children'][0]=1;self.output=json.dumps(self.value).encode()
        with self.assertRaisesRegex(ValueError,'child'):self.call()
    def test_second_sender_refused(self):
        folder=self.root/'ui-rpc'/self.entry['case_id'];folder.mkdir(parents=True)
        (folder/'executor.lock').write_text('existing sender',encoding='utf-8')
        with self.assertRaises(FileExistsError):self.call()
        self.assertFalse(self.client.stdin.written)
    def test_bundle_wrong_before_sending(self):
        self.config['product_revision']='d08-bundle:'+'5'*64
        with self.assertRaisesRegex(ValueError,'bundle_config'):self.call()
        self.assertFalse(self.client.stdin.written)

if __name__=='__main__':unittest.main()
