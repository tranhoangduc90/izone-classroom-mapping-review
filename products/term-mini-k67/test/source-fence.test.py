"""Kiểm fence đúng phạm vi và không nhận khóa đã tắt/sai định nghĩa."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    s=importlib.util.spec_from_file_location(name,ROOT/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
f=load('fence','ops/source-fence.py');migration=load('migration','tools/rehearse-migration.py')

class FenceContract(unittest.TestCase):
    def setUp(self):
        self.intent='a'*32
        self.good={'namespace':True,'marker':f.marker(self.intent),
          'function':{'body':f.FUNCTION_BODY,'language':'plpgsql','definer':False,'arguments':0,'returns':'trigger','owner':'mapping_admin'},
          'triggers':[{'schema':'assessment','table':t,'enabled':'O','type':62,'function_schema':f.SCHEMA,
            'function':'reject_source_write'} for t in sorted(migration.TABLES)]}
    def test_valid_fence(self):self.assertTrue(f.verify(self.good,migration.TABLES,self.intent))
    def test_every_disabled_or_wrong_trigger_rejected(self):
        for index in range(13):
            for field,value in [('enabled','D'),('schema','assessment_k56'),('type',60),('function','wrong')]:
                with self.subTest(index=index,field=field):
                    bad=copy.deepcopy(self.good);bad['triggers'][index][field]=value
                    with self.assertRaises(RuntimeError):f.verify(bad,migration.TABLES,self.intent)
    def test_changed_body_or_intent_rejected(self):
        for field,value in [('body',' BEGIN RETURN NULL; END '),('definer',True),('owner','foreign')]:
            bad=copy.deepcopy(self.good);bad['function'][field]=value
            with self.assertRaises(RuntimeError):f.verify(bad,migration.TABLES,self.intent)
        with self.assertRaises(RuntimeError):f.verify(self.good,migration.TABLES,'b'*32)
    def test_ddl_scope_only_exam13(self):
        sql=f.install(migration.TABLES,self.intent)
        self.assertEqual(sql.count('CREATE TRIGGER '),13)
        self.assertNotIn('assessment_k56',sql)
        self.assertNotIn('DROP ',sql)
        self.assertNotIn('ALTER ROLE',sql)
        self.assertNotIn('TRUNCATE TABLE',sql)

if __name__=='__main__':unittest.main()
