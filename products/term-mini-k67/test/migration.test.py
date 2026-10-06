"""Kiểm bản phục hồi có hạn chờ, giữ nguyên byte COPY và đọc lại tính toàn vẹn.

Dữ liệu giả không có thông tin học viên; sai hàng, khóa ngoại, lịch sử hoặc bộ
đếm ID phải báo lỗi, kể cả khi lần ghi trước đã xong nhưng mất phản hồi.
"""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import importlib.util
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('migration',ROOT/'tools/rehearse-migration.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class RestoreStream(unittest.TestCase):
    def fixture(self):
        structure={'columns':[{'table':name,'column':'id'} for name in module.TABLES],
            'sequences':[{'name':'term_test_temporary_student_id_seq'}]}
        lines=[b'SET statement_timeout = 0;',b'SET lock_timeout = 0;',
            b'SET idle_in_transaction_session_timeout = 0;']
        payload='Tiếng Việt\u2028giữ nguyên\\n\\t'.encode()
        for name in module.TABLES:
            lines.extend([('COPY assessment.'+name+' (id) FROM stdin;').encode(),payload,b'\\.'])
        lines.append(b"SELECT pg_catalog.setval('assessment.term_test_temporary_student_id_seq', 17, true);")
        return b'\n'.join(lines)+b'\n',structure,payload
    def test_copy_bytes_preserved_and_timeouts_bounded(self):
        raw,structure,payload=self.fixture();result=module.restore_stream(raw,structure)
        self.assertEqual(result['bytes'].count(payload),13)
        self.assertIn(payload,raw);self.assertEqual(len(result['headers']),3)
        self.assertEqual(result['sequences'],{'term_test_temporary_student_id_seq':{'last_value':17,'is_called':True}})
        self.assertNotIn(b'SET statement_timeout = 0;',result['bytes'])
        self.assertTrue(result['bytes'].endswith(b'\n'))
    def test_copy_content_resembling_set_is_not_rewritten(self):
        raw,structure,_=self.fixture();raw=raw.replace(b'Ti',b'SET statement_timeout = 0;\nTi',1)
        self.assertIn(b'SET statement_timeout = 0;',module.restore_stream(raw,structure)['bytes'])
    def test_missing_table_rejected(self):
        raw,structure,payload=self.fixture()
        raw=raw.replace(('COPY assessment.'+module.TABLES[0]+' (id) FROM stdin;\n').encode()+payload+b'\n\\.\n',b'')
        with self.assertRaisesRegex(RuntimeError,'SCOPE_INCOMPLETE'):module.restore_stream(raw,structure)
    def test_wrong_columns_rejected(self):
        raw,structure,_=self.fixture()
        with self.assertRaisesRegex(RuntimeError,'COLUMNS_INVALID'):module.restore_stream(raw.replace(b'(id)',b'(other)',1),structure)
    def test_timeout_header_after_copy_rejected(self):
        raw,structure,_=self.fixture()
        with self.assertRaisesRegex(RuntimeError,'TIMEOUT_HEADER_INVALID'):module.restore_stream(raw+b'SET statement_timeout = 0;\n',structure)
    def test_missing_sequence_rejected(self):
        raw,structure,_=self.fixture();raw=raw[:raw.index(b'SELECT pg_catalog.setval')]
        with self.assertRaisesRegex(RuntimeError,'SCOPE_INCOMPLETE'):module.restore_stream(raw,structure)
    def test_duplicate_sequence_rejected(self):
        raw,structure,_=self.fixture()
        with self.assertRaisesRegex(RuntimeError,'SETVAL_INVALID'):module.restore_stream(raw+raw[raw.index(b'SELECT pg_catalog.setval'):],structure)


class CompleteReadback(unittest.TestCase):
    def run_case(self,rows=None,triggers=None,orphans=0,sequence=None):
        document={'rows':{'test_definition':{'count':1,'sha256':'same'}},
            'sequence_values':{'term_test_temporary_student_id_seq':{'last_value':17,'is_called':True}}}
        observations=[rows if rows is not None else document['rows'],
            triggers if triggers is not None else {'history':26,'disabled':0},
            {'link':orphans},sequence if sequence is not None else {'last_value':17,'is_called':True}]
        foreign=[{'name':'link','table':'term_test_attempt','target':'test_definition','column':'test_slug','target_column':'test_slug'}]
        with patch.object(module,'query',side_effect=observations):
            return module.readback_complete(None,None,SimpleNamespace(PG='own'), 'own-test',document,foreign)
    def test_success_reads_every_integrity_layer(self):
        result=self.run_case();self.assertEqual(result['foreign_keys'],1);self.assertEqual(result['sequences'],1)
    def test_row_mismatch_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'ROW_READBACK_MISMATCH'):self.run_case(rows={})
    def test_missing_history_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'TRIGGER_READBACK_MISMATCH'):self.run_case(triggers={'history':25,'disabled':0})
    def test_disabled_trigger_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'TRIGGER_READBACK_MISMATCH'):self.run_case(triggers={'history':26,'disabled':1})
    def test_orphan_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'FOREIGN_KEY_READBACK_MISMATCH'):self.run_case(orphans=1)
    def test_stale_sequence_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'SEQUENCE_READBACK_MISMATCH'):self.run_case(sequence={'last_value':16,'is_called':True})
    def test_sequence_call_flag_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'SEQUENCE_READBACK_MISMATCH'):self.run_case(sequence={'last_value':17,'is_called':False})


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8');unittest.main(verbosity=2)
