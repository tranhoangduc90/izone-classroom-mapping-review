"""Biên nhận cũ chỉ được tái dùng khi đúng UUID, nguồn đã duyệt và runtime."""
import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from test_acceptance_resume import fixture
from acceptance_provenance import SOURCES,canonical_sha,validate_prior,validate_reuse

class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup);self.root=Path(self.directory.name)
        request,executor,journal=fixture(self.root);self.request=request
        self.config={'run_id':request['acceptance_binding']['release_run_id'],'product_revision':'synthetic-bundle','candidate_checkpoint':'2'*40,'runtime_candidate_checkpoint':'1'*40,'acceptance_binding':request['acceptance_binding'],'acceptance_resume':request['acceptance_resume']}
        self.ledger={'run_id':request['run_id'],'identities':request['identities'],'manifest':request['manifest'],'acceptance_binding':request['acceptance_binding']}
        old_ledger={**self.ledger,'acceptance_binding':request['acceptance_resume']['previous_binding']}
        source_refs={};source_hashes={};checked={}
        for name in SOURCES:
            path=self.root/name;path.write_text('Synthetic old source: '+name,encoding='utf-8');digest=hashlib.sha256(path.read_bytes()).hexdigest();original='C:/synthetic/'+name
            source_refs[name]={'path':name,'sha256':digest,'original_path':original};source_hashes[name]=digest;checked[original]=digest
        old_config={key:self.config[key] for key in ('run_id','product_revision','runtime_candidate_checkpoint')}
        old_config.update(candidate_checkpoint='3'*40,acceptance_binding=request['acceptance_resume']['previous_binding'],evidence_dir='C:/synthetic/old-evidence')
        checked['C:/synthetic/release-config.json']=hashlib.sha256(json.dumps(old_config,ensure_ascii=False,indent=2).encode()).hexdigest()
        checked[str(Path(old_config['evidence_dir'])/'production-canary-ledger.json')]=hashlib.sha256(json.dumps(old_ledger,ensure_ascii=False,indent=2).encode()).hexdigest()
        plan={'helper_checkpoint':'3'*40,'runtime_checkpoint':'1'*40,'acceptance_binding':old_config['acceptance_binding'],'checked_inputs':checked,'config':'C:/synthetic/release-config.json','expected_after':{'api.classroom':{'revision':'synthetic-live'}}}
        plan['plan_digest']=canonical_sha(plan);self.config['acceptance_resume']['approved_package_digest']=plan['plan_digest']
        old_api={**json.loads(journal.read_text()),'producer_sources':source_hashes,'snapshots':{'api.classroom':{'revision':'synthetic-live'}}}
        approval={'plan_digest':plan['plan_digest'],'acceptance_authorized':True,'production_authorized':True}
        data={'old_plan':plan,'old_approval':approval,'old_config':old_config,'old_ledger':old_ledger,'old_api_database':old_api,'old_executor':json.loads(executor.read_text()),'old_journal':json.loads(journal.read_text())}
        refs={}
        for role,value in data.items():
            path=self.root/(role+'.json')
            # Executor/journal giữ nguyên byte đã đọc để CAS SHA khớp.
            if role=='old_executor':path.write_bytes(executor.read_bytes())
            elif role=='old_journal':path.write_bytes(journal.read_bytes())
            else:path.write_bytes(json.dumps(value,ensure_ascii=False,indent=2).encode('utf-8'))
            refs[role]={'path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        self.config['api_resume_provenance']={'artifacts':refs,'sources':source_refs,'helper_checkpoint':'3'*40}
        self.config['api_current_producer_sources']={name:'f'*64 for name in SOURCES}
        spec=self.config['acceptance_resume'];self.value={**old_api,'status':'passed_api_database','acceptance_resume':spec,'producer_sources':self.config['api_current_producer_sources'],'receipt_provenance':{name:({'epoch':'reused','journal_sha256':spec['journal_sha256'],'receipt_sha256':spec['reuse_receipt_sha256']} if index==0 else {'epoch':'current','acceptance_digest':self.config['acceptance_binding']['acceptance_digest']}) for index,name in enumerate(__import__('canary_remote').NAMES)}}
    def change(self,role,mutation):
        reference=self.config['api_resume_provenance']['artifacts'][role];path=self.root/reference['path'];value=json.loads(path.read_text());mutation(value);path.write_text(json.dumps(value,indent=2),encoding='utf-8');reference['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
    def test_valid_source_epoch_is_preserved(self):
        result=validate_reuse(self.config,self.root,self.ledger,self.value);self.assertEqual(result['status'],'passed')
    def test_changed_old_source_blocks_even_with_new_artifact_hash(self):
        name=next(iter(SOURCES));ref=self.config['api_resume_provenance']['sources'][name];path=self.root/ref['path'];path.write_text('Changed',encoding='utf-8');ref['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'producer_source_mismatch'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_wrong_approval_blocks(self):
        self.change('old_approval',lambda value:value.update(plan_digest='f'*64))
        with self.assertRaisesRegex(ValueError,'approval_invalid'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_wrong_old_identity_blocks(self):
        self.ledger['identities']=copy.deepcopy(self.ledger['identities']);self.ledger['identities'][0]['attempt_id']='00000000-0000-0000-0000-000000000001'
        with self.assertRaisesRegex(ValueError,'ledger_invalid'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_runtime_change_blocks(self):
        self.value['before']=[]
        with self.assertRaisesRegex(ValueError,'runtime_invalid'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_old_receipt_cannot_be_relabelled_current(self):
        self.value['receipt_provenance'][__import__('canary_remote').NAMES[0]]={'epoch':'current','acceptance_digest':self.config['acceptance_binding']['acceptance_digest']}
        with self.assertRaisesRegex(ValueError,'target_provenance'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_current_producer_changed_blocks(self):
        self.value['producer_sources']={name:'e'*64 for name in SOURCES}
        with self.assertRaisesRegex(ValueError,'current_producer'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_ui_ledger_bytes_change_blocks(self):
        self.config['acceptance_resume']['previous_binding']={**self.config['acceptance_resume']['previous_binding'],'ui_ledger_sha256':'f'*64}
        with self.assertRaisesRegex(ValueError,'old_binding'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_old_config_extra_field_and_fresh_hash_still_block(self):
        self.change('old_config',lambda value:value.update(unchecked_field='changed'))
        with self.assertRaisesRegex(ValueError,'config_bytes_unapproved'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_old_ledger_whitespace_and_fresh_hash_still_block(self):
        reference=self.config['api_resume_provenance']['artifacts']['old_ledger'];path=self.root/reference['path'];path.write_text(path.read_text()+'\n',encoding='utf-8');reference['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'ledger_bytes_unapproved'):validate_reuse(self.config,self.root,self.ledger,self.value)
    def test_two_changed_snapshots_cannot_override_approved_after(self):
        changed={'api.classroom':{'revision':'changed'}}
        self.change('old_api_database',lambda value:value.update(snapshots=changed));self.value['snapshots']=changed
        with self.assertRaisesRegex(ValueError,'snapshot_unapproved'):validate_reuse(self.config,self.root,self.ledger,self.value)

if __name__=='__main__':unittest.main()
