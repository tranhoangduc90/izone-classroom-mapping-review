"""Dựng/chạy native test trong container riêng, chỉ nối DB fixture K67.
Clock cùng VPS; giữ raw log/exit/revision. Không sửa route/runtime/DB chung hoặc K56.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import re
import shlex
import subprocess
import sys
import tarfile
import uuid
from urllib.parse import quote
import win32crypt

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".codex/product-evidence"
RUN_ID = "k67-vps-native-" + uuid.uuid4().hex
REMOTE = "/opt/term-mini-k67-fixture/native/" + RUN_ID
spec = importlib.util.spec_from_file_location("connector", "E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py")
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)
client, password = connector.connect("vps_1")
password = None
env_uploaded = False
HTTP_ONLY = '--http-only' in sys.argv
HTTP_DATABASE = 'term_mini_k67_test_http_' + uuid.uuid4().hex[:12]
HTTP_FIXTURE_ID = 'synthetic-http-' + uuid.uuid4().hex

def remote(command, timeout=90, required=True, data=None):
    incoming, out, err = client.exec_command(command, timeout=timeout)
    if data is not None:
        incoming.write(data)
        incoming.flush()
        incoming.channel.shutdown_write()
    data, error = out.read(), err.read()
    code = out.channel.recv_exit_status()
    if required and code:
        (EVIDENCE / (RUN_ID + ".operation.stderr.log")).write_bytes(error)
        raise RuntimeError("REMOTE_EXIT_" + str(code))
    return code, data, error

def fingerprint():
    result = subprocess.run([sys.executable, "C:/Users/ADMIN/.codex/hooks/enforce_product_process.py", "fingerprint", "--root", str(ROOT), "--manifest", str(ROOT / ".codex/product-quality-gate.json")], capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout.decode("utf-8"))["tree_revision"]

def protected():
    result = {}
    for name in ['n8n','redis','mapping-postgres','mapping-review-api','izone-k56-ic2264-api','progress-log-demo-api','speaking-homework-canary']:
        item = json.loads(remote("docker inspect " + shlex.quote(name))[1])[0]
        observed = {"image": item["Image"], "config": item["Config"], "host": item["HostConfig"],
                    "mounts": sorted(item['Mounts'],key=lambda mount:mount['Destination']), "restart_count": item["RestartCount"]}
        result[name] = hashlib.sha256(json.dumps(observed, sort_keys=True).encode()).hexdigest()
    return result

def upload(path, data, mode):
    sftp = client.open_sftp()
    try:
        with sftp.open(path, "wx") as target:
            target.write(data)
        sftp.chmod(path, mode)
    finally:
        sftp.close()

try:
    before_revision = fingerprint()
    before = protected()
    marker = remote("docker exec term-mini-k67-postgres-fixture psql -X -qAt -U k67_owner -d term_mini_k67_test_database -c \"SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity\"")[1].decode().strip()
    if marker != "PRODUCT-TERM-MINI-K67:synthetic-fixture-20261006":
        raise RuntimeError("FIXTURE_MARKER_MISMATCH")
    print(json.dumps({"stage": "pin_node_image", "run_id": RUN_ID}))
    remote("docker pull node:24.15.0-alpine", timeout=240)
    info = json.loads(remote("docker image inspect node:24.15.0-alpine")[1])[0]
    digests = [value for value in info.get("RepoDigests", []) if re.fullmatch(r"node@sha256:[0-9a-f]{64}", value)]
    if len(digests) != 1:
        raise RuntimeError("NODE_IMAGE_DIGEST_MISSING")
    node_image = digests[0]
    remote("mkdir -p /opt/term-mini-k67-fixture/native && mkdir " + shlex.quote(REMOTE) + " && chmod 700 " + shlex.quote(REMOTE))
    stream = io.BytesIO()
    source_hashes = {}
    if HTTP_ONLY:
        # Chỉ tạo DB mới sau marker nguồn riêng; không ghi/xóa DB có sẵn.
        remote('docker exec term-mini-k67-postgres-fixture createdb -U k67_owner --template=template0 ' + shlex.quote(HTTP_DATABASE))
        ddl = ['BEGIN;']
        for name in ['001-context.sql','002-history.sql','003-assessment.sql','004-grants.sql','005-context-auth.sql']:
            path = ROOT / 'db' / name
            data = path.read_bytes()
            source_hashes['db/' + name] = hashlib.sha256(data).hexdigest()
            ddl.append(data.decode('utf-8'))
        ddl += ["CREATE TABLE mapping.k67_fixture_identity(product_id text PRIMARY KEY,fixture_id text NOT NULL);",
                "INSERT INTO mapping.k67_fixture_identity VALUES('PRODUCT-TERM-MINI-K67','" + HTTP_FIXTURE_ID + "');",
                "GRANT SELECT ON mapping.k67_fixture_identity TO k67_app;", 'COMMIT;']
        remote('docker exec -i term-mini-k67-postgres-fixture psql -X -qAt -v ON_ERROR_STOP=1 -U k67_owner -d ' + shlex.quote(HTTP_DATABASE),
               data='\n'.join(ddl).encode('utf-8'))
        print(json.dumps({'stage':'fresh_http_database','database':HTTP_DATABASE,'fixture_id':HTTP_FIXTURE_ID}))
    with tarfile.open(fileobj=stream, mode="w:gz") as bundle:
        files = [ROOT / "package.json", ROOT / "package-lock.json", ROOT / "Dockerfile.test"]
        files += sorted((ROOT / "src").glob("*.js")) + sorted((ROOT / "test").glob("*.js"))
        for path in files:
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("CANDIDATE_FILE_INVALID")
            relative = path.relative_to(ROOT).as_posix()
            data = path.read_bytes()
            source_hashes[relative] = hashlib.sha256(data).hexdigest()
            entry = tarfile.TarInfo(relative)
            entry.size, entry.mode = len(data), 0o644
            bundle.addfile(entry, io.BytesIO(data))
    archive = stream.getvalue()
    (EVIDENCE / (RUN_ID + ".source.tgz")).write_bytes(archive)
    upload(REMOTE + "/source.tgz", archive, 0o600)
    remote("tar -xzf " + shlex.quote(REMOTE + "/source.tgz") + " -C " + shlex.quote(REMOTE))
    print(json.dumps({"stage": "build_candidate", "node_image": node_image}))
    tag = "izone-term-mini-k67-test:" + RUN_ID
    build = "docker build --build-arg " + shlex.quote("NODE_IMAGE=" + node_image) + " --file " + shlex.quote(REMOTE + "/Dockerfile.test") + " --tag " + shlex.quote(tag) + " " + shlex.quote(REMOTE)
    build_code, build_out, build_err = remote(build, timeout=300, required=False)
    (EVIDENCE / (RUN_ID + ".build.stdout.log")).write_bytes(build_out)
    (EVIDENCE / (RUN_ID + ".build.stderr.log")).write_bytes(build_err)
    if build_code:
        raise RuntimeError("CANDIDATE_BUILD_EXIT_" + str(build_code))
    candidate = json.loads(remote("docker image inspect " + shlex.quote(tag))[1])[0]["Id"]
    _, plaintext = win32crypt.CryptUnprotectData(Path("E:/Codex-Data/k67-backend-separation-20261006/fixture-credentials.dpapi").read_bytes(), None, None, None, 0)
    passwords = json.loads(plaintext.decode("utf-8"))
    plaintext = None
    env = {"K67_TEST_FIXTURE_CONFIRMATION": "synthetic-fixture-20261006"}
    database = HTTP_DATABASE if HTTP_ONLY else 'term_mini_k67_test_database'
    for role, field in [("k67_app", "K67_TEST_DATABASE_URL"), ("k67_owner", "K67_TEST_OWNER_URL"), ("k67_context_sync", "K67_TEST_CONTEXT_URL")]:
        env[field] = "postgresql://" + role + ":" + quote(passwords[role], safe="") + "@127.0.0.1:5432/" + database
    if HTTP_ONLY:
        env.update({'K67_HTTP_DATABASE':HTTP_DATABASE,'K67_HTTP_FIXTURE_ID':HTTP_FIXTURE_ID})
    passwords = None
    upload(REMOTE + "/test.env", "\n".join(key + "=" + value for key, value in env.items()) + "\n", 0o600)
    env_uploaded = True
    env = None
    native = ["--test", "--test-reporter=tap", "--test-concurrency=1",
      "test/term-tests.test.js", "test/mini-tests.test.js", "test/term-test-assets.test.js",
      "test/term-test-writing-notifier.test.js", "test/runtime-boundary.test.js",
      "test/context-contract.test.js", "test/database.test.js", "test/context-database.test.js"]
    if "--context-only" in sys.argv:
        native = ["--test", "--test-reporter=tap", "--test-concurrency=1", "test/context-contract.test.js", "test/context-database.test.js"]
    if HTTP_ONLY:
        native = ['--test','--test-reporter=tap','--test-concurrency=1','test/integration.test.js']
    argv = ["docker", "run", "--rm", "--name", RUN_ID, "--network", "container:term-mini-k67-postgres-fixture",
      "--cpus", "0.5", "--memory", "256m", "--pids-limit", "100", "--read-only",
      "--tmpfs", "/tmp:rw,size=64m,mode=1777", "--env-file", REMOTE + "/test.env", candidate, *native]
    print(json.dumps({"stage": "native_tests", "candidate_image": candidate}))
    code, out, err = remote(" ".join(shlex.quote(value) for value in argv), timeout=300, required=False)
    stdout_path, stderr_path = EVIDENCE / (RUN_ID + ".tap"), EVIDENCE / (RUN_ID + ".stderr.log")
    stdout_path.write_bytes(out)
    stderr_path.write_bytes(err)
    parsed = out.decode("utf-8").replace("\r\n", "\n")
    def count(field):
        matches = re.findall(r"^# " + field + r" (\d+)$", parsed, re.MULTILINE)
        return int(matches[-1]) if matches else None
    after_revision = fingerprint()
    after = protected()
    outcome = "passed" if code == 0 and count("fail") == 0 and count("skipped") == 0 and before_revision == after_revision and before == after else "failed"
    receipt = {"run_id": RUN_ID, "command": argv, "native_runner": ["node", *native],
      "tree_revision": before_revision, "observed_after_revision": after_revision,
      "exit_code": code, "outcome": outcome, "failed": count("fail"), "skipped": count("skipped"), "passed": count("pass"),
      "executed_test_ids": re.findall(r"^# Subtest: (.+)$", parsed, re.MULTILINE),
      "stdout": {"path": str(stdout_path), "sha256": hashlib.sha256(out).hexdigest()},
      "stderr": {"path": str(stderr_path), "sha256": hashlib.sha256(err).hexdigest()},
      "environment": "VPS Linux Node24.15.0 + PostgreSQL16.14 own fixture, same clock/network namespace",
      "config_id": "isolated-native-container-0.5cpu-256m-v1", "fixture_id": "synthetic-fixture-20261006",
      "http_database": HTTP_DATABASE if HTTP_ONLY else None, "http_fixture_id": HTTP_FIXTURE_ID if HTTP_ONLY else None,
      "node_image": node_image, "candidate_image": candidate, "source_hashes": source_hashes,
      "protected_before": before, "protected_after": after,
      "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    receipt_path = EVIDENCE / (RUN_ID + ".json")
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(parsed)
    sys.stderr.write(err.decode("utf-8"))
    print(json.dumps({"run_id": RUN_ID, "outcome": outcome, "receipt": str(receipt_path)}))
    # Native exit giữ nguyên trong receipt; wrapper phải thất bại nếu guard/revision sai.
    sys.exit(code if outcome == 'passed' else (code or 1))
except Exception as exc:
    print(json.dumps({"run_id": RUN_ID, "outcome": "failure", "code": str(exc) if re.fullmatch(r"[A-Z_]+(?:[0-9]+)?", str(exc)) else type(exc).__name__}))
    sys.exit(1)
finally:
    if env_uploaded:
        sftp = client.open_sftp()
        try:
            sftp.remove(REMOTE + "/test.env")
        finally:
            sftp.close()
    client.close()
