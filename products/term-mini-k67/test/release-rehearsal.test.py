"""Kiểm lỗi đổi tuyến và mất phản hồi; dùng tuyến/container giả, không gọi VPS."""
from pathlib import Path
import importlib.util
import json
import tempfile
import types
import unittest
from unittest.mock import patch,Mock

spec=importlib.util.spec_from_file_location('release',Path(__file__).resolve().parents[1]/'tools/rehearse-production-release.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class RehearsalTest(unittest.TestCase):
    def setUp(self):
        self.actual=b'before';self.running=True;self.commands=[];self.saved=[]
        self.state={'intent':'a'*32,'stage':'intent'}
        self.protected={'shared':'unchanged'};self.health={'K56':200};self.result={'fake':{'grade':0}}
        self.forward_error=False;self.foreign=False;self.stop_lost=False
        self.route=types.SimpleNamespace(PUBLIC='https://example.invalid',INCLUDE='/own.conf',
          read=lambda *args:self.actual,protected_files=lambda *args:self.protected,health=lambda:self.health)
        self.u=types.SimpleNamespace(remote=self.remote)
        self.h=types.SimpleNamespace(atomic=lambda path,obj:self.saved.append(dict(obj)))
        self.legacy=types.SimpleNamespace(exchange=self.exchange)
        self.image={'revision':'pinned'};self.env={'K67_APP_VERSION':'standby'}
    def exchange(self,*args):
        before,after=args[-2:]
        if self.actual!=before:raise RuntimeError('FOREIGN_ROUTE')
        self.actual=after
    def remote(self,client,argv):
        self.commands.append(argv)
        if argv[:2]==['docker','stop']:
            self.running=False
            if self.stop_lost:raise RuntimeError('ACK_LOST')
    def observe(self,base,version,*args):
        if version=='standby' and self.forward_error:
            if self.foreign:self.actual=b'foreign'
            raise RuntimeError('FORWARD_FAILED')
        return self.result
    def run_route(self):
        with patch.object(m,'observe',side_effect=self.observe),patch.object(m,'verify_app',side_effect=lambda *a:self.running):
            return m.rehearse_route(self.u,self.h,self.route,self.legacy,None,None,None,None,self.state,self.image,self.env,{},b'before',b'after')
    def primed(self,stage):
        self.state.update(stage=stage,baseline=self.result,protected_files=dict(self.protected),protected_health=dict(self.health),forward_verified=True)
    def test_normal_preserves_grade_and_stops_standby(self):
        self.assertEqual(self.run_route()['stage'],'rolled_back_verified')
        self.assertEqual(self.actual,b'before');self.assertFalse(self.running)
    def test_forward_failure_rolls_back_but_never_passes(self):
        self.forward_error=True
        with self.assertRaisesRegex(RuntimeError,'FORWARD_FAILED_RECOVERED'):self.run_route()
        self.assertEqual(self.actual,b'before');self.assertFalse(self.running)
        self.assertEqual(self.state['operation_error'],'FORWARD_FAILED')
        self.assertEqual(self.state['stage'],'rolled_back_after_error')
        with self.assertRaisesRegex(RuntimeError,'FORWARD_FAILED_RECOVERED'):self.run_route()
    def test_foreign_route_is_preserved_and_standby_kept(self):
        self.forward_error=True;self.foreign=True
        with self.assertRaisesRegex(RuntimeError,'ROLLBACK_FOREIGN_ROUTE'):self.run_route()
        self.assertEqual(self.actual,b'foreign');self.assertTrue(self.running)
        self.assertEqual(self.state['operation_error'],'FORWARD_FAILED')
        self.assertIn('recovery_error',self.state)
    def test_stop_lost_ack_is_reconciled_without_second_stop(self):
        self.stop_lost=True
        self.assertEqual(self.run_route()['stage'],'rolled_back_verified')
        self.assertTrue(self.state['stop_ack_reconciled'])
        self.assertEqual(sum(cmd[:2]==['docker','stop'] for cmd in self.commands),1)
    def test_stop_intent_resumes_stopped_without_forward(self):
        self.primed('standby_stop_intent');self.running=False
        self.assertEqual(self.run_route()['stage'],'rolled_back_verified')
        self.assertEqual(self.commands,[])
    def test_completed_receipt_does_not_hide_restart(self):
        self.primed('rolled_back_verified')
        with self.assertRaisesRegex(RuntimeError,'STOPPED_RUNTIME_RESTARTED'):self.run_route()
    def test_protected_change_does_not_pass_or_stop(self):
        self.primed('standby_stop_intent');self.protected={'shared':'changed'}
        with self.assertRaisesRegex(RuntimeError,'PROTECTED_STATE_CHANGED'):self.run_route()
        self.assertTrue(self.running);self.assertEqual(self.commands,[])
    def test_rollback_resume_does_not_replay_forward(self):
        self.primed('rollback_exchange_intent');self.actual=b'after';self.forward_error=True
        self.assertEqual(self.run_route()['stage'],'rolled_back_verified')
        self.assertEqual(self.actual,b'before')
    def test_wrapper_recovers_interrupted_forward_without_job_or_readiness_gate(self):
        for stage in ['forward_exchange_intent','forward_reload_intent']:
            with self.subTest(stage=stage),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);private=root/'release';private.mkdir()
                for directory,value in [('production-journeys',{'stage':'verified'}),('production-image',{'image':'pinned','revision':'pinned'})]:
                    (root/directory).mkdir();(root/directory/'state.json').write_text(json.dumps(value),encoding='utf-8')
                statepath=private/'state.json';statepath.write_text(json.dumps({'intent':'a'*32,'stage':stage}),encoding='utf-8')
                context=root/'route.json';context.write_text(json.dumps({'intent':'b'*32}),encoding='utf-8')
                db=Mock();sftp=Mock();client=Mock();client.open_sftp.return_value=sftp
                u=Mock();u.remote.return_value=m.APP.encode()
                app=Mock();app.environment.return_value={'K67_APP_VERSION':'main'}
                route=types.SimpleNamespace(STATE=context)
                opening=Mock();opening.config.return_value=b'proxy_pass http://127.0.0.1:8796/;'
                def recovered(*args):
                    self.assertEqual(args[8]['stage'],'rollback_exchange_intent')
                    self.assertEqual(args[8]['operation_error'],'K67_REHEARSAL_FORWARD_INTERRUPTED')
                    return {'outcome':'recovered'}
                with patch.object(m,'PRIVATE',private),patch.object(m,'STATE',statepath),patch.object(m,'verify_app',side_effect=AssertionError('premature readiness gate')),patch.object(m,'rehearse_route',side_effect=recovered):
                    self.assertEqual(m.perform(u,self.h,Mock(),db,app,route,opening,None,None,None,client),{'outcome':'recovered'})
                db.query.assert_not_called()
                self.assertEqual(u.remote.call_count,1)

if __name__=='__main__':unittest.main()
