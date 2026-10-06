"""Kiểm phục hồi đúng lượt; API giả, không kết nối n8n hoặc Redis."""
from pathlib import Path
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.stdout.reconfigure(encoding="utf-8")
spec = importlib.util.spec_from_file_location("fixture", Path(__file__).resolve().parents[1] / "tools/n8n-redis-fixture.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class IntentRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.intent = {"attempt_id": "a" * 32, "started_at": "2026-10-06T00:00:00Z",
            "stdout": str(self.folder / ("probe-run-" + "a" * 32 + ".stdout.log"))}
        self.state = {"profile": helper.PROFILE, "host": helper.HOST, "probe_workflow": "K67fixtureProbe01", "pending_execution": self.intent}
        (self.folder / "state.json").write_text(json.dumps(self.state), encoding="utf-8")
        (self.folder / "probe-run.stdout.log").write_text(json.dumps({"workflowId": self.state["probe_workflow"], "executionId": "old-execution"}), encoding="utf-8")
        for name, value in [("PRIVATE", self.folder), ("STATE", self.folder / "state.json")]:
            mock = patch.object(helper, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def reconcile(self, observed):
        with patch.object(sys, "argv", ["fixture.py", "--reconcile"]), patch.object(helper, "resolve"), \
             patch.object(helper, "call", return_value=b"v24.15.0"), patch.object(helper, "module", return_value=object()), \
             patch.object(helper, "ctl", return_value=observed), contextlib.redirect_stdout(io.StringIO()):
            helper.main()

    def observed(self, workflow=None):
        return {"id": "new-execution", "workflowId": workflow or self.state["probe_workflow"], "status": "error", "stoppedAt": "2026-10-06T00:00:10Z"}

    def write_current_log(self):
        Path(self.intent["stdout"]).write_text(json.dumps({"workflowId": self.state["probe_workflow"], "executionId": "new-execution"}), encoding="utf-8")

    def test_old_log_cannot_clear_unknown_new_attempt(self):
        with self.assertRaises(FileNotFoundError):
            self.reconcile(self.observed())
        self.assertEqual(json.loads(helper.STATE.read_text(encoding="utf-8"))["pending_execution"], self.intent)

    def test_current_attempt_uses_its_execution_id(self):
        self.write_current_log()
        self.reconcile(self.observed())
        actual = json.loads(helper.STATE.read_text(encoding="utf-8"))
        self.assertNotIn("pending_execution", actual)
        self.assertEqual(actual["last_reconciled_execution"]["attempt_id"], self.intent["attempt_id"])
        self.assertEqual(actual["last_reconciled_execution"]["executionId"], "new-execution")

    def test_other_workflow_cannot_clear_current_attempt(self):
        self.write_current_log()
        with self.assertRaisesRegex(RuntimeError, "EXECUTION_NOT_CONFIRMED_TERMINAL"):
            self.reconcile(self.observed("OtherWorkflow01"))
        self.assertEqual(json.loads(helper.STATE.read_text(encoding="utf-8"))["pending_execution"], self.intent)


if __name__ == "__main__":
    unittest.main(verbosity=2)
