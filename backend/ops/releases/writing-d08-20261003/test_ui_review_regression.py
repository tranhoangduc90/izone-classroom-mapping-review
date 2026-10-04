"""Ba P1: plan đủ ca, pin journal và request bất biến; fixture giả không SSH."""
import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import ui_producer as producer
import ui_rpc_guard as guard
import exercise_ui_rpc_docker as driver
import test_ui_producer as producer_tests
import test_ui_rpc_guard as guard_tests

class PlanRegression(unittest.TestCase):
    setUp=producer_tests.Producer.setUp
    write=producer_tests.Producer.write
    prepared=producer_tests.Producer.prepared
    # Chỉ chạy ca này trong file này; không nhân các unit của parent ở runner.
    def test_empty_plan_must_never_report_passed(self):
        self.prepared();folder=Path(self.config['evidence_dir'])
        plan=json.loads((folder/'production-ui-plan.json').read_text(encoding='utf-8'));plan['entries']=[]
        (folder/'production-ui-plan.json').write_text(json.dumps(plan),encoding='utf-8')
        public={'status':'passed','assets':[]}
        byclient={e['client']:e for e in self.template['entries']}
        for client,entry in byclient.items():
            for key,name in [('app','app.js'),('config','config.js'),('css','styles.css')]:
                public['assets'].append({'path':'term-tests/'+client+'/'+name,'sha256':entry['asset_hashes'][key]})
        public['assets'].append({'path':'term-tests/k56-exam-order.js','sha256':self.template['entries'][0]['asset_hashes']['examOrder']})
        rows=[{'name':t['name'],'image':t['candidate_image'],'running':True,'healthy':'healthy'} for t in self.manifest['targets']]
        with patch.object(producer.adapter,'checkpoint_inputs'),patch.object(producer.adapter,'public_readback',return_value=public),patch.object(producer.adapter,'remote',return_value=rows),patch.object(producer,'call') as call:
            with self.assertRaisesRegex(ValueError,'plan'):producer.run(self.config)
            call.assert_not_called()

class BindingRegression(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.journal=guard.Journal(self.temp.name)
        self.manifest=json.loads((producer.HERE/'candidate.json').read_text(encoding='utf-8'))
        self.ledger=driver.ledger_for(self.manifest,'7'*32);self.ledger['bundle_revision']='4'*64
        self.entry=self.ledger['entries'][0];self.backend=guard_tests.Backend()
    def request(self,action,sequence):
        return {'case_id':self.entry['case_id'],'action':action,'sequence':sequence,'bundle_revision':'4'*64,
          'ledger_canonical_sha256':guard.canonical_hash(self.ledger),'ledger_sha256':'6'*64}
    def runRequest(self,request):return guard.execute(request,self.ledger,self.manifest,self.backend,self.journal)
    def test_request_bundle_must_equal_ledger(self):
        request=self.request('seed',1);request['bundle_revision']='8'*64
        with self.assertRaisesRegex(ValueError,'bundle'):self.runRequest(request)
        self.assertEqual(self.backend.writes,0)
    def test_raw_ledger_binding_cannot_change_midstream(self):
        self.runRequest(self.request('seed',1));request=self.request('read',2);request['ledger_sha256']='9'*64
        with self.assertRaisesRegex(ValueError,'binding'):self.runRequest(request)
        self.assertEqual(self.backend.writes,1)

class FakeOwned:
    def __init__(self,*args):self.writing={'task1':'','task2':'','revision':0,'started':False,'submitted':False,'deadlineAt':None,'serverNow':'2026-10-04T00:00:00Z'}
    def guard(self,entry):pass
    def read(self,entry):
        return {**{key:entry['identity'][key] for key in ('attempt_id','marker','course_id','student_id')},
          'destination':entry['destination'],'ownership_checked':True,'child_tables':list(guard.child_tables({'name':entry['destination']['container']})),'children':[0]*len(guard.child_tables({'name':entry['destination']['container']})),'writing':copy.deepcopy(self.writing)}
    def seed(self,entry):
        self.writing.update(task1='',task2='',revision=0,started=False);return self.read(entry)
    def post(self,entry,payload):
        accepted=payload['action']=='start' or payload['baseRevision']==self.writing['revision']
        if payload['action']=='start':self.writing['started']=True;reason='started'
        elif accepted:self.writing.update(task1=payload['task1'],task2=payload['task2'],revision=self.writing['revision']+1);reason='saved'
        else:reason='revision_conflict'
        return {'status':200,'body':{'ok':True,'writing':{**copy.deepcopy(self.writing),'accepted':accepted,'reason':reason}}}
    def cleanup(self,entry):
        return {'status':'passed','attempt_id':entry['identity']['attempt_id'],'marker':entry['identity']['marker'],
          'destination':entry['destination'],'child_tables':list(guard.child_tables({'name':entry['destination']['container']})),'remaining':{'attempt':0,'marker':0,'children':[0]*len(guard.child_tables({'name':entry['destination']['container']}))}}

class EventRegression(unittest.TestCase):
    def test_actual_driver_retains_original_base_revision(self):
        manifest=json.loads((producer.HERE/'candidate.json').read_text(encoding='utf-8'))
        def exercise(manifest,core,ui_driver):
            for target in manifest['targets']:ui_driver(manifest,{'name':target['name']},'owned-api','owned-pg','owner')
            return {'cleanup':'verified_after_finally'}
        with patch.object(driver,'OwnedBackend',FakeOwned),patch.object(driver,'exercise',exercise):result=driver.run(manifest,'unused')
        self.assertEqual(len(result['entries']),7)
        for entry in result['entries']:
            posts=[event for event in entry['events'] if event['action']=='post']
            self.assertEqual([event['request']['payload']['baseRevision'] for event in posts],[0,0,0,1,1])

if __name__=='__main__':unittest.main()
