"""Kiểm primitive UI trên bảy danh tính giả, ba image và PostgreSQL thật.
Chỉ object có label/ID sở hữu; HTTP localhost fixture, không gọi production API.
Receipt này không thay Chrome/public asset/user-visible outcome sau phát hành.
"""
import copy,hashlib,json,tempfile,uuid
from pathlib import Path
import release_remote as r
import canary_remote as c
from ui_rpc_remote import ProductionBackend
from ui_rpc_guard import ENTRIES,DESTINATIONS,Journal,execute,canonical_hash,check
from exercise_canary_docker import exercise

class OwnedBackend(ProductionBackend):
    def __init__(self,manifest,apiid,pgid,owner):
        self.manifest=manifest;self.apiid=apiid;self.pgid=pgid;self.owner=owner
    def item(self,entry):
        # Fixture Internal dùng ID/label riêng; không mượn topology production.
        target=entry['destination']['container']
        return {'name':target,**entry['identity'],'test_slug':c.fixture_test_slug(target,entry['client'])}
    def sender_id(self,entry):
        self.guard(entry)
        return self.apiid
    def guard(self,entry):
        api=r.inspect(self.apiid);pg=r.inspect(self.pgid)
        check(api['Config']['Labels'].get('codex.fixture')==self.owner and pg['Config']['Labels'].get('codex.fixture')==self.owner,'fixture_owner_wrong')
        check(api['Id']==self.apiid and pg['Id']==self.pgid and api['State']['Running'] and pg['State']['Running'],'fixture_id_or_state_wrong')
        check(api['Image']==entry['destination']['image'],'fixture_image_wrong')
    def post(self,entry,payload):
        self.guard(entry)
        # Chỉ thay địa chỉ transport sang API ID đã xác minh label/image; dữ liệu/primitive giữ nguyên.
        private={**entry,'destination':{**entry['destination'],'container':self.apiid,'public_api_base':'http://127.0.0.1:8798'}}
        return super().post(private,payload)

def ledger_for(manifest,run):
    images={t['name']:t['candidate_image'] for t in manifest['targets']};entries=[]
    for i,(case_id,(client,target)) in enumerate(ENTRIES.items()):
        api,database=DESTINATIONS[target]
        entries.append({'case_id':case_id,'client':client,
          'identity':{'attempt_id':str(uuid.uuid4()),'student_ref':str(uuid.uuid4()),'marker':'CODEX_D08_'+run+'_'+str(i),
             'class_code':'CODEXDEMO56' if target.endswith('demo-api-1') else 'IC2264' if target=='izone-k56-ic2264-api' else 'IC2146',
             'course_id':c.DEMO_COURSE_ID if target==c.NAMES[2] else -3000000-i*2,'student_id':-3000001-i*2},
          'destination':{'container':target,'image':images[target],'public_api_base':api,'database':database}})
    return {'schema':'d08-ui-production-ledger/v1','run_id':run,'bundle_revision':'4'*64,'entries':entries}

def run(manifest,core):
    results=[];ledger=ledger_for(manifest,uuid.uuid4().hex)
    ledger_sha256=hashlib.sha256(json.dumps(ledger,ensure_ascii=False,indent=2).encode('utf-8')).hexdigest()
    def driver(manifest,item,apiid,pgid,owner):
        receipts=[]
        backend=OwnedBackend(manifest,apiid,pgid,owner)
        for entry in ledger['entries']:
            if entry['destination']['container']!=item['name']:continue
            with tempfile.TemporaryDirectory(prefix='codex-ui-rpc-fixture-') as folder:
                journal=Journal(folder);sequence=0;events=[]
                def call(action,payload=None):
                    nonlocal sequence
                    sequence+=1
                    request={'case_id':entry['case_id'],'action':action,'sequence':sequence,
                       'ledger_canonical_sha256':canonical_hash(ledger),'ledger_sha256':ledger_sha256,'bundle_revision':ledger['bundle_revision']}
                    if payload is not None:request['payload']=payload
                    value=execute(request,ledger,manifest,backend,journal)
                    # Bằng chứng giữ bytes logic tại lúc gửi, không giữ tham chiếu payload sẽ đổi.
                    events.append(copy.deepcopy({'action':action,'request':request,'value':value}))
                    return value
                identity=entry['identity']
                value=call('seed');check(value['writing']['revision']==0 and not value['writing']['started'],'fixture_seed_not_fresh')
                start={'attemptToken':identity['attempt_id'],'action':'start','task1':'','task2':'','baseRevision':0,'revision':0}
                response=call('post',start);check(response['body']['writing']['accepted'] is True,'fixture_start_not_accepted')
                after=call('read');check(after['writing']['started'] and after['writing']['revision']==0,'fixture_start_wrong_sql')
                draftB={**start,'action':'draft','task1':'B Task1 '+identity['marker'],'task2':'B Task2 '+identity['marker']}
                response=call('post',draftB);check(response['body']['writing']['accepted'] is True and response['body']['writing']['revision']==1,'fixture_b_not_saved')
                winner=call('read');check(winner['writing']['task1']==draftB['task1'] and winner['writing']['task2']==draftB['task2'] and winner['writing']['revision']==1,'fixture_b_sql_wrong')
                draftA={**start,'action':'draft','task1':'A Task1 '+identity['marker'],'task2':'A Task2 '+identity['marker']}
                response=call('post',draftA);writing=response['body']['writing']
                check(writing['accepted'] is False and writing['reason']=='revision_conflict' and writing['revision']==1 and writing['task1']==draftB['task1'] and writing['task2']==draftB['task2'],'fixture_stale_ack_wrong')
                after=call('read');check(after['writing']['task1']==draftB['task1'] and after['writing']['task2']==draftB['task2'] and after['writing']['revision']==1,'fixture_stale_overwrite')
                draftA['baseRevision']=1
                response=call('post',draftA);check(response['body']['writing']['accepted'] is True and response['body']['writing']['revision']==2,'fixture_explicit_local_not_saved')
                after=call('read');check(after['writing']['task1']==draftA['task1'] and after['writing']['task2']==draftA['task2'] and after['writing']['revision']==2,'fixture_local_sql_wrong')
                draftB['baseRevision']=1
                response=call('post',draftB);writing=response['body']['writing']
                check(writing['accepted'] is False and writing['reason']=='revision_conflict' and writing['revision']==2 and writing['task1']==draftA['task1'] and writing['task2']==draftA['task2'],'fixture_second_stale_ack_wrong')
                after=call('read');check(after['writing']['task1']==draftA['task1'] and after['writing']['task2']==draftA['task2'] and after['writing']['revision']==2,'fixture_second_stale_sql_wrong')
                cleanup=call('cleanup')
                check(not journal.lock.exists() and json.loads(journal.state.read_text(encoding='utf-8'))['phase']=='cleaned','fixture_journal_not_finished')
                receipts.append({'case_id':entry['case_id'],'identity':identity,'image':entry['destination']['image'],'status':'passed','events':events,'cleanup':cleanup,'scope':'owned_fixture_api_sql_only'})
        results.extend(receipts)
        return {'status':'passed','ui_primitive_receipts':receipts}
    fixture=exercise(manifest,core,ui_driver=driver)
    check(len(results)==7,'fixture_seven_not_complete')
    return {'status':'passed','entries':results,'fixture':fixture,'production_used':False,'browser_outcome':'not_run','scope':'actual production primitive code with owned Docker transport and PostgreSQL; no Chrome/public/prod profile claim'}
