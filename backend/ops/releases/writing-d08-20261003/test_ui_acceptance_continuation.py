"""File/transport giả kiểm tiếp tục UI; không gọi VPS, Docker hoặc endpoint thật.
Shared dùng parser HTTP/SQL/trace thật; nguồn Mapping F6 có bộ test riêng.
"""
import copy
import hashlib
import json
import tempfile
import unittest
import uuid
import zipfile
import subprocess
import datetime
import sys
from pathlib import Path
from unittest.mock import patch
import acceptance_cas as cas
import canary_remote as c
import ui_acceptance_continuation as subject
import ui_rpc_remote as remote
import browser_receipt as browser
from exercise_ui_rpc_docker import ledger_for
from test_acceptance_resume import fixture
import test_browser_receipt as browser_fixture
from ui_rpc_guard import canonical_hash

def encode(value):return json.dumps(value,ensure_ascii=False,indent=2).encode('utf-8')

def state_for(entry,ledger,ledger_hash):
    return {'sequence':11,'phase':'cleaned','binding':{'case_id':entry['case_id'],
        'bundle_revision':ledger['bundle_revision'],'ledger_sha256':ledger_hash,
        'ledger_canonical_sha256':canonical_hash(ledger),'database_bindings_sha256':'8'*64}}

def cleanup_for(entry):
    target=entry['destination']['container'];identity=entry['identity']
    return {'status':'passed','attempt_id':identity['attempt_id'],'marker':identity['marker'],
        'destination':entry['destination'],'child_tables':list(c.child_tables({'name':target})),
        'remaining':{'attempt':0,'marker':0,'children':[0]*len(c.child_tables({'name':target}))}}

def make_fixture(root,old_ledger=None,manifest=None):
    request,executor,_=fixture(root)
    manifest=manifest or {'targets':[{'name':name,'candidate_image':'synthetic'} for name in c.NAMES]}
    request['manifest']=manifest
    request['expected']=[{'name':row['name'],'image':row['candidate_image'],'running':True,'healthy':'healthy'} for row in manifest['targets']]
    old_ledger=old_ledger or ledger_for(manifest,'7'*32)
    old_source=encode(old_ledger);old_hash=cas.sha(old_source)
    old_binding={**request['acceptance_binding'],'ui_ledger_sha256':old_hash}
    new_ledger=copy.deepcopy(old_ledger)
    failed=next(e for e in new_ledger['entries'] if e['case_id']==subject.FAILED)
    failed['identity'].update(attempt_id=str(uuid.uuid4()),student_ref=str(uuid.uuid4()),
        marker='CODEX_D08_'+old_ledger['run_id']+'_8',course_id=-9000001,student_id=-9000002)
    new_source=encode(new_ledger)
    new_binding={**old_binding,'expected_generation':4,'acceptance_digest':'f'*64,'ui_ledger_sha256':cas.sha(new_source)}
    old_state={'generation':4,'status':'api_passed','binding':old_binding,'pid':99123}
    cas.replace_durable(executor,old_state)
    mapping=json.loads((root/request['run_id']/'canary.json').read_bytes())['receipts'][0]
    receipts=[]
    for identity in request['identities']:
        receipt=copy.deepcopy(mapping);receipt['target']=identity['name']
        receipt['api_database']['attempt_id']=identity['attempt_id']
        receipt['api_database']['final']['children']={table:0 for table in c.child_tables(identity)}
        receipt['cleanup']['attempt_id']=identity['attempt_id'];receipts.append(receipt)
    journal={'status':'passed_api_database','runtime_unchanged':True,'before':request['expected'],
        'after':request['expected'],'identities':request['identities'],'receipts':receipts}
    path=root/request['run_id']/'canary.generation-3.json';cas.save_exclusive(path,journal)
    spec={'schema':'d08-ui-continuation/v1','previous_binding':old_binding,
        'executor_sha256':cas.sha(executor.read_bytes()),'journal_sha256':cas.sha(path.read_bytes()),
        'approved_package_digest':subject.APPROVED_F7,'run_cases':[case for case in browser.ENTRIES if case!=subject.SHARED],
        'reuse_cases':[subject.SHARED],'replaced_case':subject.FAILED,'old_ui_journals':{}}
    bycase={e['case_id']:e for e in old_ledger['entries']}
    for case in (subject.SHARED,subject.FAILED):
        folder=root/old_ledger['run_id']/'ui-canary'/case;folder.mkdir(parents=True)
        state=state_for(bycase[case],old_ledger,old_hash);cleanup=cleanup_for(bycase[case])
        cas.save_exclusive(folder/'state.json',state);cas.save_exclusive(folder/'11.response.json',cleanup)
        spec['old_ui_journals'][case]={'state_sha256':cas.sha((folder/'state.json').read_bytes()),'cleanup_sha256':cas.sha((folder/'11.response.json').read_bytes())}
    request.pop('acceptance_resume')
    request.update(acceptance_binding=new_binding,acceptance_ui_resume=spec,api_receipt=journal,
        old_ui_ledger_source=old_source.decode(),ui_ledger_source=new_source.decode())
    return request,executor,path,old_ledger,new_ledger

class RemoteContinuation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.request,self.executor,self.journal,self.old,self.new=make_fixture(self.root)
        def query(item,sql):return [{'database':c.destination(item)[2],'existing':0,'children':0}]
        self.patchers=[patch.object(c.r,'RELEASE_ROOT',self.root),patch.object(c.r,'probe',return_value=self.request['expected']),
            patch.object(subject,'sender_stopped',return_value=True),patch.object(c.binding,'resolve',return_value={}),patch.object(c,'admin_query',side_effect=query)]
        for p in self.patchers:p.start();self.addCleanup(p.stop)
    def test_acquire_preserves_old_journal_and_creates_gen6_without_api(self):
        original=self.journal.read_bytes()
        with patch.object(c,'exercise') as api,patch.object(c,'cleanup') as cleanup,patch.object(c.subprocess,'run') as process:
            result=subject.acquire(self.request,c);api.assert_not_called();cleanup.assert_not_called();process.assert_not_called()
        self.assertTrue(result['api_reused']);self.assertEqual(self.journal.read_bytes(),original)
        self.assertEqual(c.require_acceptance(self.request['acceptance_binding'])['generation'],6)
        self.assertTrue(self.executor.with_name(self.executor.name+'.cas-generation-4.json').exists())
    def test_lost_response_never_claims_again(self):
        subject.acquire(self.request,c)
        with self.assertRaisesRegex(ValueError,'executor_changed'):subject.acquire(self.request,c)
    def test_api_replay_is_explicitly_blocked_before_probe(self):
        with patch.object(c.r,'probe') as probe:
            with self.assertRaisesRegex(RuntimeError,'api_replay_forbidden'):c.exercise(self.request)
            probe.assert_not_called()
    def test_alive_pid_blocks_without_changing_state(self):
        original=self.executor.read_bytes()
        with patch.object(subject,'sender_stopped',return_value=False):
            with self.assertRaisesRegex(ValueError,'pid_alive'):subject.acquire(self.request,c)
        self.assertEqual(self.executor.read_bytes(),original)
    def test_runtime_change_blocks(self):
        with patch.object(c.r,'probe',return_value=[]):
            with self.assertRaisesRegex(ValueError,'runtime_changed'):subject.acquire(self.request,c)
    def test_old_journal_hash_change_blocks(self):
        self.journal.write_bytes(self.journal.read_bytes()+b'\n')
        with self.assertRaisesRegex(ValueError,'journal_changed'):subject.acquire(self.request,c)
    def test_failed_identity_must_be_new(self):
        old=next(e for e in self.old['entries'] if e['case_id']==subject.FAILED)
        self.new['entries'][1]['identity']['attempt_id']=old['identity']['attempt_id'];self.request['ui_ledger_source']=encode(self.new).decode()
        self.request['acceptance_binding']['ui_ledger_sha256']=cas.sha(encode(self.new))
        with self.assertRaisesRegex(ValueError,'failed_identity_reused'):subject.acquire(self.request,c)
    def test_unrun_identity_cannot_change(self):
        self.new['entries'][2]['identity']['attempt_id']=str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError,'unfailed_identity_changed'):subject.validate_ledgers(self.old,self.new,self.request['manifest'])
    def test_unrun_previous_journal_blocks(self):
        (self.root/self.old['run_id']/'ui-canary'/self.old['entries'][2]['case_id']).mkdir()
        with self.assertRaisesRegex(ValueError,'unrun_case_has_journal'):subject.acquire(self.request,c)
    def test_new_namespace_must_be_absent_before_claim(self):
        (self.root/self.old['run_id']/'ui-canary-generation-6').mkdir()
        with self.assertRaisesRegex(ValueError,'new_namespace_preexisting'):subject.acquire(self.request,c)
    def test_remaining_fixture_blocks(self):
        with patch.object(c,'admin_query',return_value=[{'database':'mapping_db','existing':1,'children':0}]):
            with self.assertRaisesRegex(ValueError,'fixture_not_zero'):subject.acquire(self.request,c)
    def test_bad_cleanup_hash_blocks(self):
        self.request['acceptance_ui_resume']['old_ui_journals'][subject.FAILED]['cleanup_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'remote_ui_journal_changed'):subject.acquire(self.request,c)
    def test_competing_generation_cas_lock_blocks(self):
        cas.save_exclusive(self.executor.with_name(self.executor.name+'.cas-generation-4.json'),{})
        with self.assertRaises(FileExistsError):subject.acquire(self.request,c)
    def test_crash_after_pointer_keeps_gen5_blocked(self):
        original=cas.claim
        def crash(*args,**kwargs):original(*args,**kwargs);raise SystemExit('crash')
        with patch.object(cas,'claim',side_effect=crash):
            with self.assertRaises(SystemExit):subject.acquire(self.request,c)
        self.assertEqual(json.loads(self.executor.read_bytes())['generation'],5)
        with self.assertRaisesRegex(RuntimeError,'not_passed'):c.require_acceptance(self.request['acceptance_binding'])
    def test_error_after_pointer_writes_unknown_gen6_no_seed(self):
        with patch.object(c.r,'probe',side_effect=[self.request['expected']]*3+[[]]):
            with self.assertRaisesRegex(ValueError,'after_cas'):subject.acquire(self.request,c)
        self.assertEqual(json.loads(self.executor.read_bytes())['status'],'unknown')
        saved=json.loads((self.root/self.request['run_id']/'ui-continuation.generation-5.json').read_bytes())
        self.assertTrue(saved['no_seed_sent'])
    def packet(self,case):
        source=self.request['ui_ledger_source']
        return {'scope':'production_fixture','ledger':self.new,'ledger_source':source,'manifest':self.request['manifest'],
            'acceptance_binding':self.request['acceptance_binding'],'expected':self.request['expected'],'database_bindings':{},
            'request':{'case_id':case,'action':'seed','ledger_sha256':cas.sha(source.encode()),'database_bindings_sha256':canonical_hash({})}}
    def test_shared_mutation_blocked_before_backend_and_journal(self):
        subject.acquire(self.request,c)
        with patch.object(remote,'ProductionBackend') as backend,patch.object(remote,'Journal') as journal:
            with self.assertRaisesRegex(ValueError,'shared_mutation_forbidden'):remote.perform(self.packet(subject.SHARED))
            backend.assert_not_called();journal.assert_not_called()
    def test_new_namespace_and_exact_runtime_are_required(self):
        subject.acquire(self.request,c)
        with patch.object(remote,'ProductionBackend'),patch.object(remote,'execute',return_value={'status':'synthetic'}),patch.object(remote,'Journal') as journal:
            remote.perform(self.packet(subject.FAILED))
            self.assertEqual(journal.call_args.args[0],self.root/self.new['run_id']/'ui-canary-generation-6'/subject.FAILED)
        packet=self.packet(subject.FAILED);packet['expected']=[]
        with self.assertRaisesRegex(ValueError,'runtime_changed'):remote.perform(packet)

class LocalProvenance(unittest.TestCase):
    def setUp(self):
        # Dùng fixture browser thật của parser; không sinh biên nhận production.
        self.browser=browser_fixture.BrowserGuard();self.browser.setUp();self.addCleanup(self.browser.doCleanups)
        self.root=self.browser.root
        old=copy.deepcopy(self.browser.ledger);old['bundle_revision']='4'*64
        for entry in old['entries']:
            client,target=browser.ENTRIES[entry['case_id']];entry['client']=client
            entry['identity']['student_ref']=str(uuid.uuid4())
            entry['identity']['class_code']='CODEXDEMO56' if target==c.NAMES[2] else 'IC2264' if target==c.NAMES[1] else 'IC2146'
            if target==c.NAMES[2]:entry['identity']['course_id']=c.DEMO_COURSE_ID
        request,executor,journal,old,new=make_fixture(self.root,old,self.browser.manifest)
        self.request=request;self.new=new;self.old=old
        source_refs={};checked={};hashes={}
        for name in subject.SOURCES:
            path=self.root/('old-source-'+name);path.write_text('Synthetic approved F7 source '+name,encoding='utf-8')
            digest=cas.sha(path.read_bytes());original='C:/synthetic/F7/'+name
            source_refs[name]={'path':path.name,'sha256':digest,'original_path':original};checked[original]=digest;hashes[name]=digest
        old_config={'evidence_dir':'C:/synthetic/F7','run_id':request['acceptance_binding']['release_run_id'],
            'acceptance_binding':request['acceptance_ui_resume']['previous_binding'],'product_revision':'d08-bundle:'+'4'*64,
            'bundle_revision':'4'*64,'candidate_checkpoint':'2'*40,'runtime_candidate_checkpoint':'1'*40,'ui_producer_sha256':hashes['ui-canary.cjs'],
            'acceptance_resume':{'synthetic':'nested F6 contract retained'},'api_resume_provenance':{'synthetic':'nested F6 proofs retained'}}
        api={**request['api_receipt'],'snapshots':{'synthetic':'approved live runtime'},
            'producer_sources':{name:hashes[name] for name in subject.SOURCES if name!='ui-canary.cjs'}}
        api_ledger={'run_id':request['run_id'],'identities':request['identities'],'manifest':request['manifest'],'acceptance_binding':old_config['acceptance_binding']}
        checked['C:/synthetic/F7/config.json']=cas.sha(encode(old_config))
        checked[str(Path(old_config['evidence_dir'])/'production-ui-ledger.json')]=cas.sha(encode(old))
        checked[str(Path(old_config['evidence_dir'])/'production-canary-ledger.json')]=cas.sha(encode(api_ledger))
        plan={'config':'C:/synthetic/F7/config.json','checked_inputs':checked,'helper_checkpoint':'2'*40,'runtime_checkpoint':'1'*40,
            'acceptance_binding':old_config['acceptance_binding'],'expected_after':api['snapshots']}
        plan['plan_digest']=subject.canonical(plan)
        self.request['acceptance_ui_resume']['approved_package_digest']=plan['plan_digest']
        self.constant=patch.object(subject,'APPROVED_F7',plan['plan_digest']);self.constant.start();self.addCleanup(self.constant.stop)
        shared=self.browser.children[subject.SHARED]
        shared['identity']=old['entries'][0]['identity'];shared['binding']['ledger_sha256']=cas.sha(encode(old));shared['producer_source_sha256']=hashes['ui-canary.cjs']
        self.browser.write()
        data={'old_plan':plan,'old_config':old_config,'old_approval':{'plan_digest':plan['plan_digest'],'acceptance_authorized':True,'production_authorized':True},
            'old_api_ledger':api_ledger,'old_api_database':api,'old_ui_ledger':old,'old_public':self.browser.public,
            'old_executor':json.loads(executor.read_bytes()),'old_journal':json.loads(journal.read_bytes())}
        refs={}
        for role,value in data.items():
            path=self.root/(role+'.json');raw=executor.read_bytes() if role=='old_executor' else journal.read_bytes() if role=='old_journal' else encode(value)
            path.write_bytes(raw);refs[role]={'path':path.name,'sha256':cas.sha(raw)}
        refs['old_shared']=next({k:v for k,v in ref.items() if k!='case_id'} for ref in self.browser.aggregate['children'] if ref['case_id']==subject.SHARED)
        for case,prefix in ((subject.SHARED,'old_shared'),(subject.FAILED,'old_failed')):
            folder=self.root/old['run_id']/'ui-canary'/case
            for suffix,filename in (('state','state.json'),('cleanup','11.response.json')):
                path=folder/filename;refs[prefix+'_'+suffix]={'path':path.relative_to(self.root).as_posix(),'sha256':cas.sha(path.read_bytes())}
        (self.root/'production-ui-ledger.json').write_bytes(encode(new))
        self.config={**old_config,'candidate_checkpoint':'3'*40,'acceptance_binding':request['acceptance_binding'],
            'acceptance_ui_resume':request['acceptance_ui_resume'],'ui_producer_sha256':'f'*64,
            'ui_resume_provenance':{'artifacts':refs,'sources':source_refs}}
        self.config.pop('acceptance_resume');self.config.pop('api_resume_provenance')
        self.nested=patch('acceptance_provenance.validate_reuse',return_value={'status':'passed'})
        self.nested_mock=self.nested.start();self.addCleanup(self.nested.stop)
    def validate(self):return subject.validate_provenance(self.config,self.root,self.new,self.browser.public,self.browser.manifest)
    def change(self,role,mutation):
        ref=self.config['ui_resume_provenance']['artifacts'][role];path=self.root/ref['path'];value=json.loads(path.read_bytes());mutation(value);path.write_bytes(encode(value));ref['sha256']=cas.sha(path.read_bytes())
    def test_valid_shared_runs_full_business_parser_and_retains_old_binding(self):
        value=self.validate();self.assertEqual(value['shared_ref']['case_id'],subject.SHARED)
        self.assertEqual(value['old_ledger_hash'],self.request['acceptance_ui_resume']['previous_binding']['ui_ledger_sha256'])
        args=self.nested_mock.call_args.args;self.assertEqual(args[0]['acceptance_binding'],self.request['acceptance_ui_resume']['previous_binding'])
        self.assertEqual(args[1],self.root);self.assertEqual(args[3],value['api'])
    def test_wrong_old_approval_blocks(self):
        self.change('old_approval',lambda x:x.update(acceptance_authorized=False))
        with self.assertRaisesRegex(ValueError,'approval_invalid'):self.validate()
    def test_extra_config_field_cannot_gain_approval_by_refreshing_ref(self):
        self.change('old_config',lambda x:x.update(unexamined=True))
        with self.assertRaisesRegex(ValueError,'config_unapproved'):self.validate()
    def test_old_ui_ledger_whitespace_refresh_cannot_gain_approval(self):
        ref=self.config['ui_resume_provenance']['artifacts']['old_ui_ledger'];path=self.root/ref['path'];path.write_bytes(path.read_bytes()+b'\n');ref['sha256']=cas.sha(path.read_bytes())
        with self.assertRaisesRegex(ValueError,'ledger_unapproved'):self.validate()
    def test_wrong_old_producer_even_refreshed_hash_blocks(self):
        ref=self.config['ui_resume_provenance']['sources']['canary_remote.py'];path=self.root/ref['path'];path.write_text('Changed producer',encoding='utf-8');ref['sha256']=cas.sha(path.read_bytes())
        with self.assertRaisesRegex(ValueError,'producer_unapproved'):self.validate()
    def test_shared_receipt_other_producer_blocks(self):
        self.change('old_shared',lambda x:x.update(producer_source_sha256='0'*64))
        with self.assertRaisesRegex(ValueError,'producer_source'):self.validate()
    def test_shared_false_passed_without_business_checks_blocks(self):
        self.change('old_shared',lambda x:x.update(events=[]))
        with self.assertRaisesRegex(ValueError,'required_reads_missing'):self.validate()
    def test_runtime_snapshot_changed_blocks(self):
        self.change('old_api_database',lambda x:x.update(snapshots={'changed':'runtime'}))
        with self.assertRaisesRegex(ValueError,'snapshot_unapproved'):self.validate()
    def test_shared_cleanup_nonzero_blocks(self):
        self.change('old_shared',lambda x:x['cleanup']['remaining'].update(marker=1))
        with self.assertRaisesRegex(ValueError,'cleanup_guard'):self.validate()
    def test_only_shared_subset_can_be_used(self):
        with self.assertRaisesRegex(ValueError,'subset_forbidden'):
            browser.validate(self.browser.aggregate,self.old,cas.sha(encode(self.old)),self.browser.config,self.browser.manifest,self.browser.public,self.root,case_subset={subject.FAILED})
    def mixed_aggregate(self):
        refs=[{'case_id':subject.SHARED,**self.config['ui_resume_provenance']['artifacts']['old_shared']}]
        old_bycase={entry['case_id']:entry for entry in self.old['entries']}
        ledger_hash=cas.sha(encode(self.new))
        for entry in self.new['entries']:
            case=entry['case_id']
            if case==subject.SHARED:continue
            previous=old_bycase[case]['identity'];identity=entry['identity']
            source=json.dumps(self.browser.children[case])
            for key in ('attempt_id','marker'):source=source.replace(previous[key],identity[key])
            child=json.loads(source);child['identity']=identity
            child['binding'].update(ledger_sha256=ledger_hash);child['producer_source_sha256']=self.config['ui_producer_sha256']
            child['cleanup']=cleanup_for(entry)
            for event in child['events']:
                if event['kind']=='database_read':event['value'].update(course_id=identity['course_id'],student_id=identity['student_id'])
            folder=self.root/case
            for tab,label in enumerate(('A','B')):
                trace=folder/('trace-'+str(tab)+'.zip');lines=[]
                with zipfile.ZipFile(trace,'w') as archive:
                    for event in child['events']:
                        if event['kind']!='api_response' or event['label']!=label:continue
                        body=json.dumps(event['response']['body']).encode();resource=hashlib.sha1(body).hexdigest()+'.json'
                        archive.writestr('resources/'+resource,body)
                        lines.append(json.dumps({'snapshot':{'request':{'method':'POST','url':'http://127.0.0.1/fixture-api/api/term-tests/writing','postData':{'text':json.dumps(event['payload'])}},'response':{'status':200,'content':{'_sha1':resource}}}}))
                    archive.writestr('trace.network','\n'.join(lines)+'\n')
                child['artifacts'][trace.name]=cas.sha(trace.read_bytes())
            path=folder/'receipt.json';path.write_bytes(encode(child))
            refs.append({'case_id':case,'path':path.relative_to(self.root).as_posix(),'sha256':cas.sha(path.read_bytes())})
        return {'schema':'d08-ui-production-outcome/v1','status':'passed','children':refs,'acceptance_ui_resume':self.config['acceptance_ui_resume']}
    def test_final_parser_requires_all7_with_only_shared_old_epoch(self):
        aggregate=self.mixed_aggregate()
        result=browser.validate(aggregate,self.new,cas.sha(encode(self.new)),self.config,self.browser.manifest,self.browser.public,self.root)
        self.assertEqual(result['children_checked'],7)
        aggregate['children'].pop()
        with self.assertRaisesRegex(ValueError,'child_set'):browser.validate(aggregate,self.new,cas.sha(encode(self.new)),self.config,self.browser.manifest,self.browser.public,self.root)
    def test_other_child_cannot_use_old_shared_producer(self):
        aggregate=self.mixed_aggregate();ref=aggregate['children'][1];path=self.root/ref['path'];child=json.loads(path.read_bytes())
        child['producer_source_sha256']=json.loads((self.root/self.config['ui_resume_provenance']['artifacts']['old_shared']['path']).read_bytes())['producer_source_sha256']
        path.write_bytes(encode(child));ref['sha256']=cas.sha(path.read_bytes())
        with self.assertRaisesRegex(ValueError,'producer_source'):browser.validate(aggregate,self.new,cas.sha(encode(self.new)),self.config,self.browser.manifest,self.browser.public,self.root)
    def test_shared_reference_swap_is_blocked(self):
        aggregate=self.mixed_aggregate();aggregate['children'][0]={**aggregate['children'][1],'case_id':subject.SHARED}
        with self.assertRaisesRegex(ValueError,'shared_reference_changed'):browser.validate(aggregate,self.new,cas.sha(encode(self.new)),self.config,self.browser.manifest,self.browser.public,self.root)
    def test_producer_only_seeds6_and_reuses_shared_reference(self):
        import ui_producer as producer
        # Chỉ giả ổ đĩa cho guard; resolve/join/read vẫn dùng đường file tạm thật.
        class LocalCPath:
            def __init__(self,value):self.actual=Path(value)
            @property
            def drive(self):return 'C:'
            def resolve(self):return LocalCPath(self.actual.resolve())
            def __truediv__(self,value):return self.actual/value
            def __fspath__(self):return str(self.actual)
        (self.root/'candidate.json').write_bytes(encode(self.browser.manifest))
        (self.root/'ui-canary.cjs').write_text('Synthetic new source',encoding='utf-8')
        config={**self.config,'evidence_dir':str(self.root)}
        plan={'entries':[{**entry,'asset_hashes':browser.expected_assets(entry['client'],self.browser.public)} for entry in self.new['entries']]}
        (self.root/'production-ui-plan.json').write_bytes(encode(plan))
        shared_ref=self.validate()['shared_ref'];calls=[]
        def call(config,case,action):calls.append((case,action))
        def run(command,**kwargs):
            packet=json.loads(Path(command[2]).read_bytes());entry=packet['entries'][0];folder=self.root/'browser'/entry['case_id'];folder.mkdir(parents=True)
            (folder/'receipt.json').write_bytes(encode({'status':'passed'}))
            return subprocess.CompletedProcess(command,0,'','')
        with (patch.object(producer,'HERE',self.root),patch.object(producer,'Path',LocalCPath),patch.object(producer.adapter,'checkpoint_inputs'),
                patch.object(producer,'validate_plan'),patch.object(producer.adapter,'public_readback',return_value=self.browser.public),
                patch.object(subject,'validate_provenance',return_value={'shared_ref':shared_ref}),patch.object(producer.adapter,'remote',return_value=self.request['expected']),
                patch.object(producer,'capture_database_bindings'),patch.object(producer,'call',side_effect=call),patch.object(producer.subprocess,'run',side_effect=run)):
            result=producer.run(config)
        self.assertEqual(result['entries'],7)
        self.assertEqual(calls,[(case,'seed') for case in self.config['acceptance_ui_resume']['run_cases']])
        aggregate=json.loads((self.root/'production-ui-browser.json').read_bytes());self.assertEqual(aggregate['children'][0],shared_ref)
    def outcome(self):
        import outcome_receipt as outcome
        proof=self.validate();aggregate=self.mixed_aggregate();old_refs=self.config['ui_resume_provenance']['artifacts']
        refs=[{'role':role,**old_refs[old]} for role,old in [('ledger','old_api_ledger'),('api_database','old_api_database')]]
        data={'browser':aggregate,'browser_ledger':self.new,'docs_boundary':{},'attendance_preservation':{},'runtime_observation':{}}
        for role,content in data.items():
            path=self.root/('final-'+role+'.json');raw=(self.root/'production-ui-ledger.json').read_bytes() if role=='browser_ledger' else encode(content)
            path.write_bytes(raw);refs.append({'role':role,'path':path.name,'sha256':cas.sha(raw)})
        value={'schema_version':1,'status':'passed','product_revision':self.config['product_revision'],'candidate_checkpoint':self.config['candidate_checkpoint'],
            'release_run_id':self.config['run_id'],'snapshots':proof['api']['snapshots'],'public_assets':self.browser.public,
            'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'canary_run_id':proof['api_ledger']['run_id'],
            'cleanup_verified':True,'artifacts':refs}
        return outcome,value,proof['api']['snapshots']
    def test_outcome_reuses_exact_api_then_still_requires_operational_roles(self):
        outcome,value,snapshots=self.outcome()
        with self.assertRaisesRegex(ValueError,'docs_boundary_missing_or_wrong_revision'):
            outcome.validate(value,self.config,snapshots,self.browser.public,self.root,self.browser.manifest)
    def test_outcome_api_whitespace_cannot_relabel_raw_proof(self):
        outcome,value,snapshots=self.outcome();ref=next(r for r in value['artifacts'] if r['role']=='api_database')
        path=self.root/'changed-api.json';path.write_bytes((self.root/ref['path']).read_bytes()+b'\n');ref.update(path=path.name,sha256=cas.sha(path.read_bytes()))
        with self.assertRaisesRegex(ValueError,'api_bytes_changed'):
            outcome.validate(value,self.config,snapshots,self.browser.public,self.root,self.browser.manifest)
    def test_outcome_api_cannot_be_rebound_to_current_generation(self):
        outcome,value,snapshots=self.outcome();ref=next(r for r in value['artifacts'] if r['role']=='api_database')
        data=json.loads((self.root/ref['path']).read_bytes());data['acceptance_binding']=self.config['acceptance_binding']
        path=self.root/'rebound-api.json';path.write_bytes(encode(data));ref.update(path=path.name,sha256=cas.sha(path.read_bytes()))
        with self.assertRaisesRegex(ValueError,'api_proof_relabelled'):
            outcome.validate(value,self.config,snapshots,self.browser.public,self.root,self.browser.manifest)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    unittest.main(verbosity=2)
