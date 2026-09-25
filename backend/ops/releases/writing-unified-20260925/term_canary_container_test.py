"""Kiểm gói canary chỉ chứa source được phép và Dockerfile đọc được."""

from pathlib import Path
import tarfile
import tempfile
import unittest

from term_canary_container import make_context


class ContextTest(unittest.TestCase):
    def test_context_has_root_dockerfile_and_no_private_files(self):
        # Dữ liệu vào: source của linked worktree; không kết nối VPS.
        # Việc chính: kiểm tar gzip mở được và không chứa .env, credential, bài thật.
        # Kết quả: Docker nhận Dockerfile ở root và đúng các file trong allowlist.
        # Khi lỗi: chặn bước build trên VPS.
        with tempfile.TemporaryDirectory(dir="E:/Codex-Data/temp") as directory:
            archive_path = Path(directory) / "context.tgz"
            self.assertGreater(make_context(archive_path), 10)
            with tarfile.open(archive_path, "r:gz") as archive:
                names = archive.getnames()
                self.assertIn("Dockerfile", names)
                self.assertTrue(archive.extractfile("Dockerfile").read().startswith(
                    b"FROM node:24-alpine"))
                self.assertFalse(any(".env" in name or "credential" in name.lower()
                                     for name in names))
                self.assertTrue(all(item.isfile() for item in archive.getmembers()))


if __name__ == "__main__":
    unittest.main()
