"""Giữ đủ bảng con theo từng đích thật; sai schema phải chặn trước seed/xóa cascade.
Fixture lấy tập bảng đã quan sát độc lập, không sinh kỳ vọng từ helper đang kiểm.
Không SSH hoặc ghi database production.
"""
import re,unittest,uuid
import canary_remote as c
import outcome_receipt as o
from ui_rpc_guard import validate_read,validate_cleanup

SHARED={'term_test_exam_session','term_test_writing_grading_run','term_test_writing_grading_final','term_test_writing_planning','term_test_portal_sync_job'}
K56={'term_test_exam_session','term_test_writing_grading_run','term_test_writing_grading_final','term_test_portal_sync_job','term_test_portal_sync_state','k56_portal_field_dispatch'}

def item(name):
 return {'name':name,'attempt_id':str(uuid.uuid4()),'marker':'CODEX_D08_'+'1'*32+'_0','course_id':-2000000,'student_id':-2000001}

class ChildTopology(unittest.TestCase):
 def test_cleanup_covers_exact_observed_tables_on_every_target(self):
  for name,expected in zip(c.NAMES,(SHARED,K56,K56)):
   with self.subTest(target=name):
    value=item(name);schema=c.destination(value)[0];sql=c.cleanup_sql(value)
    actual=set(re.findall(r'FROM '+schema+r'\.([a-z0-9_]+) WHERE attempt_id=',sql))
    self.assertEqual(actual,expected)
 def test_schema_alone_cannot_select_demo_child_set(self):
  with self.assertRaises(TypeError):c.child_expression('assessment',str(uuid.uuid4()))
  value=item(c.NAMES[2])
  with self.assertRaisesRegex(RuntimeError,'schema_mismatch'):c.child_expression('assessment_k56',value['attempt_id'],value)
 def test_api_validator_requires_target_specific_children(self):
  for name,expected in zip(c.NAMES,(SHARED,K56,K56)):
   zero={table:0 for table in expected}
   self.assertTrue(o.zero_children(zero,name))
   self.assertFalse(o.zero_children({table:0 for table in SHARED},name) if name!=c.NAMES[0] else o.zero_children({**zero,'unexpected_child':0},name))
   self.assertFalse(o.zero_children({**zero,'term_test_portal_sync_job':1},name))
 def test_ui_read_and_cleanup_require_all_six_k56_children(self):
  for name in c.NAMES[1:]:
   identity=item(name);entry={'identity':identity,'destination':{'container':name}}
   value={**identity,'destination':entry['destination'],'ownership_checked':True,'child_tables':sorted(K56),'children':[0]*6,'writing':{'submitted':False,'revision':0,'task1':'','task2':''}}
   self.assertEqual(validate_read(value,entry),value)
   cleanup={'status':'passed','destination':entry['destination'],'attempt_id':identity['attempt_id'],'marker':identity['marker'],'child_tables':sorted(K56),'remaining':{'attempt':0,'marker':0,'children':[0]*6}}
   self.assertEqual(validate_cleanup(cleanup,entry),cleanup)
   value['children']=[0]*5
   with self.assertRaisesRegex(ValueError,'child_guard'):validate_read(value,entry)
   cleanup['remaining']['children']=[0]*5
   with self.assertRaisesRegex(ValueError,'cleanup_not_zero'):validate_cleanup(cleanup,entry)

if __name__=='__main__':unittest.main()
