"""Dựng, đọc lại hoặc gỡ đúng container Term canary; không đụng dịch vụ thật."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid

import paramiko
import win32cred


ROOT = Path(__file__).resolve().parents[4]
CONTAINER = "writing-term-api-canary"
IMAGE = "codex-writing-term-canary:20260925-b"
LABEL = "codex.task=term-writing-canary-20260925"
SCRIPTS = Path("backend/ops/releases/writing-unified-20260925")
EXPLICIT_FILES = [
    Path("backend/package.json"), Path("backend/package-lock.json"),
    Path("docs/migrations/2026-08-19-term-test-writing-grading.sql"),
    *[SCRIPTS / name for name in (
        "Dockerfile.term-canary", "term_canary_server.mjs",
        "term_writer_http_canary.mjs",
        "term_canary_seed.mjs", "term_canary_seed_dispatch.mjs",
        "term_canary_health.mjs", "term_canary_audit.mjs")],
]


def remote(client, command, timeout=30, expected=(0,), stage="read"):
    # Dữ liệu vào: lệnh Docker cố định, không có bài/secret trên dòng lệnh.
    # Việc chính: chờ kết thúc và giữ nguyên exit code nghiệp vụ.
    # Kết quả: stdout ngắn cho kiểm chứng; lỗi chỉ nêu mã, không in stderr rộng.
    # Khi lỗi: dừng, không thử lại thao tác có thể đã tạo container.
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    output = stdout.read().decode("utf-8", errors="replace")
    error_text = stderr.read().decode("utf-8", errors="replace")
    exit_code = stdout.channel.recv_exit_status()
    if exit_code not in expected:
        if stage == "build":
            last_line = error_text.strip().splitlines()[-1:] or [""]
            safe_line = re.sub(r"https?://[^\s]+", "[URL]", last_line[0])
            safe_line = re.sub(r"(?i)(token|password|secret)[^\s]*", "[REDACTED]", safe_line)
            raise RuntimeError("TERM_CANARY_BUILD_FAILED_" + str(exit_code)
                               + ":" + safe_line[:240])
        raise RuntimeError(f"TERM_CANARY_{stage.upper()}_FAILED_{exit_code}")
    return exit_code, output.strip()


def connect():
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    return client


def object_exists(client, object_type, name):
    code, _ = remote(client, f"docker {object_type} inspect --format '{{{{.Id}}}}' {name}",
                     expected=(0, 1))
    return code == 0


def make_context(destination):
    # Dữ liệu vào: allowlist source trong linked worktree, không lấy .env/credential.
    # Việc chính: đóng gói đúng source API, migration và script canary.
    # Kết quả: tar tạm thời ở E:, xóa sau khi dùng.
    # Khi lỗi: không tạo/mở container; từ chối symlink và file thiếu.
    sources = [*EXPLICIT_FILES, *sorted(Path("backend/src").glob("*.js"))]
    if not all((ROOT / path).is_file() and not (ROOT / path).is_symlink()
               for path in sources):
        raise RuntimeError("TERM_CANARY_CONTEXT_FILE_INVALID")
    with tarfile.open(destination, "w:gz", format=tarfile.GNU_FORMAT) as archive:
        for path in sources:
            archive.add(ROOT / path, arcname=path.as_posix(), recursive=False)
        archive.add(ROOT / SCRIPTS / "Dockerfile.term-canary",
                    arcname="Dockerfile", recursive=False)
    return len(sources)


def inspect_container(client):
    if not object_exists(client, "container", CONTAINER):
        return None
    fields = {
        "labels": "{{json .Config.Labels}}",
        "ports": "{{json .NetworkSettings.Ports}}",
        "networks": "{{json .NetworkSettings.Networks}}",
        "running": "{{.State.Running}}",
        "health": "{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}",
        "readOnlyRoot": "{{.HostConfig.ReadonlyRootfs}}",
        "restartPolicy": "{{.HostConfig.RestartPolicy.Name}}",
    }
    metadata = {}
    for name, template in fields.items():
        _, raw = remote(client, "docker container inspect --format '" + template
                        + "' " + CONTAINER, stage="inspect_" + name)
        metadata[name] = json.loads(raw) if name in {"labels", "ports", "networks"} else raw
    labels = metadata["labels"] or {}
    if labels.get("codex.task") != LABEL.split("=", 1)[1]:
        raise RuntimeError("TERM_CANARY_CONTAINER_OWNERSHIP_MISMATCH")
    published = metadata["ports"] or {}
    if any(bindings for bindings in published.values()):
        raise RuntimeError("TERM_CANARY_PUBLIC_PORT_FOUND")
    if set(metadata["networks"]) != {"n8n-net"}:
        raise RuntimeError("TERM_CANARY_NETWORK_MISMATCH")
    return {"businessOutcome": "present", "running": metadata["running"] == "true",
              "health": metadata["health"],
              "publishedPorts": 0, "networks": ["n8n-net"],
              "readOnlyRoot": metadata["readOnlyRoot"] == "true",
              "restartPolicy": metadata["restartPolicy"]}


def audit(client):
    result = inspect_container(client)
    if result is None:
        return {"businessOutcome": "absent"}
    if result["running"]:
        _, body = remote(client, "docker exec " + CONTAINER + " node "
                         "ops/releases/writing-unified-20260925/term_canary_audit.mjs",
                         stage="app_audit")
        detail = json.loads(body)
        if detail.get("outcome") != "success":
            raise RuntimeError("TERM_CANARY_AUDIT_INVALID")
        result["app"] = detail
    return result


def diagnose(client):
    # Dữ liệu vào: container canary do đúng task sở hữu.
    # Việc chính: hỏi HTTP nội bộ chỉ lấy mã trạng thái, không đọc body hoặc log bài làm.
    # Kết quả: metadata và mã lỗi an toàn để phân biệt ứng dụng với công cụ kiểm.
    # Khi lỗi: không thay đổi container hoặc tự chạy lại job.
    result = inspect_container(client)
    if result is None:
        return {"businessOutcome": "absent"}
    script = ("fetch('http://127.0.0.1:8791/__canary/audit')"
              ".then(async r=>{const b=await r.json();"
              "console.log(JSON.stringify({status:r.status,ok:b.ok===true,"
              "keys:Object.keys(b).sort()}))})"
              ".catch(e=>console.log(JSON.stringify({error:e.name})))")
    _, output = remote(client, "docker exec " + CONTAINER + " node -e "
                       + shlex.quote(script), stage="diagnose")
    result["auditHttp"] = json.loads(output)
    _stdin, stdout, stderr = client.exec_command(
        "docker exec " + CONTAINER + " node "
        "ops/releases/writing-unified-20260925/term_canary_audit.mjs", timeout=20)
    audit_output = stdout.read().decode("utf-8", errors="replace")
    audit_error = stderr.read().decode("utf-8", errors="replace")
    audit_exit = stdout.channel.recv_exit_status()
    result["auditScript"] = {"exitCode": audit_exit,
                             "outputIsJson": audit_output.lstrip().startswith("{"),
                             "errorType": "SyntaxError" if "SyntaxError" in audit_error else
                             "ERR_MODULE_NOT_FOUND" if "ERR_MODULE_NOT_FOUND" in audit_error else
                             "TypeError" if "TypeError" in audit_error else
                             "other" if audit_error else "none"}
    return result


def browser_readback(client, pages_root):
    # Dữ liệu vào: kết quả bài giả từ đúng container canary và source Pages được chỉ định.
    # Việc chính: truyền JSON qua RAM/stdin tới Chrome cục bộ, không in bài hoặc điểm.
    # Kết quả: chỉ trả trạng thái, Task và số lần trang đọc kết quả.
    # Khi lỗi: dừng tại bước lỗi, không tự gọi lại API hoặc tạo bài mới.
    state = inspect_container(client)
    if state is None or not state["running"] or state["health"] != "healthy":
        raise RuntimeError("TERM_CANARY_BROWSER_PRECONDITION_FAILED")
    if not pages_root or not Path(pages_root).is_dir():
        raise RuntimeError("TERM_CANARY_PAGES_ROOT_INVALID")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("TERM_CANARY_NODE_NOT_FOUND")
    script = ("fetch('http://127.0.0.1:8791/__canary/result')"
              ".then(async r=>{const b=await r.json();"
              "process.stdout.write(JSON.stringify({status:r.status,result:b}))})"
              ".catch(()=>process.exitCode=3)")
    _, raw = remote(client, "docker exec " + CONTAINER + " node -e "
                    + shlex.quote(script), stage="browser_result_read")
    response = json.loads(raw)
    if response.get("status") != 200:
        raise RuntimeError("TERM_CANARY_BROWSER_RESULT_NOT_READY")
    checked = subprocess.run(
        [node, str(ROOT / SCRIPTS / "term_canary_browser_check.mjs")],
        input=json.dumps(response["result"], ensure_ascii=False),
        text=True, encoding="utf-8", capture_output=True, timeout=45,
        env={**os.environ, "K56_PAGES_ROOT": str(Path(pages_root).resolve())},
        check=False,
    )
    if checked.returncode != 0:
        raise RuntimeError("TERM_CANARY_BROWSER_VERIFICATION_FAILED")
    outcome = json.loads(checked.stdout)
    if (outcome.get("toolOutcome") != "success"
            or outcome.get("businessOutcome") != "browser_result_verified"
            or outcome.get("externalRequests") != 0
            or outcome.get("pageErrors") != 0):
        raise RuntimeError("TERM_CANARY_BROWSER_READBACK_INVALID")
    return {"businessOutcome": "browser_result_verified",
            "testSlug": outcome["testSlug"], "taskNumber": outcome["taskNumber"],
            "resultReads": outcome["resultReads"], "productionWrites": 0}


def seed_dispatch(client, profile_name):
    # Dữ liệu vào: canary rỗng đã kiểm và bài giả cố định trong image thử.
    # Việc chính: tạo một job dispatch, không nhận bài/định danh từ người dùng.
    # Kết quả: readback một job chờ, chưa gọi Portal.
    # Khi lỗi: không retry vì seed là thao tác một lần; giữ trạng thái để đối soát.
    if profile_name not in {"term", "term1"}:
        raise RuntimeError("TERM_CANARY_DISPATCH_PROFILE_INVALID")
    before = audit(client)
    if (before.get("health") != "healthy" or before.get("app", {}).get("profileName") != profile_name
            or before["app"].get("seedState") != "empty"
            or before["app"].get("portalMockCalls") != 0):
        raise RuntimeError("TERM_CANARY_DISPATCH_PRECONDITION_FAILED")
    _, raw = remote(client, "docker exec " + CONTAINER + " node "
                    "ops/releases/writing-unified-20260925/term_canary_seed_dispatch.mjs",
                    stage="dispatch_seed")
    seeded = json.loads(raw)
    if (seeded.get("outcome") != "success" or seeded.get("pendingJobs") != 1
            or seeded.get("jobType") != "dispatch"):
        raise RuntimeError("TERM_CANARY_DISPATCH_SEED_INVALID")
    after = audit(client)
    jobs = after.get("app", {}).get("jobs", [])
    if (after["app"].get("seedState") != "ready"
            or after["app"].get("portalMockCalls") != 0
            or len(jobs) != 1 or jobs[0].get("job_type") != "dispatch"
            or jobs[0].get("status") != "queued" or jobs[0].get("total") != 1):
        raise RuntimeError("TERM_CANARY_DISPATCH_READBACK_FAILED")
    return {"businessOutcome": "dispatch_ready", "profile": profile_name,
            "pendingJobs": 1, "portalMockCalls": 0,
            "productionServicesChanged": 0}


def deploy(client, profile_name, writer_bridge=False):
    # Dữ liệu vào: URL webhook thử qua biến môi trường của phiên vận hành.
    # Việc chính: chỉ chuyển URL đúng dạng sang container thử, không in URL.
    # Kết quả: backend giả dùng adapter thật; lỗi dừng trước khi tạo image/container.
    writer_url = os.environ.get("TERM_CANARY_WRITER_URL", "") if writer_bridge else ""
    if writer_bridge and profile_name not in {"term", "term1"}:
        raise RuntimeError("TERM_CANARY_WRITER_TERM_ONLY")
    if writer_bridge and not re.fullmatch(
            r"https://n8n-ai\.izone\.edu\.vn/webhook/term-k56-writer-bridge-"
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            writer_url):
        raise RuntimeError("TERM_CANARY_WRITER_URL_INVALID")
    if object_exists(client, "container", CONTAINER) or object_exists(client, "image", IMAGE):
        raise RuntimeError("TERM_CANARY_ALREADY_EXISTS")
    _, network = remote(client, "docker network inspect --format '{{.Name}}' n8n-net")
    if network != "n8n-net":
        raise RuntimeError("TERM_CANARY_NETWORK_MISSING")
    remote_path = "/tmp/codex-writing-term-canary-" + uuid.uuid4().hex + ".tgz"
    if not re.fullmatch(r"/tmp/codex-writing-term-canary-[a-f0-9]{32}\.tgz", remote_path):
        raise RuntimeError("TERM_CANARY_TEMP_PATH_INVALID")
    with tempfile.TemporaryDirectory(dir="E:/Codex-Data/temp") as directory:
        local_path = Path(directory) / "term-canary-context.tgz"
        file_count = make_context(local_path)
        sftp = client.open_sftp()
        try:
            sftp.put(str(local_path), remote_path)
        finally:
            sftp.close()
        try:
            remote(client, "docker build --quiet --label " + LABEL + " -t " + IMAGE
                   + " - < " + remote_path, timeout=360, stage="build")
        finally:
            remote(client, "rm -f -- " + remote_path, stage="temp_cleanup")
    if not object_exists(client, "image", IMAGE):
        raise RuntimeError("TERM_CANARY_IMAGE_NOT_BUILT")
    remote(client, "docker run -d --name " + CONTAINER + " --label " + LABEL
           + " --network n8n-net --restart no --read-only"
           + " --tmpfs /tmp:rw,noexec,nosuid,size=64m"
           + " --cap-drop ALL --security-opt no-new-privileges"
           + " --memory 768m --cpus 1.0"
           + " -e TERM_CANARY_PROFILE=" + profile_name
           + (" -e TERM_CANARY_WRITER_URL=" + shlex.quote(writer_url)
              if writer_bridge else "") + " " + IMAGE,
           timeout=30, stage="run")
    return {"businessOutcome": "created", "contextFiles": file_count,
            "productionServicesChanged": 0}


def rollback(client):
    state = inspect_container(client)
    if state is not None:
        if state["running"]:
            remote(client, "docker stop --time 15 " + CONTAINER, timeout=30)
        remote(client, "docker rm " + CONTAINER)
    if object_exists(client, "image", IMAGE):
        _, raw = remote(client, "docker image inspect --format '{{json .Config.Labels}}' "
                        + IMAGE)
        if json.loads(raw).get("codex.task") != LABEL.split("=", 1)[1]:
            raise RuntimeError("TERM_CANARY_IMAGE_OWNERSHIP_MISMATCH")
        remote(client, "docker image rm " + IMAGE, timeout=30)
    if object_exists(client, "container", CONTAINER) or object_exists(client, "image", IMAGE):
        raise RuntimeError("TERM_CANARY_ROLLBACK_READBACK_FAILED")
    return {"businessOutcome": "rolled_back", "productionServicesChanged": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["deploy", "inspect", "diagnose", "audit",
                                         "seed-dispatch", "browser-readback", "rollback"])
    parser.add_argument("--profile", choices=["term", "term1", "mini"], default="term")
    parser.add_argument("--pages-root")
    parser.add_argument("--writer-bridge", action="store_true")
    args = parser.parse_args()
    client = connect()
    try:
        if args.mode == "deploy":
            result = deploy(client, args.profile, args.writer_bridge)
        elif args.mode == "inspect":
            result = inspect_container(client) or {"businessOutcome": "absent"}
        elif args.mode == "diagnose":
            result = diagnose(client)
        elif args.mode == "seed-dispatch":
            result = seed_dispatch(client, args.profile)
        elif args.mode == "audit":
            result = audit(client)
        elif args.mode == "browser-readback":
            result = browser_readback(client, args.pages_root)
        else:
            result = rollback(client)
        print(json.dumps({"toolOutcome": "success", **result}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                          "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
