"""Kiểm lớp vá hẹp K56 trên code giả lập từ Git, không gọi production."""

import hashlib
import importlib.util
from pathlib import Path
import subprocess
import unittest


SCRIPT = (Path(__file__).parents[1] / "ops" / "releases" /
          "k56-class-access-20260924" / "reconcile_live_gate.py")
spec = importlib.util.spec_from_file_location("k56_gate_reconcile", SCRIPT)
reconcile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reconcile)


def git_blob(revision, path):
    return subprocess.run(["git", "show", f"{revision}:backend/{path}"],
                          capture_output=True, check=True).stdout


class GateReconcileTest(unittest.TestCase):
    def test_two_gate_commits_recreate_exact_candidate(self):
        # Dữ liệu vào: source trước hai commit cổng quyền.
        # Việc chính: áp các hunk trong RAM và so hash với commit cuối.
        # Kết quả: chỉ đúng sáu file dự kiến thay đổi; không ghi production.
        base = {path: git_blob("5b11f81^", path) for path in reconcile.FILES}
        result = reconcile.try_overlay(base)
        for path, row in result.items():
            with self.subTest(path=path):
                self.assertEqual(row["status"], "compatible")
                self.assertTrue(row["syntaxValid"])
                self.assertEqual(row["candidateHash"],
                                 hashlib.sha256(git_blob("25667ca", path)).hexdigest())

    def test_mixed_crlf_is_normalized_before_matching(self):
        base = {path: git_blob("5b11f81^", path).replace(b"\n", b"\r\n")
                for path in reconcile.FILES}
        result = reconcile.try_overlay(base)
        for path, row in result.items():
            with self.subTest(path=path):
                self.assertEqual(row["status"], "compatible")
                self.assertEqual(row["candidateHash"],
                                 hashlib.sha256(git_blob("25667ca", path)).hexdigest())

    def test_changed_guard_context_conflicts_without_outputting_source(self):
        base = {path: git_blob("5b11f81^", path) for path in reconcile.FILES}
        base["src/erp-sync.js"] = base["src/erp-sync.js"].replace(
            b"isK56PortalPilot", b"unknownPermissionMarker")
        result = reconcile.try_overlay(base)
        row = result["src/erp-sync.js"]
        self.assertEqual(row["status"], "conflict")
        self.assertIsNone(row["candidateHash"])
        self.assertNotIn("unknownPermissionMarker", str(row))

    def test_sql_smoke_runs_on_exact_gate_candidate(self):
        base = {path: git_blob("5b11f81^", path) for path in reconcile.FILES}
        result, candidates = reconcile.try_overlay(base, return_candidates=True)
        self.assertEqual(result["src/sql.js"]["status"], "compatible")
        smoke = reconcile.smoke_sql(candidates["src/sql.js"])
        self.assertEqual(smoke["passed"], 10)
        self.assertEqual(smoke["productionWrites"], 0)


if __name__ == "__main__":
    unittest.main()
