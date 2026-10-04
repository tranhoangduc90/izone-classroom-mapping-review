"""Bảo vệ lượt nghiệm thu một lần theo release gốc; executor song song/unknown không được lấy lại."""
import concurrent.futures,json,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import canary_remote as c

class AcceptanceExecutor(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.binding={'release_run_id':uuid.uuid4().hex,'acceptance_run_id':uuid.uuid4().hex,'original_plan_digest':'a'*64,'acceptance_digest':'b'*64,'ui_ledger_sha256':'c'*64,'expected_generation':0}
  (self.root/(self.binding['release_run_id']+'.json')).write_text(json.dumps({'status':'deployed_awaiting_validation'}),encoding='utf-8')
  self.mock=patch.object(c.r,'RELEASE_ROOT',self.root);self.mock.start();self.addCleanup(self.mock.stop)
 def test_parallel_senders_only_one_acquires(self):
  def acquire(_):
   try:c.acquire_acceptance(self.binding);return 'acquired'
   except FileExistsError:return 'blocked'
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(sorted(pool.map(acquire,range(2))),['acquired','blocked'])
 def test_unknown_cannot_be_replayed_or_replaced(self):
  path=c.acquire_acceptance(self.binding)
  state=json.loads(path.read_text(encoding='utf-8'));state['status']='unknown';path.write_text(json.dumps(state),encoding='utf-8')
  changed={**self.binding,'acceptance_run_id':uuid.uuid4().hex}
  with self.assertRaises(FileExistsError):c.acquire_acceptance(changed)
  with self.assertRaisesRegex(RuntimeError,'acceptance_executor'):c.require_acceptance(self.binding)
 def test_bad_generation_or_release_is_blocked(self):
  for change in ({'expected_generation':1},{'release_run_id':uuid.uuid4().hex},{'acceptance_digest':'bad'}):
   with self.assertRaises((RuntimeError,ValueError)):c.acquire_acceptance({**self.binding,**change})
 def test_ui_requires_api_passed_and_exact_binding(self):
  path=c.acquire_acceptance(self.binding)
  with self.assertRaisesRegex(RuntimeError,'acceptance_executor'):c.require_acceptance(self.binding)
  state=json.loads(path.read_text(encoding='utf-8'));state['status']='api_passed';state['generation']=2;path.write_text(json.dumps(state),encoding='utf-8')
  self.assertEqual(c.require_acceptance(self.binding)['binding'],self.binding)
  with self.assertRaisesRegex(RuntimeError,'acceptance_executor'):c.require_acceptance({**self.binding,'original_plan_digest':'d'*64})

if __name__=='__main__':unittest.main()
