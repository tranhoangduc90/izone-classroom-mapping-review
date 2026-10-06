"""Kiểm không nhận/ghi thư mục của task khác; dữ liệu và SFTP đều mô phỏng cục bộ.
Đầu vào là trạng thái file; kết quả là không có ghi khi ownership không đủ.
"""
from pathlib import Path
from types import SimpleNamespace
import importlib.util
import io
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('context_deploy',ROOT/'tools/prepare-context-source.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class FakeSftp:
    def __init__(self,exists=True,files=None):
        self.exists=exists;self.files=files or {};self.writes=[];self.modes={k:0o600 for k in self.files}
    def stat(self,path):
        if path=='/own' and self.exists:return SimpleNamespace(st_mode=0o700)
        if path in self.files:return SimpleNamespace(st_mode=self.modes[path])
        raise FileNotFoundError(path)
    def mkdir(self,path,mode):self.exists=True;self.writes.append(('mkdir',path))
    def listdir(self,path):return [k.rsplit('/',1)[1] for k in self.files]
    def chmod(self,path,mode):self.modes[path]=mode;self.writes.append(('chmod',path))
    def open(self,path,mode):
        if mode=='rb':
            if path not in self.files:raise FileNotFoundError(path)
            return io.BytesIO(self.files[path])
        if path in self.files:raise FileExistsError(path)
        owner=self
        class Writer(io.BytesIO):
            def close(self):
                owner.files[path]=self.getvalue();owner.writes.append(('write',path));super().close()
        return Writer()


class Ownership(unittest.TestCase):
    expected={'identity.json':(b'own-intent',0o600),'source.env':(b'own-secret',0o600)}
    def rejected_without_write(self,files,code):
        sftp=FakeSftp(files=files)
        with self.assertRaisesRegex(RuntimeError,code):module.owned_directory_files(sftp,'/own',self.expected)
        self.assertEqual(sftp.writes,[])
    def test_empty_existing_directory_not_claimed(self):
        self.rejected_without_write({},'OWNERSHIP_UNKNOWN')
    def test_foreign_environment_does_not_get_identity_marker(self):
        self.rejected_without_write({'/own/source.env':b'foreign-secret'},'FILE_MISMATCH')
    def test_foreign_identity_not_claimed(self):
        self.rejected_without_write({'/own/identity.json':b'foreign'},'FILE_MISMATCH')
    def test_unknown_file_not_touched(self):
        self.rejected_without_write({'/own/foreign.txt':b'keep'},'FOREIGN_FILE')
    def test_owned_marker_does_not_allow_wrong_environment(self):
        self.rejected_without_write({'/own/identity.json':b'own-intent','/own/source.env':b'foreign'},'FILE_MISMATCH')
    def test_new_directory_created_and_read_back(self):
        sftp=FakeSftp(exists=False);module.owned_directory_files(sftp,'/own',self.expected)
        self.assertEqual(sftp.files,{'/own/'+k:v[0] for k,v in self.expected.items()})
    def test_owned_partial_directory_resumes_missing_file(self):
        sftp=FakeSftp(files={'/own/identity.json':b'own-intent'});module.owned_directory_files(sftp,'/own',self.expected)
        self.assertNotIn(('write','/own/identity.json'),sftp.writes)
        self.assertEqual(sftp.files['/own/source.env'],b'own-secret')
    def test_complete_owned_directory_no_writes(self):
        sftp=FakeSftp(files={'/own/'+k:v[0] for k,v in self.expected.items()})
        module.owned_directory_files(sftp,'/own',self.expected);self.assertEqual(sftp.writes,[])


class CollateralGuard(unittest.TestCase):
    def run_case(self,operation,observations):
        values=iter(observations);saved=[]
        def observe():
            value=next(values)
            if isinstance(value,Exception):raise value
            return value
        result=module.guarded_operation(operation,observe,saved.append)
        self.assertEqual(saved,[result]);return result
    def test_error_after_mutation_still_reads_guard(self):
        def operation():raise RuntimeError('LOST_ACK')
        result=self.run_case(operation,[{'own':'same'},{'own':'same'}])
        self.assertEqual(result['outcome'],'failure');self.assertEqual(result['guard_outcome'],'passed')
        self.assertEqual(result['operation_error'],'LOST_ACK')
    def test_operation_error_not_hidden_by_changed_guard(self):
        def operation():raise RuntimeError('LOST_ACK')
        result=self.run_case(operation,[{'value':1},{'value':2}])
        self.assertEqual(result['operation_error'],'LOST_ACK');self.assertEqual(result['guard_error'],'PROTECTED_STATE_CHANGED')
        self.assertEqual(result['outcome'],'failure')
    def test_success_without_readback_kept_unknown(self):
        result=self.run_case(lambda:{'outcome':'success'},[{'value':1},RuntimeError('OFFLINE')])
        self.assertEqual(result['outcome'],'unknown');self.assertEqual(result['operation_result']['outcome'],'success')
        self.assertEqual(result['guard_outcome'],'unknown')
    def test_missing_before_guard_never_runs_operation(self):
        calls=[]
        result=self.run_case(lambda:calls.append('mutation'),[RuntimeError('OFFLINE'),{'value':1}])
        self.assertEqual(calls,[]);self.assertEqual(result['outcome'],'failure')
    def test_success_requires_same_before_after(self):
        result=self.run_case(lambda:{'outcome':'success'},[{'value':1},{'value':1}])
        self.assertEqual(result['outcome'],'success');self.assertEqual(result['guard_outcome'],'passed')
    def test_business_failure_not_downgraded_when_readback_fails(self):
        result=self.run_case(lambda:{'outcome':'failure'},[{'value':1},RuntimeError('OFFLINE')])
        self.assertEqual(result['outcome'],'failure');self.assertEqual(result['guard_outcome'],'unknown')


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8');unittest.main(verbosity=2)
