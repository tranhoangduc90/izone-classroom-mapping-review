"""Kiểm khôi phục không đụng API đã đúng image.
Ba container giả có journal thật trên thư mục tạm; mất phản hồi start API thứ hai.
Đọc chuỗi thao tác và ID API không thay đổi sau recovery.
"""
import tempfile,unittest,contextlib,json
from pathlib import Path
from unittest.mock import patch
from test_release_recovery import DockerFixture,r
class RecoveryUnchanged(unittest.TestCase):
 def test_recovery_keeps_unmodified_api_running(self):
  d=DockerFixture('start',1);d.manifest['targets'][0]['candidate_image']=d.manifest['targets'][0]['base_image'];before=d.inspect('api-fixture-0');calls=[];api=d.api
  def traced(method,url,body=None):calls.append((method,url));return api(method,url,body)
  request={'manifest':d.manifest,'expected':d.expected,'run_id':'1'*32}
  with tempfile.TemporaryDirectory() as temporary,contextlib.ExitStack() as s:
   values={'RELEASE_ROOT':Path(temporary),'probe':d.probe,'inspect':d.inspect,'api':traced,'wait_healthy':d.healthy,'active_writing':lambda manifest:[{'active':0}],'verify_backup':lambda request:{},'image_hashes':lambda image,paths:{},'stopped_activity':lambda target,old:{'active':0},'write_receipt':lambda path,value:path.write_text(json.dumps(value),encoding='utf-8')}
   for name,value in values.items():s.enter_context(patch.object(r,name,value))
   with self.assertRaisesRegex(RuntimeError,'fixture_response_lost_after_start'):r.switch(request)
   self.assertEqual(r.recover(request)['status'],'recovered_original_awaiting_user_validation')
   self.assertEqual(d.inspect('api-fixture-0'),before)
   self.assertFalse(any(before['Id'] in url for method,url in calls))
if __name__=='__main__':unittest.main(verbosity=2)
