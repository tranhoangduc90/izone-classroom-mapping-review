"""Dựng và kiểm kho tiến độ chấm K67 bằng dữ liệu mô phỏng.

--prepare chỉ tạo tên mới, giữ nguyên phần đã tạo khi lỗi để điều tra.
--verify chạy unittest trên Redis thật; log và receipt giữ kết quả native.
Mật khẩu chỉ qua DPAPI/stdin, không in ra terminal hoặc đặt trong argv.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import io
import json
import re
import secrets
import shlex
import subprocess
import sys
import time
import unittest
import uuid
import win32crypt

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path("E:/Codex-Data/k67-backend-separation-20261006")
EVIDENCE = ROOT / ".codex/product-evidence"
CONTAINER = "term-mini-k67-redis-fixture"
VOLUME = CONTAINER + "-data"
REMOTE = "/opt/" + CONTAINER
IMAGE = "sha256:13105d2858ded45aedf7b24f0870e6a4e7ce4964924bffce68e562ca72149f1e"
USER = "k67_grading"
VAULT = PRIVATE / "redis-fixture-credentials.dpapi"
LABELS = {"com.izone.product": "PRODUCT-TERM-MINI-K67", "com.izone.purpose": "synthetic-fixture-20261006"}
PROTECTED = ["n8n", "redis", "mapping-postgres", "mapping-review-api", "izone-k56-ic2264-api", "progress-log-demo-api", "speaking-homework-canary"]


def connect():
    # Dùng hồ sơ SSH đã xác minh; không sao chép mật khẩu SSH ra source/log.
    spec = importlib.util.spec_from_file_location("connector", "E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py")
    connector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(connector)
    client, _ = connector.connect("vps_1")
    return client


def remote(client, argv, stdin=None, timeout=60, include_stderr=False):
    incoming, out, err = client.exec_command(" ".join(shlex.quote(v) for v in argv), timeout=timeout)
    if stdin is not None:
        incoming.write(stdin)
        incoming.flush()
        incoming.channel.shutdown_write()
    data, error = out.read(), err.read()
    code = out.channel.recv_exit_status()
    if code:
        raise RuntimeError("REMOTE_EXIT_" + str(code) + "_STDERR_BYTES_" + str(len(error)))
    return data + error if include_stderr else data


def protected(client):
    # Hash cấu hình thay vì lưu env có secret vào biên nhận kiểm thử.
    rows = json.loads(remote(client, ["docker", "inspect", *PROTECTED]))
    # Docker trả Mounts từ map, thứ tự có thể đổi dù cấu hình giữ nguyên.
    # Giữ mọi trường, chỉ chuẩn hóa thứ tự theo đích mount trước khi hash.
    for row in rows:
        row["Mounts"] = sorted(row["Mounts"], key=lambda mount: mount["Destination"])
    return {r["Name"].lstrip("/"): hashlib.sha256(json.dumps({k: r[k] for k in
            ["Image", "Config", "HostConfig", "Mounts", "RestartCount"]}, sort_keys=True).encode()).hexdigest() for r in rows}


def config(password):
    digest = hashlib.sha256(password.encode()).hexdigest()
    # INFO/SELECT/CLIENT là bắt tay của thư viện Redis n8n; không cấp quyền quản trị.
    acl = f"user {USER} on #{digest} ~termmini:k67:* -@all +get +set +del +expire +type +ping +info +select +quit +hello +auth +client|setname +client|setinfo"
    return ("bind 0.0.0.0\nprotected-mode yes\nport 6379\ndir /data\nsave \"\"\n"
            "appendonly yes\nappendfsync everysec\nmaxmemory 64mb\nmaxmemory-policy noeviction\n"
            "user default off\n" + acl + "\n").encode()


def password():
    _, raw = win32crypt.CryptUnprotectData(VAULT.read_bytes(), None, None, None, 0)
    row = json.loads(raw.decode("utf-8"))
    if row["container"] != CONTAINER or row["user"] != USER:
        raise RuntimeError("VAULT_IDENTITY_MISMATCH")
    return row["password"]


def inspect_fixture(client):
    row = json.loads(remote(client, ["docker", "inspect", CONTAINER]))[0]
    volume = json.loads(remote(client, ["docker", "volume", "inspect", VOLUME]))[0]
    if any(row["Config"].get("Labels", {}).get(k) != v or volume.get("Labels", {}).get(k) != v for k, v in LABELS.items()):
        raise RuntimeError("FIXTURE_MARKER_MISMATCH")
    if row["Image"] != IMAGE or not row["State"]["Running"]:
        raise RuntimeError("FIXTURE_IMAGE_OR_STATE_MISMATCH")
    return row


def cli(client, command, auth=None, anonymous=False):
    # REDISCLI_AUTH được nhận qua stdin, chỉ tồn tại trong tiến trình thử riêng.
    script = "IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli --user k67_grading --no-auth-warning --raw"
    if anonymous:
        return remote(client, ["docker", "exec", "-i", CONTAINER, "redis-cli", "--raw"], command + "\n", include_stderr=True).decode().strip()
    return remote(client, ["docker", "exec", "-i", CONTAINER, "sh", "-c", script], (auth or password()) + "\n" + command + "\n", include_stderr=True).decode().strip()


def prepare(client):
    before = protected(client)
    (PRIVATE / "REDIS_FIXTURE_BEFORE.json").write_text(json.dumps(before, indent=2) + "\n", encoding="utf-8")
    names = remote(client, ["docker", "ps", "-a", "--format", "{{.Names}}"]).decode().splitlines()
    volumes = remote(client, ["docker", "volume", "ls", "--format", "{{.Name}}"]).decode().splitlines()
    if CONTAINER in names or VOLUME in volumes or VAULT.exists():
        raise RuntimeError("FIXTURE_EXISTS_INSPECT_BEFORE_RESUME")
    image = json.loads(remote(client, ["docker", "image", "inspect", IMAGE]))[0]
    network = json.loads(remote(client, ["docker", "network", "inspect", "n8n-net"]))[0]
    if image["Id"] != IMAGE or network["Name"] != "n8n-net":
        raise RuntimeError("IMAGE_OR_NETWORK_MISMATCH")
    sftp = client.open_sftp()
    try:
        try:
            sftp.stat(REMOTE)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError("FIXTURE_DIRECTORY_EXISTS_INSPECT_BEFORE_RESUME")
        value = secrets.token_urlsafe(48)
        record = {"container": CONTAINER, "user": USER, "password": value}
        encrypted = win32crypt.CryptProtectData(json.dumps(record).encode(), "K67 Redis fixture", None, None, None, 0)
        with VAULT.open("xb") as vault:
            vault.write(encrypted)
        if password() != value:
            raise RuntimeError("VAULT_READBACK_FAILED")
        sftp.mkdir(REMOTE, mode=0o700)
        with sftp.open(REMOTE + "/redis.conf", "wx") as target:
            target.write(config(value))
        sftp.chmod(REMOTE + "/redis.conf", 0o644)
    finally:
        sftp.close()
    labels = [part for k, v in LABELS.items() for part in ["--label", k + "=" + v]]
    remote(client, ["docker", "volume", "create", *labels, VOLUME])
    remote(client, ["docker", "run", "--detach", "--name", CONTAINER, *labels,
        "--network", "n8n-net", "--cpus", "0.25", "--memory", "128m", "--memory-swap", "128m",
        "--pids-limit", "64", "--read-only", "--tmpfs", "/tmp:rw,size=8m,mode=1777",
        "--mount", "type=volume,src=" + VOLUME + ",dst=/data",
        "--mount", "type=bind,src=" + REMOTE + "/redis.conf,dst=/usr/local/etc/redis/redis.conf,readonly",
        IMAGE, "redis-server", "/usr/local/etc/redis/redis.conf"])
    deadline = time.monotonic() + 30
    while True:
        try:
            if cli(client, "PING", auth=value) != "PONG":
                raise RuntimeError("FIXTURE_NOT_READY")
            break
        except RuntimeError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)
    row = inspect_fixture(client)
    after = protected(client)
    (PRIVATE / "REDIS_FIXTURE_AFTER.json").write_text(json.dumps(after, indent=2) + "\n", encoding="utf-8")
    if before != after:
        raise RuntimeError("PROTECTED_STATE_CHANGED")
    evidence = {"outcome": "success", "container": CONTAINER, "image": row["Image"],
                "volume": VOLUME, "protected_before": before, "protected_after": after,
                "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    path = PRIVATE / "REDIS_FIXTURE_SETUP.json"
    path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outcome": "success", "container": CONTAINER, "evidence": str(path)}))


def allow_fixture_command(client, operation):
    # Chỉ sửa Redis fixture đã xác minh, có backup; không chỉnh n8n/Redis chung.
    inspect_fixture(client)
    before = protected(client)
    latest = config(password())
    if operation == "expire":
        desired = latest.replace(b"+expire +type", b"+expire")
        original = desired.replace(b"+del +expire +ping", b"+del +ping")
    elif operation == "type":
        desired = latest
        original = desired.replace(b"+expire +type", b"+expire")
    else:
        raise RuntimeError("ACL_OPERATION_NOT_ALLOWED")
    sftp = client.open_sftp()
    try:
        with sftp.open(REMOTE + "/redis.conf", "rb") as source:
            actual = source.read()
        if actual != original:
            raise RuntimeError("ACL_REPAIR_BASELINE_MISMATCH")
        backup = PRIVATE / ("redis-acl-before-" + operation + "-" + uuid.uuid4().hex + ".conf")
        backup.write_bytes(actual)
        with sftp.open(REMOTE + "/redis.conf", "wb") as target:
            target.write(desired)
        with sftp.open(REMOTE + "/redis.conf", "rb") as source:
            if source.read() != desired:
                raise RuntimeError("ACL_FILE_READBACK_FAILED")
    finally:
        sftp.close()
    remote(client, ["docker", "restart", CONTAINER])
    deadline = time.monotonic() + 30
    while True:
        try:
            if cli(client, "PING") != "PONG":
                raise RuntimeError("FIXTURE_NOT_READY")
            break
        except RuntimeError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)
    inspect_fixture(client)
    # SET đã thành công trước lỗi EXPIRE trong execution 2459232; dọn đúng khóa giả.
    key = "termmini:k67:synthetic:n8n-redis-fixture-20261006"
    value = cli(client, "GET " + key)
    if value not in ["", "synthetic-progress"]:
        raise RuntimeError("SYNTHETIC_CLEANUP_VALUE_MISMATCH")
    if value and cli(client, "DEL " + key) != "1":
        raise RuntimeError("SYNTHETIC_CLEANUP_FAILED")
    after = protected(client)
    receipt = {"outcome": "success" if before == after else "failure", "container_restarted": CONTAINER,
        "backup": str(backup), "before_config_sha256": hashlib.sha256(actual).hexdigest(),
        "after_config_sha256": hashlib.sha256(desired).hexdigest(), "protected_before": before, "protected_after": after,
        "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    path = PRIVATE / ("REDIS_" + operation.upper() + "_REPAIR.json")
    path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    if before != after:
        raise RuntimeError("PROTECTED_STATE_CHANGED")
    print(json.dumps({"outcome": "success", "container_restarted": CONTAINER, "receipt": str(path)}))


class RedisBoundaryTests(unittest.TestCase):
    client = None

    def test_own_namespace_round_trip(self):
        key = "termmini:k67:synthetic:" + uuid.uuid4().hex
        self.assertEqual(cli(self.client, "SET " + key + " synthetic-progress EX 60"), "OK")
        self.assertEqual(cli(self.client, "GET " + key), "synthetic-progress")
        self.assertEqual(cli(self.client, "DEL " + key), "1")
        self.assertEqual(cli(self.client, "GET " + key), "")

    def test_foreign_namespace_denied(self):
        for command in ["GET termtest:writing:direct:synthetic", "SET termtest:writing:direct:synthetic denied", "DEL writing:test:sync_secret"]:
            self.assertIn("NOPERM", cli(self.client, command))

    def test_native_expire_command(self):
        # Node Redis n8n dùng SET rồi EXPIRE riêng, không dùng SET EX như redis-cli.
        key = "termmini:k67:synthetic:expire:" + uuid.uuid4().hex
        self.assertEqual(cli(self.client, "SET " + key + " synthetic-progress EX 60"), "OK")
        try:
            self.assertEqual(cli(self.client, "EXPIRE " + key + " 10"), "1")
            self.assertIn("NOPERM", cli(self.client, "EXPIRE termtest:writing:direct:synthetic 10"))
        finally:
            self.assertEqual(cli(self.client, "DEL " + key), "1")

    def test_native_type_command(self):
        # GET mặc định của n8n đọc TYPE trước; chỉ cho phép tra loại khóa thuộc K67.
        key = "termmini:k67:synthetic:type:" + uuid.uuid4().hex
        self.assertEqual(cli(self.client, "SET " + key + " synthetic-progress EX 60"), "OK")
        try:
            self.assertEqual(cli(self.client, "TYPE " + key), "string")
            self.assertIn("NOPERM", cli(self.client, "TYPE termtest:writing:direct:synthetic"))
        finally:
            self.assertEqual(cli(self.client, "DEL " + key), "1")

    def test_admin_commands_denied(self):
        for command in ["CONFIG GET *", "FLUSHDB", "FLUSHALL", "ACL LIST"]:
            self.assertIn("NOPERM", cli(self.client, command))

    def test_wrong_password_denied(self):
        result = cli(self.client, "PING", auth="wrong-synthetic-" + uuid.uuid4().hex)
        self.assertIn("WRONGPASS", result)
        self.assertNotIn("PONG", result)

    def test_anonymous_denied(self):
        self.assertIn("NOAUTH", cli(self.client, "PING", anonymous=True))

    def test_runtime_boundary(self):
        row = inspect_fixture(self.client)
        host = row["HostConfig"]
        self.assertEqual(host["NanoCpus"], 250000000)
        self.assertEqual(host["Memory"], 128 * 1024 * 1024)
        self.assertEqual(host["MemorySwap"], 128 * 1024 * 1024)
        self.assertEqual(host["PidsLimit"], 64)
        self.assertTrue(host["ReadonlyRootfs"])
        self.assertFalse(host["PortBindings"])
        self.assertEqual(set(row["NetworkSettings"]["Networks"]), {"n8n-net"})
        mounts = {m["Destination"]: m for m in row["Mounts"]}
        self.assertEqual(mounts["/data"]["Name"], VOLUME)
        self.assertFalse(mounts["/usr/local/etc/redis/redis.conf"]["RW"])
        sftp = self.client.open_sftp()
        try:
            with sftp.open(REMOTE + "/redis.conf", "rb") as source:
                self.assertEqual(source.read(), config(password()))
        finally:
            sftp.close()
        # INFO là lệnh thư viện dùng để chờ Redis sẵn sàng, cần hoạt động với ACL mới.
        self.assertIn("redis_version:", cli(self.client, "INFO server"))
        self.assertIn("aof_enabled:1", cli(self.client, "INFO persistence"))


def fingerprint():
    result = subprocess.run([sys.executable, "C:/Users/ADMIN/.codex/hooks/enforce_product_process.py", "fingerprint",
        "--root", str(ROOT), "--manifest", str(ROOT / ".codex/product-quality-gate.json")], capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout)["tree_revision"]


def verify(client):
    before_revision, before = fingerprint(), protected(client)
    RedisBoundaryTests.client = client
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RedisBoundaryTests)
    ids = [test.id() for test in suite]
    output = io.StringIO()
    result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
    after_revision, after = fingerprint(), protected(client)
    run_id = "k67-redis-native-" + uuid.uuid4().hex
    stdout_path, stderr_path = EVIDENCE / (run_id + ".stdout.log"), EVIDENCE / (run_id + ".stderr.log")
    stdout_path.write_bytes(b"")
    raw = output.getvalue().encode("utf-8")
    stderr_path.write_bytes(raw)
    outcome = "passed" if result.wasSuccessful() and not result.skipped and before == after and before_revision == after_revision else "failed"
    receipt = {"run_id": run_id, "command": [sys.executable, "tools/prepare-redis-fixture.py", "--verify"],
        "native_runner": "unittest.TextTestRunner", "tree_revision": before_revision, "observed_after_revision": after_revision,
        "outcome": outcome, "exit_code": 0 if outcome == "passed" else 1,
        "failed": len(result.failures) + len(result.errors), "skipped": len(result.skipped),
        "executed_test_ids": ids[:result.testsRun], "environment": "VPS Redis own fixture via redis-cli/stdin",
        "config_id": "redis-k67-0.25cpu-128m-acl-v1", "fixture_id": "synthetic-fixture-20261006",
        "stdout": {"path": str(stdout_path), "sha256": hashlib.sha256(b"").hexdigest()},
        "stderr": {"path": str(stderr_path), "sha256": hashlib.sha256(raw).hexdigest()},
        "protected_before": before, "protected_after": after,
        "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    path = EVIDENCE / (run_id + ".json")
    path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    sys.stderr.write(output.getvalue())
    print(json.dumps({"run_id": run_id, "outcome": outcome, "receipt": str(path)}))
    return receipt["exit_code"]


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--prepare", action="store_true")
    modes.add_argument("--verify", action="store_true")
    modes.add_argument("--allow-expire", action="store_true")
    modes.add_argument("--allow-type", action="store_true")
    args = parser.parse_args()
    client = connect()
    try:
        if args.prepare:
            prepare(client)
            return 0
        if args.allow_expire:
            allow_fixture_command(client, "expire")
            return 0
        if args.allow_type:
            allow_fixture_command(client, "type")
            return 0
        return verify(client)
    finally:
        client.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        code = str(exc) if re.fullmatch(r"[A-Z_0-9]+", str(exc)) else type(exc).__name__
        print(json.dumps({"outcome": "failure", "code": code, "recovery": "Giữ trạng thái hiện có; kiểm trước khi tiếp tục."}, ensure_ascii=False))
        sys.exit(1)
