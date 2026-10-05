"""Kiểm nguồn runtime giữ đúng checkpoint đã sinh image khi helper thay đổi.
Snapshot Docker giả có manifest đã khóa; đọc nguồn trước/sau và không dùng HEAD tùy ý.
"""
import unittest,json
from unittest.mock import patch
from test_release_adapter import a
class RuntimeSource(unittest.TestCase):
 def snapshots(self,image):
  targets=[{'name':n,'base_image':'base','candidate_image':'candidate'} for n in ('a','b','c')]
  manifest={'targets':targets,'baseline_checkpoint':'new-metadata'};baseline={'targets':targets,'runtime_source_checkpoint':'fixed-runtime-source'}
  rows=[{'name':n,'image':image,'config_hash':'fixture','source_hash':'fixture','running':True,'healthy':'healthy'} for n in ('a','b','c')]
  with patch.object(a.Path,'read_text',side_effect=[json.dumps(manifest),json.dumps(baseline)]),patch.object(a,'checkpoint_inputs',return_value='fixed-candidate'),patch.object(a,'pages_live',return_value={}):return a.snapshots({},rows)
 def test_base_preserves_runtime_origin(self):self.assertEqual(self.snapshots('base')['api.classroom']['sources'],{'backend':'fixed-runtime-source'})
 def test_candidate_uses_pinned_candidate_checkpoint(self):self.assertEqual(self.snapshots('candidate')['api.classroom']['sources'],{'backend':'fixed-candidate'})
if __name__=='__main__':unittest.main(verbosity=2)
