"""Chỉ dùng lại lớp giả -560001 ở đúng demo; mọi định danh bài/học viên vẫn riêng.
Không gọi Docker/DB; kiểm input và metadata trước các phép thử PostgreSQL riêng.
"""
import copy,json,unittest
from pathlib import Path
import canary_remote as c
from test_canary_guard import fixture
from exercise_ui_rpc_docker import ledger_for
from ui_rpc_guard import validate_ledger
from ui_rpc_remote import ProductionBackend

class ExistingDemoCourse(unittest.TestCase):
    def setUp(self):
        self.manifest=json.loads((Path(__file__).parent/'candidate.json').read_text(encoding='utf-8'))

    def test_api_accepts_only_reserved_demo_course(self):
        value=fixture();value['identities'][2]['course_id']=-560001
        self.assertEqual(c.validate(value),value['identities'])

    def test_reserved_course_is_blocked_on_real_target_or_student_identity(self):
        for index,key in [(0,'course_id'),(1,'course_id'),(2,'student_id')]:
            value=fixture();value['identities'][index][key]=-560001
            with self.assertRaises(RuntimeError):c.validate(value)

    def test_other_demo_course_outside_fixture_range_is_blocked(self):
        for number in [-560002,-1,0,1,True]:
            value=fixture();value['identities'][2]['course_id']=number
            with self.assertRaises(RuntimeError):c.validate(value)

    def test_ui_shares_reserved_class_but_not_attempt_or_student(self):
        ledger=ledger_for(self.manifest,'5'*32)
        demo=[e for e in ledger['entries'] if e['destination']['container']==c.NAMES[2]]
        for entry in demo:entry['identity']['course_id']=-560001
        self.assertEqual(validate_ledger(ledger,self.manifest),ledger['entries'])
        for key in ['attempt_id','student_id']:
            broken=copy.deepcopy(ledger)
            rows=[e for e in broken['entries'] if e['destination']['container']==c.NAMES[2]]
            rows[1]['identity'][key]=rows[0]['identity'][key]
            with self.assertRaises(ValueError):validate_ledger(broken,self.manifest)

    def test_ui_existing_course_requires_exact_demo_destination_and_class(self):
        for kind in ['real','wrong_class','wrong_course']:
            ledger=ledger_for(self.manifest,'6'*32)
            entry=ledger['entries'][0] if kind=='real' else next(e for e in ledger['entries'] if e['destination']['container']==c.NAMES[2])
            entry['identity']['course_id']=-560001 if kind!='wrong_course' else -560002
            if kind=='wrong_class':entry['identity']['class_code']='OTHER_CLASS'
            with self.assertRaises(ValueError):validate_ledger(ledger,self.manifest)

    def test_ui_seed_metadata_uses_exact_client_test_slug(self):
        bindings={name:{'api_id':'a'*64,'db_id':'d'*64} for name in c.NAMES}
        backend=ProductionBackend(self.manifest,[],bindings)
        ledger=ledger_for(self.manifest,'7'*32)
        expected={'shared':'term-test-1','k56-shared':'term-test-1-k56',
                  'k56-mini-shared':'mini-test-k56','k56-test2-shared':'term-test-2-k56'}
        for entry in ledger['entries']:
            self.assertEqual(backend.item(entry)['test_slug'],expected[entry['client']])

if __name__=='__main__':unittest.main()
