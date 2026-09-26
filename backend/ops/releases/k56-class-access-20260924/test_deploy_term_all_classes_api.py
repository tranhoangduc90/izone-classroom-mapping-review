"""Kiểm guard phát hành/rollback bằng mã cục bộ, không gọi VPS."""

import unittest

from deploy_term_all_classes_api import REPLACEMENTS, build_script
from deploy_term_minimal_api import REMOTE_ROLLBACK_SCRIPT, REMOTE_SCRIPT


class ReleaseScriptTest(unittest.TestCase):
    def test_preflight_deploy_and_rollback_use_only_new_image(self):
        # Dữ liệu vào: ba mẫu kịch bản cũ, không có credential hoặc kết nối mạng.
        # Việc chính: dựng preflight, deploy và rollback; loại mọi tag/digest cũ.
        # Kết quả: bản rollback sẵn dùng nếu kho K56 vẫn trống.
        # Khi lỗi: test đỏ trước khi ảnh hưởng production.
        scripts = [build_script(REMOTE_SCRIPT, deploy=False),
                   build_script(REMOTE_SCRIPT, deploy=True),
                   build_script(REMOTE_ROLLBACK_SCRIPT)]
        self.assertIn("deploy = False", scripts[0])
        self.assertIn("deploy = True", scripts[1])
        for script in scripts:
            self.assertNotIn("__DEPLOY__", script)
            for old in REPLACEMENTS:
                self.assertNotIn(old, script)
            for new in list(REPLACEMENTS.values())[:3]:
                self.assertIn(new, script)


if __name__ == "__main__":
    unittest.main()
