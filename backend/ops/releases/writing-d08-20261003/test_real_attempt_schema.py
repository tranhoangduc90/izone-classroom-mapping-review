"""Kiểm hợp đồng DDL lấy từ catalog; thiếu CHECK/cột/FK phải chặn fixture."""
import copy
import json
import unittest
from pathlib import Path
from canary_remote import NAMES
from real_attempt_schema import real_attempt_ddl

class RealSchemaTests(unittest.TestCase):
    def setUp(self):
        self.contract=json.loads((Path(__file__).parent/'test-real-attempt-schema.fixture.json').read_text(encoding='utf-8'))
    def test_all_targets_preserve_checks_and_reading_timestamp(self):
        for name in NAMES:
            sql=real_attempt_ddl(self.contract,{'name':name})
            self.assertIn('reading_submitted_at timestamp with time zone',sql)
            self.assertEqual(sql.count('CONSTRAINT '),len(self.contract['targets'][name]['constraints']))
            self.assertEqual(sql.count('FOREIGN KEY ('),2)
    def test_missing_catalog_never_falls_back(self):
        with self.assertRaisesRegex(ValueError,'contract_missing'):
            real_attempt_ddl({}, {'name':NAMES[1]})
    def test_missing_reading_column_blocks(self):
        self.contract['targets'][NAMES[1]]['columns']=[c for c in self.contract['targets'][NAMES[1]]['columns'] if c['name']!='reading_submitted_at']
        with self.assertRaisesRegex(ValueError,'columns_incomplete'):
            real_attempt_ddl(self.contract,{'name':NAMES[1]})
    def test_missing_or_extra_check_blocks(self):
        for mutation in ('remove','extra'):
            data=copy.deepcopy(self.contract);rows=data['targets'][NAMES[1]]['constraints']
            if mutation=='remove':rows[:]=[r for r in rows if r['name']!='k56_completed_sections_check']
            else:rows.append({'name':'unreviewed_check','type':'c','definition':'CHECK (true)'})
            with self.assertRaisesRegex(ValueError,'check_or_fk_set_changed'):
                real_attempt_ddl(data,{'name':NAMES[1]})
    def test_unreviewed_default_blocks(self):
        self.contract['targets'][NAMES[0]]['columns'][0]['default']='unreviewed()'
        with self.assertRaisesRegex(ValueError,'default_unreviewed'):
            real_attempt_ddl(self.contract,{'name':NAMES[0]})
    def test_foreign_destination_change_blocks(self):
        rows=self.contract['targets'][NAMES[1]]['constraints'];row=next(r for r in rows if r['type']=='f')
        row['definition']=row['definition'].replace('assessment_k56.','assessment.')
        with self.assertRaisesRegex(ValueError,'foreign_key_unreviewed'):
            real_attempt_ddl(self.contract,{'name':NAMES[1]})
    def test_check_name_cannot_hide_weakened_definition(self):
        rows=self.contract['targets'][NAMES[1]]['constraints']
        next(r for r in rows if r['name']=='k56_completed_sections_check')['definition']='CHECK (true)'
        with self.assertRaisesRegex(ValueError,'catalog_definition_changed'):
            real_attempt_ddl(self.contract,{'name':NAMES[1]})

if __name__=='__main__':unittest.main()
