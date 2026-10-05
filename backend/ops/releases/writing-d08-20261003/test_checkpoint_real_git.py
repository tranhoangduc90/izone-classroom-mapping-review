"""Kiểm checkpoint bằng Git thật trên repository tạm.
Tạo nguồn runtime, baseline và candidate rồi đọc đủ input/ancestry/HEAD thật.
Không mock subprocess hoặc truy cập VPS; lỗi phải hiện trước release.
"""
import json,tempfile,subprocess,unittest
from pathlib import Path
from unittest.mock import patch
from test_release_adapter import a
class RealCheckpoint(unittest.TestCase):
 def test_real_git_checkpoint_and_runtime_origin(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);ops=root/'ops';ops.mkdir()
   def git(*args):return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL).decode().strip()
   git('init','-q');git('config','user.name','D08 Fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false')
   (root/'README.md').write_text('Fixture nguồn runtime, không có dữ liệu thật.\n',encoding='utf-8');git('add','.');git('commit','-q','-m','runtime fixture');origin=git('rev-parse','HEAD')
   (ops/'baseline.json').write_text(json.dumps({'runtime_source_checkpoint':origin}),encoding='utf-8');git('add','.');git('commit','-q','-m','baseline fixture');baseline=git('rev-parse','HEAD')
   manifest={'baseline_checkpoint':baseline};(ops/'candidate.json').write_text(json.dumps(manifest),encoding='utf-8')
   for name in ('release_adapter.py','release_remote.py','ssh_credentials.py'):(ops/name).write_text('# Fixture bất biến, không gọi mạng.\n',encoding='utf-8')
   git('add','.');git('commit','-q','-m','candidate fixture');candidate=git('rev-parse','HEAD')
   with patch.object(a,'HERE',ops),patch.object(a,'BACKEND',root):self.assertEqual(a.checkpoint_inputs({'candidate_checkpoint':candidate},manifest),candidate)
if __name__=='__main__':unittest.main(verbosity=2)
