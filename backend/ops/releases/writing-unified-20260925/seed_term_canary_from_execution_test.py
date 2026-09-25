"""Kiểm đúng nguồn cache bài giả đã ghim, không in bài/nhận xét."""

import json
import unittest

from seed_term_canary_from_execution import load_anonymized_cache


class SeedSourceTest(unittest.TestCase):
    def test_term1_cache_identity(self):
        # Dữ liệu vào: execution bài giả Term 1 đã ghim; không lấy bài học viên.
        # Việc chính: kiểm nguồn, bài, Task và bốn tiêu chí trước khi seed.
        # Kết quả: chỉ cho phép cache Term 1 Task 2 đi vào kho canary.
        # Khi lỗi: dừng trước SSH, không tạo phiếu chấm sai bài.
        envelope = json.loads(load_anonymized_cache("term1"))
        self.assertEqual(envelope["schemaVersion"], 1)
        self.assertEqual(envelope["taskNumber"], 2)
        self.assertTrue(envelope["runKey"].startswith("term-test-1-k56:"))
        self.assertEqual(len(envelope["result"]["criteria"]), 4)

    def test_mini_cache_identity(self):
        # Dữ liệu vào: đúng execution bài giả Mini đã ghim.
        # Việc chính: kiểm phiên bản, Task và khóa lượt mà không lộ nội dung.
        # Kết quả: chỉ cho phép seed cache Mini Task 2.
        # Khi lỗi: chặn việc nạp sai bài vào PostgreSQL thử.
        envelope = json.loads(load_anonymized_cache("mini"))
        self.assertEqual(envelope["schemaVersion"], 1)
        self.assertEqual(envelope["taskNumber"], 2)
        self.assertTrue(envelope["runKey"].startswith("mini-test-k56:"))
        self.assertEqual(len(envelope["result"]["criteria"]), 4)


if __name__ == "__main__":
    unittest.main()
