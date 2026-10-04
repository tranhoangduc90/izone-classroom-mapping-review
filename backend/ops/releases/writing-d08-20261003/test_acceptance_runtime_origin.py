"""Helper hậu kiểm mới không đổi nguồn bản đã phát hành; metadata runtime phải nguyên vẹn."""
import json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from test_release_adapter import a

class AcceptanceRuntimeOrigin(unittest.TestCase):
 def test_snapshot_keeps_deployed_checkpoint_after_helper_change(self):
  names=('a','b','c');targets=[{'name':n,'base_image':'base','candidate_image':'candidate'} for n in names]
  manifest={'targets':targets,'baseline_checkpoint':'base-metadata'};baseline={'targets':targets}
  rows=[{'name':n,'image':'candidate','config_hash':'same','source_hash':'same','running':True,'healthy':'healthy'} for n in names]
  with patch.object(a.Path,'read_text',side_effect=[json.dumps(manifest),json.dumps(baseline)]),patch.object(a,'checkpoint_inputs',return_value='new-helper'),patch.object(a,'pages_live',return_value={}):
   value=a.snapshots({'runtime_candidate_checkpoint':'old-deployed'},rows)
  self.assertEqual(value['api.classroom']['sources'],{'backend':'old-deployed'})
 def test_real_git_rejects_runtime_metadata_changed_by_acceptance_helper(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);ops=root/'ops';ops.mkdir()
   def git(*args):return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL).decode().strip()
   git('init','-q');git('config','user.name','D08 Fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false')
   (ops/'baseline.json').write_text('{}',encoding='utf-8');git('add','.');git('commit','-q','-m','baseline');baseline=git('rev-parse','HEAD')
   manifest={'baseline_checkpoint':baseline};(ops/'candidate.json').write_text(json.dumps(manifest),encoding='utf-8')
   for name in ('release_adapter.py','release_remote.py','ssh_credentials.py'):(ops/name).write_text('# Fixture\n',encoding='utf-8')
   git('add','.');git('commit','-q','-m','deployed');deployed=git('rev-parse','HEAD')
   (ops/'acceptance.py').write_text('# Helper mới\n',encoding='utf-8');git('add','.');git('commit','-q','-m','acceptance');helper=git('rev-parse','HEAD')
   with patch.object(a,'HERE',ops),patch.object(a,'BACKEND',root):self.assertEqual(a.checkpoint_inputs({'candidate_checkpoint':helper,'runtime_candidate_checkpoint':deployed},manifest),helper)
   manifest['runtime_changed']=True;(ops/'candidate.json').write_text(json.dumps(manifest),encoding='utf-8');git('add','.');git('commit','-q','-m','wrong runtime metadata');changed=git('rev-parse','HEAD')
   with patch.object(a,'HERE',ops),patch.object(a,'BACKEND',root):
    with self.assertRaisesRegex(RuntimeError,'runtime_checkpoint_metadata_changed'):a.checkpoint_inputs({'candidate_checkpoint':changed,'runtime_candidate_checkpoint':deployed},manifest)

if __name__=='__main__':unittest.main()
