"""Fixture adapter: dữ liệu Docker/Git giả, không SSH hoặc chuyển dịch vụ.
Kiểm dấu cấu hình, khóa ảnh, dừng khi drift và thứ tự giữ bản khôi phục.
Lỗi assertion cho biết cổng cần sửa trước khi dùng adapter thật.
"""
import copy,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('release_remote',HERE/'release_remote.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
spec2=importlib.util.spec_from_file_location('release_adapter',HERE/'release_adapter.py');a=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(a)
def fixture():
 return {'Id':'a'*64,'Image':'sha256:base','Name':'/api-fixture','Config':{'Image':'base-tag','Env':['DATABASE_URL=fixture-only'],'Hostname':'fixed','Healthcheck':{'Test':['CMD','fixture']},'Cmd':['node','src/server.js']},'HostConfig':{'NetworkMode':'fixture-network','OomKillDisable':None,'Binds':['/fixture:/app/private:ro'],'PortBindings':{'8788/tcp':[{'HostPort':'8788','HostIp':'127.0.0.1'}]}},'Mounts':[{'Type':'bind','Source':'/fixture','Destination':'/app/private','Mode':'ro','RW':False,'Propagation':'rprivate'}],'NetworkSettings':{'Networks':{'fixture-network':{'Aliases':['api-fixture','a'*12],'IPAMConfig':None,'Links':None}}},'State':{'Running':True,'Health':{'Status':'healthy'}},'RestartCount':0}
class Contracts(unittest.TestCase):
 def test_dry_never_connects_live_alias(self):
  old=fixture();body=r.create_payload(old,'sha256:candidate',True)
  self.assertEqual(body['NetworkingConfig']['EndpointsConfig'],{});self.assertEqual(body['HostConfig']['NetworkMode'],'none');self.assertEqual(body['Env'],old['Config']['Env']);self.assertEqual(body['Healthcheck'],old['Config']['Healthcheck']);self.assertEqual(body['HostConfig']['Binds'],old['HostConfig']['Binds'])
 def test_real_preserves_alias_and_filters_container_id(self):
  body=r.create_payload(fixture(),'sha256:candidate');self.assertEqual(body['NetworkingConfig']['EndpointsConfig'],{'fixture-network':{'Aliases':['api-fixture']}})
 def test_oom_null_false_same_semantics(self):
  old=fixture();new=copy.deepcopy(old);new['HostConfig']['OomKillDisable']=False;self.assertEqual(r.config_view(old),r.config_view(new))
 def test_env_and_network_alias_change_fingerprint(self):
  old=fixture();new=copy.deepcopy(old);new['Config']['Env'].append('OTHER=fixture');self.assertNotEqual(r.digest(r.config_view(old)),r.digest(r.config_view(new)))
  new=copy.deepcopy(old);new['NetworkSettings']['Networks']['fixture-network']['Aliases'].append('wrong-destination');self.assertNotEqual(r.digest(r.config_view(old)),r.digest(r.config_view(new)))
 def test_unknown_persistent_volume_blocks(self):
  old=fixture();old['Mounts'][0]['Type']='volume'
  with self.assertRaisesRegex(RuntimeError,'persistent_volume'):r.create_payload(old,'sha256:candidate')
 def test_static_network_blocks(self):
  old=fixture();old['NetworkSettings']['Networks']['fixture-network']['IPAMConfig']={'IPv4Address':'192.0.2.1'}
  with self.assertRaisesRegex(RuntimeError,'static_network'):r.create_payload(old,'sha256:candidate')
 def test_run_id_path_traversal_blocks(self):
  for value in ['../other','A'*32,'not-a-uuid']:
   with self.assertRaises((ValueError,RuntimeError)):r.checked_run_id(value)
 def test_candidate_hash_mismatch_before_create(self):
  manifest={'targets':[{'name':'api-fixture','candidate_image':'sha256:candidate','source_hashes':{'src/app.js':'expected'}}]}
  with patch.object(r,'probe',return_value=[]),patch.object(r,'image_hashes',return_value={'src/app.js':'wrong'}),patch.object(r,'api') as api:
   with self.assertRaisesRegex(RuntimeError,'candidate_source'):r.dry_create(manifest)
   api.assert_not_called()
 def test_pages_main_drift_before_any_api_switch(self):
  config={'pages_repo':'fixture','pages_before_commit':'old'}
  with patch.object(a.Path,'read_text',return_value=json.dumps({'pages_candidate':'candidate'})),patch.object(a,'command',return_value='other refs/heads/main'),patch.object(a,'remote') as remote:
   with self.assertRaisesRegex(RuntimeError,'pages_main_changed'):a.deploy(config)
   remote.assert_not_called()
 def test_live_drift_and_active_writing_before_any_stop(self):
  request={'manifest':{'targets':[]},'expected':[],'run_id':'1'*32}
  with tempfile.TemporaryDirectory() as directory,patch.object(r,'RELEASE_ROOT',Path(directory)),patch.object(r,'probe',return_value=[{'changed':True}]),patch.object(r,'api') as api:
   with self.assertRaisesRegex(RuntimeError,'switch_live_drift'):r.switch(request)
   api.assert_not_called()
  with tempfile.TemporaryDirectory() as directory,patch.object(r,'RELEASE_ROOT',Path(directory)),patch.object(r,'probe',return_value=[]),patch.object(r,'active_writing',return_value=[{'active':1}]),patch.object(r,'api') as api:
   with self.assertRaisesRegex(RuntimeError,'writing_in_progress'):r.switch(request)
   api.assert_not_called()
 def test_switch_no_replay_after_started_receipt(self):
  with tempfile.TemporaryDirectory() as directory:
   p=Path(directory);(p/('1'*32+'.json')).write_text('{}')
   with patch.object(r,'RELEASE_ROOT',p),patch.object(r,'api') as api:
    with self.assertRaisesRegex(RuntimeError,'release_already_started'):r.switch({'manifest':{},'expected':[],'run_id':'1'*32})
    api.assert_not_called()
if __name__=='__main__':unittest.main(verbosity=2)
