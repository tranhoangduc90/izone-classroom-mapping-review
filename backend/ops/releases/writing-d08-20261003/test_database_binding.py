"""Kiểm alias duy nhất, binding bền và chặn trước mọi DB query.
Dữ liệu Docker/URL hoàn toàn giả; không SSH, không lấy mật khẩu hoặc đụng production.
"""
import copy,unittest
from unittest.mock import patch
import database_binding as b
import canary_remote as c

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.item={'name':c.NAMES[2]}
        self.app={'Id':'a'*64,'Name':'/'+c.NAMES[2],'State':{'Running':True},
                  'Config':{'Env':['DATABASE_URL=postgres://fake:fake@k56-demo-db:5432/izone_mapping_demo']},
                  'NetworkSettings':{'Networks':{'owned-network':{'NetworkID':'n'*64,'Aliases':['demo-api'],'IPAddress':'10.1.0.2'}}}}
        self.db={'Id':'d'*64,'Name':'/izone-k56-demo-k56-demo-db-1','State':{'Running':True},
                 'Config':{'Env':[]},'NetworkSettings':{'Networks':{'owned-network':{'NetworkID':'n'*64,'Aliases':['k56-demo-db'],'IPAddress':'10.1.0.3'}}}}
        self.other=copy.deepcopy(self.db);self.other['Id']='e'*64;self.other['Name']='/other-db'
        self.other['NetworkSettings']['Networks']['owned-network']['Aliases']=['other-db']
        self.net={'Id':'n'*64,'Containers':{self.app['Id']:{},self.db['Id']:{},self.other['Id']:{}}}
    def inspect(self,name):
        return copy.deepcopy(next(x for x in [self.app,self.db,self.other] if name in [x['Id'],x['Name'].lstrip('/')]))
    def resolve(self):return b.resolve(self.item,c.destination,self.inspect,lambda _:copy.deepcopy(self.net))
    def test_unique_alias_returns_exact_ids(self):
        value=self.resolve();self.assertEqual(value['db_id'],self.db['Id']);self.assertEqual(value['api_id'],self.app['Id'])
        self.assertEqual(value['host'],'k56-demo-db');self.assertEqual(value['schema'],'assessment')
        self.assertNotIn('fake',str(value))
    def test_wrong_database(self):
        self.app['Config']['Env']=['DATABASE_URL=postgres://fake:fake@k56-demo-db/mapping_db']
        self.assertRaisesRegex(RuntimeError,'url_invalid',self.resolve)
    def test_unresolved_alias(self):
        self.db['NetworkSettings']['Networks']['owned-network']['Aliases']=[]
        self.assertRaisesRegex(RuntimeError,'wrong_or_ambiguous',self.resolve)
    def test_ambiguous_alias(self):
        self.other['NetworkSettings']['Networks']['owned-network']['Aliases']=['k56-demo-db']
        self.assertRaisesRegex(RuntimeError,'wrong_or_ambiguous',self.resolve)
    def test_wrong_container_alias(self):
        self.db['NetworkSettings']['Networks']['owned-network']['Aliases']=[]
        self.other['NetworkSettings']['Networks']['owned-network']['Aliases']=['k56-demo-db']
        self.assertRaisesRegex(RuntimeError,'wrong_or_ambiguous',self.resolve)
    def test_network_id_changed(self):
        self.net['Id']='m'*64
        self.assertRaisesRegex(RuntimeError,'network_changed',self.resolve)
    def test_peer_network_changed(self):
        self.db['NetworkSettings']['Networks']['owned-network']['NetworkID']='m'*64
        self.assertRaisesRegex(RuntimeError,'peer_network_changed',self.resolve)
    def test_db_stopped(self):
        self.db['State']['Running']=False
        self.assertRaisesRegex(RuntimeError,'not_running',self.resolve)
    def test_missing_url(self):
        self.app['Config']['Env']=[]
        self.assertRaisesRegex(RuntimeError,'url_missing',self.resolve)
    def test_name_changed(self):
        original=self.inspect
        def changed(name):
            value=original(name)
            if name==c.NAMES[2]:value['Name']='/other-api'
            return value
        self.assertRaisesRegex(RuntimeError,'name_changed',lambda:b.resolve(self.item,c.destination,changed,lambda _:self.net))
    def test_missing_frozen_binding_blocks_before_database(self):
        with patch.object(c.subprocess,'run') as execute:
            self.assertRaisesRegex(RuntimeError,'not_frozen',lambda:c.admin_query(self.item,'SELECT 1'))
            execute.assert_not_called()
    def test_stale_binding_blocks_before_database(self):
        self.item['_database_binding']=self.resolve()
        actual={**self.item['_database_binding'],'db_id':'e'*64}
        with patch.object(b,'resolve',return_value=actual),patch.object(c.subprocess,'run') as execute:
            self.assertRaisesRegex(RuntimeError,'stale',lambda:c.admin_query(self.item,'SELECT 1'))
            execute.assert_not_called()
    def test_query_executes_frozen_id(self):
        self.item['_database_binding']=self.resolve()
        class Result:
            returncode=0;stdout='{"ok":true}\n'
        with patch.object(b,'resolve',return_value=self.item['_database_binding']),patch.object(c.subprocess,'run',return_value=Result()) as execute:
            self.assertEqual(c.admin_query(self.item,'BEGIN READ ONLY;SELECT 1;COMMIT;'),[{'ok':True}])
            self.assertEqual(execute.call_args.args[0][3],self.db['Id'])

if __name__=='__main__':unittest.main()

