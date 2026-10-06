"""Nối n8n với Redis K67 và kiểm một vòng lưu tiến độ bằng dữ liệu giả.

--prepare tạo credential mới cùng hai workflow inactive, có tag và vòng đời.
--verify chạy đúng workflow đã lưu ID, đọc execution và Redis đích.
Ghi ý định trước API; lỗi/mất phản hồi dừng để đối soát, không tạo bản trùng.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import uuid

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path("E:/Codex-Data/k67-backend-separation-20261006/n8n-redis-fixture")
STATE = PRIVATE / "state.json"
SCRIPTS = Path("E:/wt/k67-grading-separation-20261006/n8n-root/n8n-workflows/scripts")
CLI = "C:/Users/ADMIN/AppData/Roaming/npm/node_modules/@trngthnh369/n8nctl/dist/index.js"
LIFECYCLE = Path("E:/Codex-Data/n8n-workflow-lifecycle/k67-grading-separation-20261006.json")
PROFILE, HOST = "default", "https://ducizone.ddns.net"
NODE = shutil.which("node")
KEY = "termmini:k67:synthetic:n8n-redis-fixture-20261006"
SETTINGS = {"saveDataErrorExecution": "all", "saveDataSuccessExecution": "all", "saveManualExecutions": True}


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_state(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def call(argv, input_bytes=None, label="command", timeout=90):
    # Mật khẩu credential chỉ qua stdin, log chỉ chứa metadata trả về từ CLI.
    result = subprocess.run(argv, input=input_bytes, capture_output=True, timeout=timeout)
    # Giữ log từng lần gọi bất biến; file tên ngắn chỉ là con trỏ tới lần mới nhất.
    journal = label + "-" + uuid.uuid4().hex
    (PRIVATE / (journal + ".stdout.log")).write_bytes(result.stdout)
    (PRIVATE / (journal + ".stderr.log")).write_bytes(result.stderr)
    (PRIVATE / (label + ".stdout.log")).write_bytes(result.stdout)
    (PRIVATE / (label + ".stderr.log")).write_bytes(result.stderr)
    if result.returncode:
        raise RuntimeError("CLI_" + label.upper().replace("-", "_") + "_EXIT_" + str(result.returncode))
    return result.stdout


def ctl(*args, input_bytes=None, label="n8n", timeout=90):
    return json.loads(call([NODE, CLI, "--profile", PROFILE, "--json", *args], input_bytes, label, timeout))


def resolve(workflow_id=None, name=None):
    argv = [NODE, str(SCRIPTS / "xac-dinh-dich-n8n.mjs"), "--expected-host", HOST]
    argv += ["--workflow-id", workflow_id, "--profile", PROFILE, "--expected-name", name] if workflow_id else ["--instance-profile", PROFILE]
    result = json.loads(call(argv, label="target-" + (workflow_id or "instance")))
    if not result.get("ok") or result.get("code") != ("TARGET_VERIFIED" if workflow_id else "INSTANCE_VERIFIED"):
        raise RuntimeError("N8N_TARGET_NOT_VERIFIED")


def module():
    spec = importlib.util.spec_from_file_location("redis_fixture", ROOT / "tools/prepare-redis-fixture.py")
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    return fixture


def node(name, kind, parameters, version=1, credential=None):
    row = {"id": str(uuid.uuid4()), "name": name, "type": "n8n-nodes-base." + kind,
           "typeVersion": version, "position": [0, 0], "parameters": parameters}
    if credential:
        row["credentials"] = {"redis": credential}
    return row


def create_workflow(state, key, workflow):
    # Không retry create bị mất ACK. ID được ghi trước bước tag/register tiếp theo.
    if state.get(key):
        if state.get(key + "_registered"):
            resolve(state[key], workflow["name"])
            return
        raise RuntimeError("WORKFLOW_CREATED_REGISTRATION_PENDING")
    if state.get("pending_create"):
        raise RuntimeError("CREATE_OUTCOME_UNKNOWN_INSPECT_BEFORE_RESUME")
    candidate = PRIVATE / (key + ".candidate.json")
    candidate.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    call([NODE, CLI, "--profile", PROFILE, "workflow", "validate", str(candidate)], label=key + "-validate")
    call([NODE, str(SCRIPTS / "kiem-tra-luu-execution-candidate.mjs"), str(candidate)], label=key + "-gate")
    state["pending_create"] = {"role": key, "name": workflow["name"], "at": now()}
    write_state(state)
    result = ctl("workflow", "deploy", str(candidate), "--create-only", label=key + "-create")
    if not result.get("created") or result.get("activated") or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", result.get("workflowId", "")):
        raise RuntimeError("WORKFLOW_CREATE_IDENTITY_MISMATCH")
    state[key] = result["workflowId"]
    state.pop("pending_create")
    write_state(state)
    resolve(state[key], workflow["name"])
    call([NODE, CLI, "--profile", PROFILE, "workflow", "tag", state[key], "Codex tạo", "Tạm thời", "--create"], label=key + "-tags")
    call([NODE, str(SCRIPTS / "quan-ly-vong-doi-workflow.mjs"), "register", "--manifest", str(LIFECYCLE),
        "--workflow-id", state[key], "--name", workflow["name"], "--purpose", "Kiểm và vận hành kho tiến độ riêng K67",
        "--kind", "temporary", "--expires-at", "2026-10-13T00:00:00Z"], label=key + "-lifecycle")
    state[key + "_registered"] = True
    write_state(state)
    observed = ctl("workflow", "get", state[key], label=key + "-readback")
    if observed["id"] != state[key] or observed["active"] or any(observed["settings"].get(k) != v for k, v in SETTINGS.items()):
        raise RuntimeError("WORKFLOW_READBACK_FAILED")


def prepare(state, fixture):
    if not LIFECYCLE.exists():
        call([NODE, str(SCRIPTS / "quan-ly-vong-doi-workflow.mjs"), "init", "--manifest", str(LIFECYCLE),
            "--task-id", "k67-grading-separation-20261006", "--title", "Tách bộ chấm K67 và kiểm bằng mô phỏng"], label="lifecycle-init")
    if not state.get("redis_credential"):
        if state.get("credential_intent"):
            raise RuntimeError("CREDENTIAL_CREATE_UNKNOWN_INSPECT_BEFORE_RESUME")
        state["credential_intent"] = now()
        write_state(state)
        payload = {"name": "K67 · Kho tiến độ chấm mô phỏng", "type": "redis", "data": {
            "host": fixture.CONTAINER, "port": 6379, "database": 0, "user": fixture.USER,
            "password": fixture.password(), "ssl": False}}
        result = ctl("credential", "create", "-", input_bytes=json.dumps(payload).encode("utf-8"), label="redis-credential-create")
        if result.get("type") != "redis" or result.get("name") != payload["name"] or not result.get("id"):
            raise RuntimeError("CREDENTIAL_CREATE_IDENTITY_MISMATCH")
        state["redis_credential"] = {"id": result["id"], "name": result["name"]}
        state.pop("credential_intent")
        write_state(state)
    error_nodes = [node("Nhận lỗi chấm K67", "errorTrigger", {}), node("Giữ thông tin lỗi để kiểm tra", "code", {
        "jsCode": "// Nhận lỗi n8n, chỉ trả mã và nơi lỗi để người vận hành tìm execution.\nconst item = $input.first().json;\nconst data = {\n  product_id: 'PRODUCT-TERM-MINI-K67',\n  execution_id: String(item.execution?.id ?? ''),\n  failed_node: String(item.execution?.lastNodeExecuted ?? '')\n};\nreturn [{ json: data }];"}, 2)]
    create_workflow(state, "error_workflow", {"name": "K67 · Ghi nhận lỗi chấm bài", "active": False,
        "nodes": error_nodes, "connections": {error_nodes[0]["name"]: {"main": [[{"node": error_nodes[1]["name"], "type": "main", "index": 0}]]}}, "settings": SETTINGS})
    credential = state["redis_credential"]
    nodes = [node("Bắt đầu kiểm", "manualTrigger", {}),
        node("Lưu tiến độ giả", "redis", {"operation": "set", "key": KEY, "value": "synthetic-progress", "keyType": "string", "expire": True, "ttl": 60}, credential=credential),
        node("Đọc lại tiến độ", "redis", {"operation": "get", "propertyName": "checkpoint", "key": KEY, "options": {}}, credential=credential),
        node("Kiểm nội dung đã lưu", "code", {"jsCode": "// Nhận tiến độ đọc từ Redis, kiểm đúng dữ liệu giả; sai thì execution báo lỗi.\nconst items = $input.all();\nif (items.length !== 1 || items[0].json.checkpoint !== 'synthetic-progress') {\n  throw new Error('K67_REDIS_READBACK_MISMATCH');\n}\nconst data = { product_id: 'PRODUCT-TERM-MINI-K67', verified: true };\nreturn [{ json: data }];"}, 2),
        node("Xóa khóa thử", "redis", {"operation": "delete", "key": KEY}, credential=credential)]
    for index, item in enumerate(nodes):
        item["position"] = [index * 220, 0]
    connections = {nodes[i]["name"]: {"main": [[{"node": nodes[i+1]["name"], "type": "main", "index": 0}]]} for i in range(len(nodes)-1)}
    create_workflow(state, "probe_workflow", {"name": "K67 · Kiểm kho tiến độ chấm", "active": False,
        "nodes": nodes, "connections": connections, "settings": {**SETTINGS, "errorWorkflow": state["error_workflow"]}})
    print(json.dumps({"outcome": "success", "state": str(STATE), "redis_credential": state["redis_credential"]["id"],
        "probe_workflow": state["probe_workflow"], "error_workflow": state["error_workflow"], "active": False}))


def verify(state, fixture):
    workflow_id = state["probe_workflow"]
    resolve(workflow_id, "K67 · Kiểm kho tiến độ chấm")
    if state.get("pending_execution"):
        raise RuntimeError("EXECUTION_OUTCOME_UNKNOWN_INSPECT_BEFORE_RESUME")
    client = fixture.connect()
    try:
        before_revision = fixture.fingerprint()
        before = fixture.protected(client)
        if fixture.cli(client, "GET " + KEY) != "":
            raise RuntimeError("SYNTHETIC_KEY_ALREADY_PRESENT")
        attempt_id = uuid.uuid4().hex
        run_label = "probe-run-" + attempt_id
        intent = {"attempt_id": attempt_id, "started_at": now(),
            "stdout": str(PRIVATE / (run_label + ".stdout.log")), "stderr": str(PRIVATE / (run_label + ".stderr.log"))}
        state["pending_execution"] = intent
        write_state(state)
        result = ctl("workflow", "run", workflow_id, "--trigger", "Bắt đầu kiểm", "--wait", "--timeout", "60000", label=run_label, timeout=80)
        state["last_execution"] = result
        state.pop("pending_execution")
        write_state(state)
        if result.get("status") != "success" or result.get("workflowId") != workflow_id or not result.get("executionId"):
            raise RuntimeError("NATIVE_EXECUTION_FAILED")
        observed = ctl("execution", "get", result["executionId"], "--logs", label="probe-execution-readback")
        if str(observed.get("workflowId")) != workflow_id or observed.get("status") != "success":
            raise RuntimeError("EXECUTION_IDENTITY_MISMATCH")
        runs = observed["data"]["resultData"]["runData"]
        for name in ["Bắt đầu kiểm", "Lưu tiến độ giả", "Đọc lại tiến độ", "Kiểm nội dung đã lưu", "Xóa khóa thử"]:
            if name not in runs or len(runs[name]) != 1 or runs[name][0].get("error"):
                raise RuntimeError("EXECUTION_NODE_COVERAGE_MISSING")
        output = runs["Kiểm nội dung đã lưu"][0]["data"]["main"][0][0]["json"]
        if output != {"product_id": "PRODUCT-TERM-MINI-K67", "verified": True}:
            raise RuntimeError("EXECUTION_OUTCOME_MISMATCH")
        if fixture.cli(client, "GET " + KEY) != "":
            raise RuntimeError("REDIS_DELETE_READBACK_FAILED")
        after = fixture.protected(client)
        after_revision = fixture.fingerprint()
        if before != after or before_revision != after_revision:
            raise RuntimeError("PROTECTED_STATE_CHANGED")
        evidence = {"outcome": "passed", "workflow_id": workflow_id, "execution_id": result["executionId"],
            "node_names": list(runs), "redis_key_absent": True, "protected_before": before, "protected_after": after,
            "observed_at": now(), "scope": "Native n8n Redis connection only; no AI/Portal/cutover"}
        (PRIVATE / "native-readback.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        run_id = "k67-n8n-redis-" + uuid.uuid4().hex
        streams = {}
        for field in ["stdout", "stderr"]:
            data = Path(intent[field]).read_bytes()
            path = ROOT / ".codex/product-evidence" / (run_id + "." + field + ".log")
            path.write_bytes(data)
            streams[field] = {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}
        readback_bytes = (PRIVATE / "probe-execution-readback.stdout.log").read_bytes()
        immutable = PRIVATE / ("execution-" + str(result["executionId"]) + ".private.json")
        if immutable.exists() and immutable.read_bytes() != readback_bytes:
            raise RuntimeError("EXECUTION_SNAPSHOT_CHANGED")
        immutable.write_bytes(readback_bytes)
        receipt = {"run_id": run_id, "attempt_id": attempt_id, "tree_revision": before_revision, "observed_after_revision": after_revision,
            "command": [NODE, CLI, "--profile", PROFILE, "--json", "workflow", "run", workflow_id,
                        "--trigger", "Bắt đầu kiểm", "--wait", "--timeout", "60000"],
            "native_runner": "n8n 1.121.3 manual execution", "executed_test_ids": [str(result["executionId"])],
            "exit_code": 0, "outcome": "passed", "failed": 0, "skipped": 0, **streams,
            "execution_readback": {"path": str(immutable), "sha256": hashlib.sha256(readback_bytes).hexdigest()},
            "environment": HOST, "config_id": "k67-redis-native-n8n-v1", "fixture_id": "synthetic-fixture-20261006",
            "protected_before": before, "protected_after": after, "redis_key_absent": True, "observed_at": now()}
        receipt_path = ROOT / ".codex/product-evidence" / (run_id + ".json")
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"outcome": "passed", "workflow_id": workflow_id, "execution_id": result["executionId"], "redis_key_absent": True}))
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--prepare", action="store_true")
    group.add_argument("--verify", action="store_true")
    group.add_argument("--reconcile", action="store_true")
    args = parser.parse_args()
    PRIVATE.mkdir(exist_ok=True)
    if not NODE:
        raise RuntimeError("NODE_NOT_FOUND")
    if call([NODE, "--version"], label="node-version").decode().strip() != "v24.15.0":
        raise RuntimeError("NODE_VERSION_MISMATCH")
    resolve()
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"profile": PROFILE, "host": HOST}
    if state.get("profile") != PROFILE or state.get("host") != HOST:
        raise RuntimeError("STATE_TARGET_MISMATCH")
    fixture = module()
    if args.reconcile:
        # Chỉ gỡ trạng thái chờ khi execution đã dừng được đọc trực tiếp từ n8n.
        if not state.get("pending_execution"):
            raise RuntimeError("NO_PENDING_EXECUTION")
        intent = state["pending_execution"]
        if not isinstance(intent, dict) or not re.fullmatch(r"[0-9a-f]{32}", str(intent.get("attempt_id", ""))):
            raise RuntimeError("PENDING_ATTEMPT_IDENTITY_MISSING")
        expected = PRIVATE / ("probe-run-" + intent["attempt_id"] + ".stdout.log")
        if intent.get("stdout") != str(expected):
            raise RuntimeError("PENDING_ATTEMPT_LOG_MISMATCH")
        # Thiếu log đúng lượt thì giữ unknown; không đọc lại con trỏ của lượt cũ.
        cached = json.loads(expected.read_text(encoding="utf-8"))
        if cached.get("workflowId") != state.get("probe_workflow") or not cached.get("executionId"):
            raise RuntimeError("PENDING_EXECUTION_IDENTITY_MISSING")
        resolve(state["probe_workflow"], "K67 · Kiểm kho tiến độ chấm")
        observed = ctl("execution", "get", cached["executionId"], "--logs", label="probe-reconcile-readback")
        if str(observed.get("id")) != str(cached["executionId"]) or observed.get("workflowId") != state["probe_workflow"] or observed.get("status") not in ["success", "error", "canceled", "crashed"] or not observed.get("stoppedAt"):
            raise RuntimeError("EXECUTION_NOT_CONFIRMED_TERMINAL")
        state["last_reconciled_execution"] = {"attempt_id": intent["attempt_id"], "executionId": str(observed["id"]), "status": observed["status"], "stoppedAt": observed["stoppedAt"], "readback_verified": True}
        state.pop("pending_execution")
        write_state(state)
        print(json.dumps({"outcome": "success", "reconciled": state["last_reconciled_execution"]}))
    elif args.prepare:
        prepare(state, fixture)
    else:
        verify(state, fixture)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        code = str(exc) if re.fullmatch(r"[A-Z_0-9]+", str(exc)) else type(exc).__name__
        print(json.dumps({"outcome": "failure", "code": code, "state": str(STATE)}))
        sys.exit(1)
