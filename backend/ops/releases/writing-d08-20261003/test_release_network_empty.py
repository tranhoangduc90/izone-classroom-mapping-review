"""Kiểm cấu hình mạng rỗng và giữ API đã đúng image bằng hành vi chuyển/khôi phục.
Nhận ba API giả, Docker tạo lại endpoint theo payload thật; đọc lại ID, cấu hình,
trạng thái và chuỗi thao tác. Lỗi phải chặn phát hành, không chạm VPS.
"""
import copy,json,tempfile,unittest,contextlib
from pathlib import Path
from unittest.mock import patch
from test_release_recovery import DockerFixture,r
class EndpointFixture(DockerFixture):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,**kwargs);self.calls=[]
  for old in self.containers.values():
   old['NetworkSettings']['Networks']['fixture-network']['IPAMConfig']={}
   old['NetworkSettings']['Networks']['fixture-two']={'Aliases':[old['Name'][1:],old['Id'][:12]],'IPAMConfig':{},'Links':None}
  self.expected=self.probe(self.manifest)
 def api(self,method,url,body=None):
  self.calls.append((method,url))
  result=super().api(method,url,body)
  if '/containers/create?' in url:
   item=self.containers[result['Id']]
   for name,endpoint in body['NetworkingConfig']['EndpointsConfig'].items():item['NetworkSettings']['Networks'][name]['IPAMConfig']=endpoint.get('IPAMConfig')
  return result
 def harness(self,root):
  stack=contextlib.ExitStack()
  values={'RELEASE_ROOT':root,'probe':self.probe,'inspect':self.inspect,'api':self.api,'wait_healthy':self.healthy,'active_writing':lambda manifest:[{'active':0}],'verify_backup':lambda req:{},'image_hashes':lambda image,paths:{},'stopped_activity':lambda target,old:{'active':0},'write_receipt':lambda path,value:path.write_text(json.dumps(value),encoding='utf-8')}
  for name,value in values.items():stack.enter_context(patch.object(r,name,value))
  return stack
class EndpointContracts(unittest.TestCase):
 def test_empty_two_networks_create_and_start_readback(self):
  d=EndpointFixture();request={'manifest':d.manifest,'expected':d.expected,'run_id':'1'*32}
  with tempfile.TemporaryDirectory() as root,d.harness(Path(root)):
   self.assertEqual(r.switch(request)['status'],'deployed_awaiting_validation')
   rows=d.probe(d.manifest)
   self.assertTrue(all(x['running'] and x['healthy']=='healthy' for x in rows))
   self.assertEqual([x['config_hash'] for x in rows],[x['config_hash'] for x in d.expected])
 def test_already_current_image_is_not_stopped_or_recreated(self):
  d=EndpointFixture();d.manifest['targets'][0]['candidate_image']=d.manifest['targets'][0]['base_image'];before=d.inspect('api-fixture-0')
  request={'manifest':d.manifest,'expected':d.expected,'run_id':'1'*32}
  with tempfile.TemporaryDirectory() as root,d.harness(Path(root)):
   self.assertEqual(r.switch(request)['status'],'deployed_awaiting_validation')
   self.assertEqual(d.inspect('api-fixture-0'),before)
   self.assertFalse(any(before['Id'] in url for method,url in d.calls))
 def test_no_target_change_blocks_before_backup_or_stop(self):
  d=EndpointFixture()
  for t in d.manifest['targets']:t['candidate_image']=t['base_image']
  request={'manifest':d.manifest,'expected':d.expected,'run_id':'1'*32}
  with tempfile.TemporaryDirectory() as root,d.harness(Path(root)),patch.object(r,'verify_backup') as backup:
   with self.assertRaisesRegex(RuntimeError,'no_target_change'):r.switch(request)
   backup.assert_not_called();self.assertEqual(d.calls,[])
 def test_static_address_still_blocks_and_alias_remains_distinct(self):
  d=EndpointFixture();old=d.inspect('api-fixture-0');old['NetworkSettings']['Networks']['fixture-two']['IPAMConfig']={'IPv4Address':'192.0.2.4'}
  with self.assertRaisesRegex(RuntimeError,'static_network'):r.create_payload(old,'sha256:new')
  changed=copy.deepcopy(old);changed['NetworkSettings']['Networks']['fixture-network']['Aliases'].append('wrong-destination')
  self.assertNotEqual(r.digest(r.config_view(changed)),r.digest(r.config_view(old)))
if __name__=='__main__':unittest.main(verbosity=2)
