import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('release_control',Path(__file__).with_name('release-control.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class ReleaseTests(unittest.TestCase):
    def state(self):return {'Id':'a'*64,'Image':'sha256:old','Name':'/api','State':{'Status':'running','Health':{'Status':'healthy'}},'Config':{'Env':['PRIVATE=fixture'],'Cmd':['node','app.js'],'Image':'old','Healthcheck':{'Test':['CMD','health']},'Labels':{'owner':'fixture'}},'HostConfig':{'PortBindings':{'8818/tcp':[{'HostIp':'127.0.0.1','HostPort':'8818'}]},'Binds':['private:/private:ro'],'NetworkMode':'app-network','RestartPolicy':{'Name':'unless-stopped'}},'NetworkSettings':{'Networks':{'app-network':{'Aliases':['api','a'*12],'IPAddress':'192.0.2.1','IPAMConfig':{'IPv4Address':'192.0.2.1'}}}}}
    def test_config_and_aliases_preserved_without_dynamic_ip(self):
        s=self.state();p=r.create_payload(s,'sha256:new')
        self.assertEqual(p['Env'],s['Config']['Env']);self.assertEqual(p['HostConfig'],s['HostConfig']);self.assertEqual(p['Image'],'sha256:new')
        self.assertEqual(p['NetworkingConfig'],{'EndpointsConfig':{'app-network':{'Aliases':['api']}}})
        self.assertEqual(s['NetworkSettings']['Networks']['app-network']['IPAddress'],'192.0.2.1')
    def test_live_drift_stops_before_mutation(self):
        s=self.state();b={'id':s['Id'],'image':s['Image'],'configHash':r.config_hash(s)};r.guard(s,b)
        for key in ['id','image','configHash']:
            wrong={**b,key:'changed'}
            with self.assertRaisesRegex(RuntimeError,'live_changed'):r.guard(s,wrong)
    def test_health_required(self):
        s=self.state();b={'id':s['Id'],'image':s['Image'],'configHash':r.config_hash(s)};s['State']['Health']['Status']='unhealthy'
        with self.assertRaisesRegex(RuntimeError,'live_not_healthy'):r.guard(s,b)
    def test_rollback_will_not_stop_foreign_runtime(self):
        s=self.state();s['Name']='/api-backup'
        class Fake:
            def __init__(self):self.mutations=[]
            def inspect(self,name):return s if name=='a'*64 else {'Id':'foreign'}
            def call(self,*args):self.mutations.append(args)
        f=Fake()
        with self.assertRaisesRegex(RuntimeError,'rollback_runtime_changed'):r.rollback(f,{'name':'api','backupName':'api-backup','oldId':'a'*64,'oldImage':'sha256:old','newId':'new'})
        self.assertEqual(f.mutations,[])

if __name__=='__main__':unittest.main()
