import unittest,importlib.util,copy,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('control',Path(__file__).with_name('release-control.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Docker:
 def __init__(self,fail=False):
  self.calls=[];self.fail=fail
  self.old={'Id':'old-id','Image':'base','Name':'/api','State':{'Status':'running','Health':{'Status':'healthy'}},'Config':{'Env':['DB=fixture-secret','KEEP=same'],'Cmd':['node','src/server.js'],'Entrypoint':None,'WorkingDir':'/app','User':'node','Healthcheck':{'Test':['CMD','true']}},'HostConfig':{'PortBindings':{'8788/tcp':[{'HostIp':'127.0.0.1','HostPort':'8792'}]},'Binds':['private:/private:ro'],'RestartPolicy':{'Name':'unless-stopped'}},'NetworkSettings':{'Networks':{'private':{'Aliases':['api','old-id']}}}}
  self.states={'api':self.old}
 def inspect(self,name):
  for state in self.states.values():
   if name in [state['Id'],state['Name'].lstrip('/')]:return copy.deepcopy(state)
  raise RuntimeError('not_found')
 def call(self,method,path,body=None):
  self.calls.append((method,path,copy.deepcopy(body)))
  if path.startswith('/images/'):return {'Id':'candidate'}
  if path.startswith('/containers/create'):
   state={'Id':'new-id','Name':'/api','Image':body['Image'],'Config':{k:copy.deepcopy(v)for k,v in body.items()if k not in ['HostConfig','NetworkingConfig']},'HostConfig':body['HostConfig'],'NetworkSettings':{'Networks':body['NetworkingConfig']['EndpointsConfig']},'State':{'Status':'created','Health':{'Status':'starting'}}}
   self.states['new-id']=state;return {'Id':'new-id'}
  name=path.split('/')[2];state=next(s for s in self.states.values()if name in [s['Id'],s['Name'].lstrip('/')])
  if '/rename?'in path:state['Name']='/'+path.split('name=',1)[1]
  elif '/stop?'in path:state['State']['Status']='exited'
  elif path.endswith('/start'):
   state['State']={'Status':'running','Health':{'Status':'unhealthy'if self.fail and state['Id']=='new-id'else'healthy'}}
  else:raise RuntimeError('unsupported_fake_operation')
def expected(d):return {'id':d.old['Id'],'image':d.old['Image'],'configHash':m.config_hash(d.old)}
class ReleaseTests(unittest.TestCase):
 def setUp(self):
  self.health=m.ensure_healthy
  def check(d,name,timeout=90):
   if d.inspect(name)['State']['Health']['Status']!='healthy':raise RuntimeError('unhealthy')
  m.ensure_healthy=check
 def tearDown(self):m.ensure_healthy=self.health
 def test_flags_preserve_every_other_setting(self):
  d=Docker();before=copy.deepcopy(d.old)
  with tempfile.TemporaryDirectory()as folder:
   r=m.apply(d,'api',expected(d),'candidate',str(Path(folder)/'receipt.json'),{'AUDIO_CLOUDFLARE_ENABLED':'true','AUDIO_CLOUDFLARE_ASSETS':'public-hash'})
  new=d.inspect('api');self.assertEqual(new['Config']['Env'],before['Config']['Env']+['AUDIO_CLOUDFLARE_ENABLED=true','AUDIO_CLOUDFLARE_ASSETS=public-hash'])
  self.assertEqual(new['HostConfig'],before['HostConfig']);self.assertEqual(new['Config']['User'],'node');self.assertEqual(r['oldId'],'old-id')
  self.assertEqual(d.inspect('old-id')['State']['Status'],'exited')
 def test_live_drift_stops_before_any_docker_mutation(self):
  d=Docker();e=expected(d);d.old['Config']['Env'].append('OTHER_TASK=changed')
  with self.assertRaisesRegex(RuntimeError,'live_changed'):m.apply(d,'api',e,'candidate','unused')
  self.assertEqual(d.calls,[])
 def test_out_of_scope_environment_cannot_stop_runtime(self):
  d=Docker()
  with self.assertRaisesRegex(RuntimeError,'out_of_scope'):m.apply(d,'api',expected(d),'candidate','unused',{'DB':'must-not-change'})
  self.assertFalse(any('/stop' in path for _,path,_ in d.calls))
 def test_health_failure_restores_original_and_retains_failed_container(self):
  d=Docker(fail=True)
  with tempfile.TemporaryDirectory()as folder:
   with self.assertRaisesRegex(RuntimeError,'unhealthy'):m.apply(d,'api',expected(d),'candidate',str(Path(folder)/'receipt.json'),{'AUDIO_CLOUDFLARE_ENABLED':'true'})
  self.assertEqual(d.inspect('api')['Id'],'old-id');self.assertEqual(d.inspect('api')['State']['Status'],'running')
  self.assertIn('failed',d.inspect('new-id')['Name'])
if __name__=='__main__':unittest.main()
