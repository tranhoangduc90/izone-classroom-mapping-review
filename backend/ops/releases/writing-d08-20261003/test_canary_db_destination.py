"""Đích dọn canary phải là tên Docker thật, không phải alias kết nối.
Chỉ gọi hàm chọn đích, không ghi Docker/DB hoặc đọc credential.
"""
import unittest
from canary_remote import destination

class CanaryDatabaseDestination(unittest.TestCase):
    def test_demo_uses_inspected_docker_name_and_isolated_database(self):
        self.assertEqual(destination({'name':'izone-k56-demo-k56-demo-api-1'}),
            ('assessment','izone-k56-demo-k56-demo-db-1','izone_mapping_demo'))

    def test_real_profiles_use_current_shared_container_with_distinct_schema(self):
        self.assertEqual(destination({'name':'mapping-review-api'}),('assessment','mapping-postgres','mapping_db'))
        self.assertEqual(destination({'name':'izone-k56-ic2264-api'}),('assessment_k56','mapping-postgres','mapping_db'))

    def test_unknown_target_is_blocked(self):
        with self.assertRaisesRegex(RuntimeError,'canary_target_invalid'):
            destination({'name':'other-api'})

if __name__=='__main__':unittest.main()
