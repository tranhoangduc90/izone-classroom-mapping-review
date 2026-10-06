"""Kiểm nhận lại seed sau mất ACK và từ chối nguồn/định danh sai, không nối VPS."""
from pathlib import Path
import copy
import importlib.util
import unittest
spec=importlib.util.spec_from_file_location('http_fixture',Path(__file__).resolve().parents[1]/'tools/prepare-http-fixture.py')
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)

class FixtureRecovery(unittest.TestCase):
    def setUp(self):
        self.state={'identity':helper.IDENTITY,'intent_id':'a'*32,'database':'term_mini_k67_test_live_'+'b'*12,
            'student_refs':{slug:'12345678-1234-4123-8123-1234567890a'+str(i) for i,slug in enumerate(helper.SLUGS)},
            'definition_hash':'c'*64}
        self.definitions=[{'slug':slug,'listening_band_adjustment':-0.5} for slug in helper.SLUGS]
        self.expected=helper.seed_expected(self.state,self.definitions)

    def test_commit_without_stage_ack_reuses_seed(self):
        # State chưa có seed ACK, nhưng DB đã commit nguyên mẫu: không INSERT lần nữa.
        committed=copy.deepcopy(self.expected)
        self.assertEqual(helper.classify_seed(committed,self.expected),'present')
        self.assertEqual(committed,self.expected)

    def test_empty_target_can_be_seeded_once(self):
        empty={key:(0 if key=='accounts' else []) for key in self.expected}
        self.assertEqual(helper.classify_seed(empty,self.expected),'empty')

    def test_partial_or_different_seed_is_not_overwritten(self):
        for key in ['definitions','classes','roster','members','context','accounts']:
            changed=copy.deepcopy(self.expected)
            changed[key]=1 if key=='accounts' else changed[key][:-1]
            before=copy.deepcopy(changed)
            with self.assertRaisesRegex(RuntimeError,'FIXTURE_SEED_MISMATCH'):
                helper.classify_seed(changed,self.expected)
            self.assertEqual(changed,before)
        changed=copy.deepcopy(self.expected);changed['definitions'][0]['listening_band_adjustment']=0
        with self.assertRaisesRegex(RuntimeError,'FIXTURE_SEED_MISMATCH'):helper.classify_seed(changed,self.expected)

    def test_wrong_intent_database_or_student_is_denied(self):
        helper.validate_state(self.state)
        for key,value in [('identity','other'),('intent_id','not-uuid'),('database','mapping_db')]:
            changed={**self.state,key:value}
            with self.assertRaises(RuntimeError):helper.validate_state(changed)
        changed=copy.deepcopy(self.state);changed['student_refs'][helper.SLUGS[0]]='bad'
        with self.assertRaises(ValueError):helper.validate_state(changed)

if __name__=='__main__':unittest.main(verbosity=2)
