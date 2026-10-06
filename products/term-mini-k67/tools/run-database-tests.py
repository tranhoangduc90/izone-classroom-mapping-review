"""Mở SSH tunnel chỉ tới PostgreSQL fixture K67 rồi chạy native Node test.
Khóa lấy từ kho DPAPI riêng, chỉ truyền bằng environment; log giữ TAP thật và exit code thật.
Không tạo/sửa dịch vụ VPS; test chỉ ghi DB fixture có marker đúng.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
import re
import select
import socketserver
import subprocess
import sys
import threading
import uuid
from urllib.parse import quote
import win32crypt

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
def revision():
    result = subprocess.run([sys.executable, "C:/Users/ADMIN/.codex/hooks/enforce_product_process.py", "fingerprint", "--root", str(ROOT), "--manifest", str(ROOT / ".codex/product-quality-gate.json")], capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout.decode("utf-8"))["tree_revision"]
spec = importlib.util.spec_from_file_location("connector", "E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py")
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)
client, ssh_password = connector.connect("vps_1")
ssh_password = None
vault = Path("E:/Codex-Data/k67-backend-separation-20261006/fixture-credentials.dpapi")
_, plaintext = win32crypt.CryptUnprotectData(vault.read_bytes(), None, None, None, 0)
passwords = json.loads(plaintext.decode("utf-8"))
plaintext = None

class Forward(socketserver.BaseRequestHandler):
    def handle(self):
        channel = client.get_transport().open_channel("direct-tcpip", ("127.0.0.1", 55467), self.request.getpeername())
        try:
            while True:
                ready, _, _ = select.select([self.request, channel], [], [], 60)
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    destination = channel if source is self.request else self.request
                    destination.sendall(data)
        finally:
            channel.close()

class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True

server = Server(("127.0.0.1", 0), Forward)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    env = dict(os.environ)
    for role, field in [("k67_app", "K67_TEST_DATABASE_URL"), ("k67_owner", "K67_TEST_OWNER_URL"), ("k67_context_sync", "K67_TEST_CONTEXT_URL")]:
        env[field] = "postgresql://" + role + ":" + quote(passwords[role], safe="") + "@127.0.0.1:" + str(server.server_address[1]) + "/term_mini_k67_test_database"
    env["K67_TEST_FIXTURE_CONFIRMATION"] = "synthetic-fixture-20261006"
    files = ["test/database.test.js"]
    if "--context-only" in sys.argv:
        files = ["test/context-database.test.js"]
    if "--all" in sys.argv:
        files = ["test/term-tests.test.js", "test/mini-tests.test.js", "test/term-test-assets.test.js",
                 "test/term-test-writing-notifier.test.js", "test/runtime-boundary.test.js",
                 "test/context-contract.test.js", "test/database.test.js", "test/context-database.test.js"]
    argv = ["node", "--test", "--test-reporter=tap", "--test-concurrency=1", *files]
    if "--grading-only" in sys.argv:
        argv.insert(4, "--test-name-pattern=^Hàng chấm thật")
    before = revision()
    result = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True, timeout=180)
    run_id = "k67-native-" + uuid.uuid4().hex
    evidence = ROOT / ".codex/product-evidence"
    stdout_path, stderr_path = evidence / (run_id + ".tap"), evidence / (run_id + ".stderr.log")
    stdout_path.write_bytes(result.stdout)
    stderr_path.write_bytes(result.stderr)
    output = result.stdout.decode("utf-8")
    parsed_output = output.replace("\r\n", "\n")
    def count(field):
        matches = re.findall(r"^# " + field + r" (\d+)$", parsed_output, re.MULTILINE)
        return int(matches[-1]) if matches else None
    after = revision()
    outcome = "passed" if result.returncode == 0 and count("fail") == 0 and count("skipped") == 0 and before == after else "failed"
    receipt = {"run_id": run_id, "command": argv, "tree_revision": before,
               "observed_after_revision": after, "exit_code": result.returncode, "outcome": outcome,
               "failed": count("fail"), "skipped": count("skipped"), "passed": count("pass"),
               "executed_test_ids": re.findall(r"^# Subtest: (.+)$", parsed_output, re.MULTILINE),
               "stdout": {"path": str(stdout_path), "sha256": hashlib.sha256(result.stdout).hexdigest()},
               "stderr": {"path": str(stderr_path), "sha256": hashlib.sha256(result.stderr).hexdigest()},
               "environment": "Windows Node24.15.0 + PostgreSQL16.14 own fixture via SSH tunnel",
               "fixture_id": "synthetic-fixture-20261006", "config_id": "role-separated-k67-fixture-v1",
               "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    (evidence / (run_id + ".json")).write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(result.stdout.decode("utf-8"))
    sys.stderr.write(result.stderr.decode("utf-8"))
    print(json.dumps({"run_id": run_id, "outcome": outcome, "receipt": str(evidence / (run_id + ".json"))}))
    sys.exit(result.returncode)
finally:
    server.shutdown()
    server.server_close()
    client.close()
