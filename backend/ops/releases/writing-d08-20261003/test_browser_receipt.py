"""Dữ liệu giả kiểm cổng UI: đích, asset, HTTP/SQL và cleanup phải nối đúng.
Fixture chỉ thuộc unit test; không phải bằng chứng đã chạy production.
"""
import copy,hashlib,importlib.util,json,tempfile,unittest,uuid,zipfile
from pathlib import Path
HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('browser_receipt',HERE/'browser_receipt.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)


class BrowserGuard(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.config={'product_revision':'d08-bundle:'+'4'*64,'ui_producer_sha256':'5'*64}
        self.manifest={'targets':[{'name':name,'candidate_image':'sha256:'+str(i+1)*64} for i,name in enumerate(b.DESTINATIONS)]}
        images={t['name']:t['candidate_image'] for t in self.manifest['targets']}
        self.public={'status':'passed','assets':[]}
        for client in ('shared','k56-shared','k56-mini-shared','k56-test2-shared'):
            for name in ('app.js','styles.css','config.js'):
                self.public['assets'].append({'path':'term-tests/'+client+'/'+name,'sha256':hashlib.sha256((client+'/'+name).encode()).hexdigest()})
        self.public['assets'].append({'path':'term-tests/k56-exam-order.js','sha256':'6'*64})
        template=json.loads((HERE/'browser-events.fixture.json').read_text(encoding='utf-8'))
        run='7'*32;entries=[];self.children={}
        for index,(case_id,(client,target)) in enumerate(b.ENTRIES.items()):
            identifier=str(uuid.uuid4());marker='CODEX_D08_'+run+'_'+str(index)
            child=json.loads(json.dumps(template).replace(template['identity']['attempt_id'],identifier).replace(template['identity']['marker'],marker))
            identity={**child['identity'],'course_id':-1000001-index*2,'student_id':-1000002-index*2}
            destination={'container':target,'image':images[target],'public_api_base':b.DESTINATIONS[target][0],'database':b.DESTINATIONS[target][1]}
            entries.append({'case_id':case_id,'identity':identity,'destination':destination})
            child.update({'scope':'production_fixture','status':'passed','client':client,'identity':identity,
                          'assetHashes':b.expected_assets(client,self.public),'config_selected_api':destination['public_api_base'],
                          'producer_source_sha256':self.config['ui_producer_sha256'],'pending_http':0,'contexts_closed':True,'errors':[],
                          'started_at':'2026-10-04T06:20:00Z','finished_at':'2026-10-04T06:22:00Z'})
            child['public_assets']={'status':'passed','assets':{key:{'status':200,'sha256':sha} for key,sha in child['assetHashes'].items()}}
            for event in child['events']:
                if event['kind']=='database_read':event['value'].update({'course_id':identity['course_id'],'student_id':identity['student_id'],'ownership_checked':True,'destination':destination})
            child['cleanup']={'status':'passed','attempt_id':identifier,'marker':marker,'destination':destination,'remaining':{'attempt':0,'marker':0,'children':[0]*5}}
            folder=self.root/case_id;folder.mkdir()
            child['artifacts']={}
            for name in b.ARTIFACTS:
                raw=('synthetic unit artifact '+case_id+' '+name).encode();(folder/name).write_bytes(raw)
                child['artifacts'][name]=hashlib.sha256(raw).hexdigest()
            for tab,label in enumerate(('A','B')):
                trace=folder/('trace-'+str(tab)+'.zip')
                events=[e for e in child['events'] if e['kind']=='api_response' and e['label']==label]
                lines=[]
                with zipfile.ZipFile(trace,'w') as archive:
                    for i,event in enumerate(events):
                        body=json.dumps(event['response']['body']).encode()
                        reference=hashlib.sha1(body).hexdigest()+'.json'
                        archive.writestr('resources/'+reference,body)
                        lines.append(json.dumps({'snapshot':{'request':{'method':'POST','url':'http://127.0.0.1/fixture-api/api/term-tests/writing','postData':{'text':json.dumps(event['payload'])}},'response':{'status':event['response']['status'],'content':{'_sha1':reference}}}}))
                    archive.writestr('trace.network','\n'.join(lines)+'\n')
                child['artifacts'][trace.name]=hashlib.sha256(trace.read_bytes()).hexdigest()
            self.children[case_id]=child
        self.ledger={'schema':'d08-ui-production-ledger/v1','run_id':run,'entries':entries}
        self.ledger_hash=hashlib.sha256(json.dumps(self.ledger,sort_keys=True).encode()).hexdigest()
        for entry in entries:
            self.children[entry['case_id']]['binding']={'schema':'d08-ui-bridge/v1','run_id':run,'ledger_sha256':self.ledger_hash,
              'bundle_revision':'4'*64,'destination':entry['destination']}
        self.write()

    def write(self):
        refs=[]
        for case_id,child in self.children.items():
            file=self.root/case_id/'receipt.json';file.write_text(json.dumps(child),encoding='utf-8')
            refs.append({'case_id':case_id,'path':case_id+'/receipt.json','sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
        self.aggregate={'schema':'d08-ui-production-outcome/v1','status':'passed','children':refs}

    def validate(self):return b.validate(self.aggregate,self.ledger,self.ledger_hash,self.config,self.manifest,self.public,self.root)
    def child(self):return self.children['shared-mapping']
    def assertBlocked(self,code):
        self.write()
        with self.assertRaisesRegex(ValueError,code):self.validate()

    def test_complete_synthetic_contract(self):self.assertEqual(self.validate()['children_checked'],7)
    def test_offline_not_production(self):self.child()['scope']='offline_actual_sql';self.assertBlocked('offline')
    def test_wrong_asset_hash(self):self.child()['assetHashes']['app']='0'*64;self.assertBlocked('assets')
    def test_public_asset_get_missing(self):self.child()['public_assets']['assets'].pop('app');self.assertBlocked('public_get')
    def test_wrong_api_configuration(self):self.child()['config_selected_api']='https://example.invalid';self.assertBlocked('api')
    def test_wrong_image_binding(self):self.child()['binding']['destination']={**self.child()['binding']['destination'],'image':'sha256:other'};self.assertBlocked('binding')
    def test_sql_wrong_student(self):self.child()['events'][0]['value']['student_id']=-9999999;self.assertBlocked('sql_destination')
    def test_sql_child_side_effect(self):self.child()['events'][0]['value']['children'][4]=1;self.assertBlocked('child_or_submit')
    def test_stale_overwrites_canonical(self):
        row=next(e for e in self.child()['events'] if e.get('label')=='after_stale');row['value']['writing']['task2']='lost';self.assertBlocked('stale_overwrite')
    def test_conflict_ack_is_falsely_success(self):
        e=next(e for e in self.child()['events'] if e['kind']=='api_response' and e['payload']['action']=='draft' and e['label']=='A');e['response']['body']['writing']['accepted']=True;self.assertBlocked('ack_canonical')
    def test_extra_automatic_post(self):
        e=copy.deepcopy(next(e for e in self.child()['events'] if e['kind']=='api_response'));e['at']=self.child()['events'][-1]['at'];self.child()['events'].append(e);self.assertBlocked('dispatch_ack')
    def test_submit_forbidden(self):
        e=next(e for e in self.child()['events'] if e['kind']=='browser_dispatch');e['payload']['action']='submit';self.assertBlocked('action')
    def test_wrong_uuid_for_post(self):
        e=next(e for e in self.child()['events'] if e['kind']=='browser_dispatch');e['payload']['attemptToken']=str(uuid.uuid4());self.assertBlocked('identity')
    def test_cleanup_marker_remaining(self):self.child()['cleanup']['remaining']['marker']=1;self.assertBlocked('cleanup')
    def test_pending_bool_not_count(self):self.child()['pending_http']=False;self.assertBlocked('pending')
    def test_incomplete_browser_context_close(self):self.child()['contexts_closed']=False;self.assertBlocked('pending')
    def test_ledger_duplicate_uuid(self):
        self.ledger['entries'][1]['identity']['attempt_id']=self.ledger['entries'][0]['identity']['attempt_id']
        with self.assertRaises(ValueError):self.validate()
    def test_missing_child_or_artifact(self):self.child()['artifacts'].pop('trace-0.zip');self.assertBlocked('artifacts')
    def test_unrelated_trace_with_valid_hash_blocks(self):
        file=self.root/'shared-mapping'/'trace-0.zip'
        with zipfile.ZipFile(file,'w') as archive:archive.writestr('trace.network','')
        self.child()['artifacts']['trace-0.zip']=hashlib.sha256(file.read_bytes()).hexdigest()
        self.assertBlocked('trace_uuid_payload_ack')
    def blob_trace(self, wrong_uuid=False):
        file=self.root/'shared-mapping'/'trace-0.zip'
        with zipfile.ZipFile(file) as archive:data={name:archive.read(name) for name in archive.namelist()}
        rows=[json.loads(line) for line in data['trace.network'].decode().splitlines()]
        for row in rows:
            post=row['snapshot']['request']['postData']
            payload=json.loads(post['text'])
            if wrong_uuid:payload['attemptToken']=str(uuid.uuid4())
            raw=json.dumps(payload).encode();sha=hashlib.sha1(raw).hexdigest()
            post.update({'text':'','_sha1':sha});data['resources/'+sha]=raw
        data['trace.network']=('\n'.join(json.dumps(row) for row in rows)+'\n').encode()
        with zipfile.ZipFile(file,'w') as archive:
            for name,raw in data.items():archive.writestr(name,raw)
        self.child()['artifacts']['trace-0.zip']=hashlib.sha256(file.read_bytes()).hexdigest()
        self.write()

    def test_trace_post_body_resource_is_read(self):
        self.blob_trace();self.assertEqual(self.validate()['status'],'passed')

    def test_trace_body_other_uuid_even_valid_hash_blocks(self):
        self.blob_trace(wrong_uuid=True)
        with self.assertRaisesRegex(ValueError,'trace_uuid_payload_ack'):self.validate()

    def test_wrong_producer_source(self):self.child()['producer_source_sha256']='8'*64;self.assertBlocked('producer')


if __name__=='__main__':unittest.main(verbosity=2)
