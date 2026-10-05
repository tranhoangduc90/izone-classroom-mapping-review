"""Fixture unit giữ khóa/danh tính và chặn side effect sai; không gọi VPS."""
import copy,json,tempfile,unittest,uuid
from pathlib import Path
from canary_remote import child_tables
from ui_rpc_guard import validate_ledger,validate_payload,execute,Journal,canonical_hash,request_binding,ENTRIES,DESTINATIONS

class Backend:
    def __init__(self):
        self.present=False;self.writes=0;self.deletes=0;self.fail_post=False;self.child=False;self.submitted=False;self.wrong_identity=False
    def guard(self,entry):pass
    def value(self,entry):
        value={'attempt_id':entry['identity']['attempt_id'],'marker':entry['identity']['marker'],
         'course_id':entry['identity']['course_id'],'student_id':entry['identity']['student_id'],
         'ownership_checked':True,'destination':entry['destination'],'child_tables':list(child_tables({'name':entry['destination']['container']})),'children':[1 if self.child and i==0 else 0 for i in range(len(child_tables({'name':entry['destination']['container']})))],
         'writing':{'task1':'','task2':'','revision':0,'started':False,'submitted':self.submitted,'deadlineAt':None,'serverNow':'2026-10-04T00:00:00Z'}}
        if self.wrong_identity:value['student_id']=-9999999
        return value
    def seed(self,entry):self.present=True;self.writes+=1;return self.value(entry)
    def read(self,entry):return self.value(entry)
    def post(self,entry,payload):
        self.writes+=1
        if self.fail_post:raise TimeoutError('HTTP response lost')
        return {'status':200,'body':{'ok':True,'writing':{'accepted':True}}}
    def cleanup(self,entry):
        self.deletes+=1;self.present=False
        return {'status':'passed','attempt_id':entry['identity']['attempt_id'],'marker':entry['identity']['marker'],'destination':entry['destination'],'child_tables':list(child_tables({'name':entry['destination']['container']})),'remaining':{'attempt':0,'marker':0,'children':[0]*len(child_tables({'name':entry['destination']['container']}))}}

class RpcGuard(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.journal=Journal(self.temp.name);self.backend=Backend()
        self.manifest={'targets':[{'name':name,'candidate_image':'sha256:'+str(i+1)*64} for i,name in enumerate(DESTINATIONS)]}
        images={t['name']:t['candidate_image'] for t in self.manifest['targets']}
        entries=[]
        for i,(case_id,(client,target)) in enumerate(ENTRIES.items()):
            api,database=DESTINATIONS[target]
            entries.append({'case_id':case_id,'client':client,'identity':{'attempt_id':str(uuid.uuid4()),'student_ref':str(uuid.uuid4()),
             'marker':'CODEX_D08_'+'7'*32+'_'+str(i),'course_id':-2000000-i*2,'student_id':-2000001-i*2,
             'class_code':'CODEXDEMO56' if target.endswith('demo-api-1') else 'IC2264' if target=='izone-k56-ic2264-api' else 'IC2146'},
             'destination':{'container':target,'image':images[target],'public_api_base':api,'database':database}})
        self.ledger={'schema':'d08-ui-production-ledger/v1','run_id':'7'*32,'bundle_revision':'4'*64,'entries':entries}
        self.entry=entries[0];self.payload={'attemptToken':self.entry['identity']['attempt_id'],'action':'draft','task1':'Task giả1','task2':'Task giả2','baseRevision':0}
    def request(self,action,sequence):
        return {'action':action,'sequence':sequence,'case_id':self.entry['case_id'],'ledger_canonical_sha256':canonical_hash(self.ledger),'ledger_sha256':'6'*64,'bundle_revision':'4'*64,**({'payload':self.payload} if action=='post' else {})}
    def call(self,action,sequence):
        return execute(self.request(action,sequence),self.ledger,self.manifest,self.backend,self.journal)
    def assertLedgerBlocked(self,code):
        with self.assertRaisesRegex(ValueError,code):validate_ledger(self.ledger,self.manifest)
    def test_seven_distinct_identities(self):self.assertEqual(len(validate_ledger(self.ledger,self.manifest)),7)
    def test_missing_case(self):self.ledger['entries'].pop();self.assertLedgerBlocked('case_set')
    def test_duplicate_uuid(self):self.ledger['entries'][1]['identity']['attempt_id']=self.entry['identity']['attempt_id'];self.assertLedgerBlocked('uuid')
    def test_non_v4_uuid(self):self.entry['identity']['attempt_id']=str(uuid.uuid1());self.assertLedgerBlocked('uuid')
    def test_marker_wrong_run(self):self.entry['identity']['marker']='CODEX_D08_'+'8'*32+'_0';self.assertLedgerBlocked('marker')
    def test_positive_erp(self):self.entry['identity']['student_id']=10;self.assertLedgerBlocked('negative')
    def test_boolean_erp(self):self.entry['identity']['student_id']=False;self.assertLedgerBlocked('negative')
    def test_duplicate_negative_ids(self):self.entry['identity']['student_id']=self.entry['identity']['course_id'];self.assertLedgerBlocked('negative')
    def test_wrong_database(self):self.entry['destination']['database']='other';self.assertLedgerBlocked('destination')
    def test_wrong_image(self):self.entry['destination']['image']='sha256:'+'9'*64;self.assertLedgerBlocked('destination')
    def test_wrong_public_api(self):self.entry['destination']['public_api_base']='https://other.invalid';self.assertLedgerBlocked('destination')
    def test_wrong_class_route(self):self.entry['identity']['class_code']='CODEXDEMO56';self.assertLedgerBlocked('class_route')
    def test_valid_two_tasks(self):self.assertEqual(validate_payload(self.payload,self.entry['identity']),self.payload)
    def test_forbidden_actions(self):
        for action in ('submit','result','grade','delete'):
            with self.subTest(action=action):
                self.payload['action']=action
                with self.assertRaisesRegex(ValueError,'forbidden'):validate_payload(self.payload,self.entry['identity'])
    def test_optional_outline_forwarded_unchanged(self):
        self.payload['outline']='Dàn ý local K56'
        self.assertEqual(validate_payload(self.payload,self.entry['identity']),self.payload)
    def test_invalid_outline_blocked(self):
        for value in (False,None,7,'x'*100001):
            with self.subTest(value_type=type(value).__name__):
                self.payload['outline']=value
                with self.assertRaisesRegex(ValueError,'outline'):validate_payload(self.payload,self.entry['identity'])
    def test_wrong_payload_uuid(self):
        self.payload['attemptToken']=str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError,'wrong_uuid'):validate_payload(self.payload,self.entry['identity'])
    def test_extra_target_field(self):
        self.payload['url']='https://other.invalid'
        with self.assertRaisesRegex(ValueError,'extra'):validate_payload(self.payload,self.entry['identity'])
    def test_invalid_base_values(self):
        for value in (False,-1,None,'0',0.5,9007199254740992):
            with self.subTest(value=value):
                self.payload['baseRevision']=value
                with self.assertRaisesRegex(ValueError,'base'):validate_payload(self.payload,self.entry['identity'])
    def test_one_task_missing(self):
        self.payload.pop('task2')
        with self.assertRaisesRegex(ValueError,'task'):validate_payload(self.payload,self.entry['identity'])
    def test_happy_journal_lifecycle(self):
        self.call('seed',1);self.call('read',2);self.call('post',3);self.call('cleanup',4)
        self.assertEqual(self.backend.deletes,1);self.assertFalse(self.backend.present)
        self.assertEqual(json.loads(self.journal.state.read_text(encoding='utf-8')),{'sequence':4,'phase':'cleaned','binding':request_binding(self.request('cleanup',4))})
        self.assertFalse(self.journal.lock.exists())
        self.assertTrue((self.journal.folder/'3.request.json').is_file())
        self.assertTrue((self.journal.folder/'3.response.json').is_file())
    def test_unknown_sender_blocks_cleanup(self):
        self.call('seed',1);self.backend.fail_post=True
        with self.assertRaises(TimeoutError):self.call('post',2)
        self.assertTrue(self.journal.lock.exists());self.assertTrue((self.journal.folder/'unknown.json').is_file())
        with self.assertRaisesRegex(ValueError,'sender_unknown'):self.call('cleanup',3)
        self.assertTrue(self.backend.present);self.assertEqual(self.backend.deletes,0)
    def test_child_blocks_delete(self):
        self.call('seed',1);self.backend.child=True
        with self.assertRaisesRegex(ValueError,'child'):self.call('cleanup',2)
        self.assertEqual(self.backend.deletes,0);self.assertTrue(self.backend.present)
    def test_submitted_blocks_delete(self):
        self.call('seed',1);self.backend.submitted=True
        with self.assertRaisesRegex(ValueError,'submitted'):self.call('cleanup',2)
        self.assertEqual(self.backend.deletes,0)
    def test_changed_identity_blocks_post(self):
        self.call('seed',1);self.backend.wrong_identity=True
        with self.assertRaisesRegex(ValueError,'identity_wrong'):self.call('post',2)
        self.assertEqual(self.backend.writes,1);self.assertEqual(self.backend.deletes,0)
    def test_seed_cannot_replay(self):
        self.call('seed',1)
        with self.assertRaisesRegex(ValueError,'seed_replay'):self.call('seed',2)
        self.assertEqual(self.backend.writes,1)
    def test_cleaned_cannot_write_again(self):
        self.call('seed',1);self.call('cleanup',2)
        with self.assertRaisesRegex(ValueError,'already_cleaned'):self.call('post',3)
        self.assertEqual(self.backend.writes,1)
    def test_sequence_cas(self):
        self.call('seed',1)
        with self.assertRaisesRegex(ValueError,'sequence_conflict'):self.call('read',1)
        self.assertEqual(json.loads(self.journal.state.read_text(encoding='utf-8'))['sequence'],1)
    def test_parallel_executor_no_second_sender(self):
        self.journal.acquire(self.request('seed',1))
        with self.assertRaises(FileExistsError):self.call('seed',1)
        self.assertEqual(self.backend.writes,0)
    def test_ledger_binding_wrong_before_lock(self):
        request=self.request('seed',1);request['ledger_canonical_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'binding'):execute(request,self.ledger,self.manifest,self.backend,self.journal)
        self.assertFalse(self.journal.lock.exists());self.assertEqual(self.backend.writes,0)
    def test_database_binding_cannot_change_between_actions(self):
        first=self.request('seed',1);first['database_bindings_sha256']='a'*64
        execute(first,self.ledger,self.manifest,self.backend,self.journal)
        second=self.request('read',2);second['database_bindings_sha256']='b'*64
        with self.assertRaisesRegex(ValueError,'journal_binding_changed'):
            execute(second,self.ledger,self.manifest,self.backend,self.journal)
        self.assertEqual(self.backend.writes,1);self.assertEqual(self.backend.deletes,0)
    def test_database_binding_cannot_disappear_between_actions(self):
        first=self.request('seed',1);first['database_bindings_sha256']='a'*64
        execute(first,self.ledger,self.manifest,self.backend,self.journal)
        with self.assertRaisesRegex(ValueError,'journal_binding_changed'):
            execute(self.request('cleanup',2),self.ledger,self.manifest,self.backend,self.journal)
        self.assertEqual(self.backend.deletes,0);self.assertTrue(self.backend.present)

if __name__=='__main__':unittest.main()
