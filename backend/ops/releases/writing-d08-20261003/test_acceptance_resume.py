"""Kiểm phiên tiếp tục generation2/3/4 và chặn mọi lần chạy lại Mapping."""
import copy,json,os,subprocess,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import canary_remote as c
import acceptance_resume as subject
import acceptance_cas as cas
from acceptance_provenance import canonical_sha
from outcome_receipt import API_CASES

def fixture(root):
    release=uuid.uuid4().hex;run=uuid.uuid4().hex
    old_binding={'release_run_id':release,'acceptance_run_id':run,'original_plan_digest':'a'*64,'acceptance_digest':'b'*64,'ui_ledger_sha256':'c'*64,'expected_generation':0}
    new_binding={**old_binding,'acceptance_digest':'d'*64,'expected_generation':2}
    identities=[{'name':name,'attempt_id':str(uuid.uuid4()),'marker':'CODEX_D08_'+run+'_'+str(index),'course_id':-560001 if index==2 else -1000000-index*2,'student_id':-1000001-index*2} for index,name in enumerate(c.NAMES)]
    empty={'attempt_remaining':0,'marker_remaining':0,'children_remaining':0}
    mapping={'target':c.NAMES[0],'status':'passed','api_database':{'status':'passed','attempt_id':identities[0]['attempt_id'],'receipts':[{'case':name} for name in sorted(API_CASES)],'final':{'revision':1,'submitted':False,'children':{t:0 for t in c.child_tables(identities[0])}}},'cleanup':{'status':'passed','attempt_id':identities[0]['attempt_id'],'removal':{'removed':1},'readback':empty}}
    failed={'target':c.NAMES[1],'status':'failed','api_database':{'status':'failed','error':'23514','attempt_id':identities[1]['attempt_id']},'cleanup':{'status':'passed','attempt_id':identities[1]['attempt_id'],'removal':{'removed':0},'readback':empty}}
    runtime=[{'name':name,'image':'synthetic','running':True,'healthy':'healthy'} for name in c.NAMES]
    journal={'status':'unknown','runtime_unchanged':True,'before':runtime,'after':runtime,'identities':identities,'receipts':[mapping,failed]}
    journal_path=root/run/'canary.json';journal_path.parent.mkdir();cas.save_exclusive(journal_path,journal)
    state={'generation':2,'status':'unknown','binding':old_binding,'pid':99123}
    state_path=root/release/'acceptance.executor.json';state_path.parent.mkdir();cas.save_exclusive(state_path,state)
    release_path=root/(release+'.json');cas.save_exclusive(release_path,{'status':'deployed_awaiting_validation'})
    spec={'previous_binding':old_binding,'executor_sha256':cas.sha(state_path.read_bytes()),'journal_sha256':cas.sha(journal_path.read_bytes()),'reuse_receipt_sha256':canonical_sha(mapping),'run_targets':list(c.NAMES[1:]),'reuse_targets':[c.NAMES[0]],'approved_package_digest':'e'*64}
    request={'run_id':run,'acceptance_binding':new_binding,'acceptance_resume':spec,'identities':identities,'expected':runtime,'manifest':{'targets':[]}}
    return request,state_path,journal_path

class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup);self.root=Path(self.directory.name)
        self.request,self.state_path,self.journal_path=fixture(self.root)
        self.patchers=[patch.object(c.r,'RELEASE_ROOT',self.root),patch.object(c.r,'probe',return_value=self.request['expected']),patch.object(subject,'sender_stopped',return_value=True)]
        for p in self.patchers:p.start();self.addCleanup(p.stop)
    def test_resume_preserves_old_journal_and_uses_generation3(self):
        raw=self.journal_path.read_bytes();previous=subject.acquire(self.request,c)
        self.assertEqual(previous['receipts'][0]['target'],c.NAMES[0]);self.assertEqual(self.journal_path.read_bytes(),raw)
        state=json.loads(self.state_path.read_text());self.assertEqual(state['generation'],3)
        self.assertEqual(state['binding'],self.request['acceptance_binding'])
    def test_mapping_cannot_be_added_to_run_scope(self):
        self.request['acceptance_resume']['run_targets'].insert(0,c.NAMES[0])
        with self.assertRaisesRegex(RuntimeError,'target_scope'):subject.acquire(self.request,c)
    def test_changed_journal_blocks(self):
        self.journal_path.write_text('{}',encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError,'journal_changed'):subject.acquire(self.request,c)
    def test_old_sender_alive_blocks(self):
        with patch.object(subject,'sender_stopped',return_value=False):
            with self.assertRaisesRegex(RuntimeError,'still_alive'):subject.acquire(self.request,c)
    def test_runtime_drift_blocks(self):
        with patch.object(c.r,'probe',return_value=[]):
            with self.assertRaisesRegex(RuntimeError,'runtime_changed'):subject.acquire(self.request,c)
    def test_changed_previous_binding_blocks(self):
        self.request['acceptance_resume']['previous_binding']['ui_ledger_sha256']='f'*64
        with self.assertRaisesRegex(RuntimeError,'previous_binding'):subject.acquire(self.request,c)
    def test_ui_blocks_generation2_and3_then_allows_exact4(self):
        value=self.request['acceptance_binding']
        with self.assertRaisesRegex(RuntimeError,'not_passed'):c.require_acceptance(value)
        subject.acquire(self.request,c)
        with self.assertRaisesRegex(RuntimeError,'not_passed'):c.require_acceptance(value)
        cas.replace_durable(self.state_path,{'generation':4,'status':'api_passed','binding':value})
        self.assertEqual(c.require_acceptance(value)['generation'],4)
        changed={**value,'acceptance_digest':'f'*64}
        with self.assertRaisesRegex(RuntimeError,'not_passed'):c.require_acceptance(changed)
    def test_generation2_cannot_use_initial_acquire(self):
        with self.assertRaisesRegex(RuntimeError,'requires_cas'):c.acquire_acceptance(self.request['acceptance_binding'])
    def test_wrong_request_run_id_blocks_before_read_or_cas(self):
        self.request['run_id']=uuid.uuid4().hex
        with self.assertRaisesRegex(RuntimeError,'run_id_mismatch'):subject.acquire(self.request,c)
    def prepare_exercise(self):
        self.request['manifest']={'targets':[{'name':name,'candidate_image':'synthetic'} for name in c.NAMES]};self.request['core']='synthetic'
    def test_binding_error_after_cas_records_unknown_without_seed(self):
        self.prepare_exercise()
        with patch.object(c.binding,'resolve',side_effect=RuntimeError('binding_failure')),patch.object(c.r,'write_receipt',side_effect=cas.replace_durable),patch.object(c.subprocess,'run') as sender,patch.object(c,'cleanup') as cleanup:
            with self.assertRaisesRegex(RuntimeError,'binding_failure'):c.exercise(self.request)
            sender.assert_not_called();cleanup.assert_not_called()
        journal=json.loads((self.root/self.request['run_id']/'canary.generation-3.json').read_text())
        self.assertEqual(journal['status'],'unknown');self.assertTrue(journal['no_seed_sent'])
        self.assertEqual(json.loads(self.state_path.read_text())['generation'],4)
        with self.assertRaisesRegex(RuntimeError,'not_passed'):c.require_acceptance(self.request['acceptance_binding'])
    def test_crash_after_cas_pointer_keeps_generation3_and_claim(self):
        self.prepare_exercise()
        with patch.object(c.binding,'resolve',side_effect=SystemExit('synthetic_crash')):
            with self.assertRaises(SystemExit):c.exercise(self.request)
        self.assertEqual(json.loads(self.state_path.read_text())['generation'],3)
        self.assertTrue(self.state_path.with_name(self.state_path.name+'.cas-generation-2.json').exists())
        with self.assertRaisesRegex(RuntimeError,'not_passed'):c.require_acceptance(self.request['acceptance_binding'])
        with self.assertRaisesRegex(RuntimeError,'executor_changed'):subject.acquire(self.request,c)
    def test_timeout_docker_keeps_fixture_and_blocks_cleanup_and_ui(self):
        self.prepare_exercise()
        def binding(item,*args):return {'api_id':item['name']}
        def query(item,sql):return [{'database':c.destination(item)[2],'existing':0,'children':0}]
        with patch.object(c.binding,'resolve',side_effect=binding),patch.object(c.binding,'require',side_effect=binding),patch.object(c,'admin_query',side_effect=query),patch.object(c.subprocess,'run',side_effect=subprocess.TimeoutExpired('synthetic',180)),patch.object(c,'cleanup') as cleanup,patch.object(c.r,'write_receipt',side_effect=cas.replace_durable):
            result=c.exercise(self.request);cleanup.assert_not_called()
        self.assertEqual(result['status'],'unknown');self.assertEqual(len(result['receipts']),2)
        self.assertEqual(result['receipts'][1]['cleanup_error'],'canary_cleanup_blocked_sender_state_unknown')
        with self.assertRaisesRegex(RuntimeError,'not_passed'):c.require_acceptance(self.request['acceptance_binding'])
    def test_exercise_only_runs_missing_k56_and_demo(self):
        self.request['manifest']={'targets':[{'name':name,'candidate_image':'synthetic'} for name in c.NAMES]};self.request['core']='synthetic'
        original=json.loads(self.journal_path.read_text());calls=[];cleanups=[]
        def binding(item,*args):return {'api_id':item['name']}
        def query(item,sql):return [{'database':c.destination(item)[2],'existing':0,'children':0}]
        def run(argv,**kwargs):
            name=argv[5];calls.append(name);identity=next(i for i in self.request['identities'] if i['name']==name)
            core=copy.deepcopy(original['receipts'][0]['api_database']);core['attempt_id']=identity['attempt_id'];core['final']['children']={t:0 for t in c.child_tables(identity)}
            return subprocess.CompletedProcess(argv,0,json.dumps(core),'')
        def cleanup(item):
            cleanups.append(item['name']);return {'status':'passed','attempt_id':item['attempt_id'],'removal':{'removed':1},'readback':{'attempt_remaining':0,'marker_remaining':0,'children_remaining':0}}
        with patch.object(c.binding,'resolve',side_effect=binding),patch.object(c.binding,'require',side_effect=binding),patch.object(c,'admin_query',side_effect=query),patch.object(c.subprocess,'run',side_effect=run),patch.object(c,'cleanup',side_effect=cleanup),patch.object(c.r,'write_receipt',side_effect=cas.replace_durable):
            result=c.exercise(self.request)
        self.assertEqual(calls,list(c.NAMES[1:]));self.assertEqual(cleanups,list(c.NAMES[1:]));self.assertEqual(result['receipts'][0],original['receipts'][0])
        self.assertEqual(result['status'],'passed_api_database');self.assertEqual(c.require_acceptance(self.request['acceptance_binding'])['generation'],4)
        self.assertEqual(json.loads(self.journal_path.read_text()),original)

if __name__=='__main__':unittest.main()
