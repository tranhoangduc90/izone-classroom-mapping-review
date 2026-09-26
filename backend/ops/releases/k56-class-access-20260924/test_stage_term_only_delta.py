"""Kiểm cổng đóng gói Term K56 không lấy thêm source ngoài phạm vi."""

import unittest

from stage_live_gate import verify_term_only_source_delta


class TermOnlySourceDeltaTest(unittest.TestCase):
    def setUp(self):
        # Dữ liệu vào: cây giả từ image đang chạy; không đọc VPS hoặc bài học viên.
        # Việc chính: dựng đúng ba file cần sửa và một file không liên quan.
        # Kết quả: mỗi test chỉ kiểm cổng chọn source, không tạo image.
        self.live = {
            "src/app.js": b"old-app\n",
            "src/k56-portal-pilot.js": b"old-pilot\n",
            "src/term-test-writing-grading.js": b"old-grader\n",
            "src/mini-tests.js": b"unchanged\r\n",
        }
        self.branch = {
            **self.live,
            "src/app.js": b"new-app\n",
            "src/k56-portal-pilot.js": b"new-pilot\n",
            "src/term-test-writing-grading.js": b"new-grader\n",
            "src/mini-tests.js": b"unchanged\n",
            "src/term-test-portal-snapshot.js": b"new-projection\n",
        }

    def test_chi_nhan_ba_file_sua_va_mot_module_moi(self):
        self.assertEqual(verify_term_only_source_delta(self.live, self.branch),
                         {"added": 1, "changed": 3})

    def test_tu_choi_file_moi_ngoai_pham_vi(self):
        self.branch["src/unrelated.js"] = b"extra\n"
        with self.assertRaisesRegex(RuntimeError, "TERM_ONLY_SOURCE_SET_CHANGED"):
            verify_term_only_source_delta(self.live, self.branch)

    def test_tu_choi_file_bi_xoa(self):
        del self.branch["src/mini-tests.js"]
        with self.assertRaisesRegex(RuntimeError, "TERM_ONLY_SOURCE_SET_CHANGED"):
            verify_term_only_source_delta(self.live, self.branch)

    def test_tu_choi_mini_bi_sua(self):
        self.branch["src/mini-tests.js"] = b"changed\n"
        with self.assertRaisesRegex(RuntimeError, "TERM_ONLY_SOURCE_DRIFT"):
            verify_term_only_source_delta(self.live, self.branch)

    def test_tu_choi_thieu_mot_file_term(self):
        self.branch["src/app.js"] = self.live["src/app.js"]
        with self.assertRaisesRegex(RuntimeError, "TERM_ONLY_SOURCE_DRIFT"):
            verify_term_only_source_delta(self.live, self.branch)


if __name__ == "__main__":
    unittest.main()
