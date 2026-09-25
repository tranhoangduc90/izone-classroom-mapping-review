"""Chạy phép thử Term K56 trên hai container cô lập rồi gỡ đúng tài nguyên thử."""

import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[4]
SCRIPTS = Path("backend/ops/releases/writing-unified-20260925")
IMAGE = "codex-term-pg-concurrency:20260925"
NETWORK = "codex-term-pg-net-20260925"
POSTGRES = "codex-term-pg-canary-20260925"
TEST = "codex-term-concurrency-canary-20260925"
LABEL = "codex.task=term-pg-concurrency-20260925"
FILES = [
    Path("backend/package.json"), Path("backend/package-lock.json"),
    Path("docs/migrations/2026-08-19-term-test-writing-grading.sql"),
    SCRIPTS / "Dockerfile.term-pg-concurrency",
    SCRIPTS / "term_pg_concurrency_canary.mjs",
]


def load_ssh_helper():
    path = Path(__file__).with_name("term_canary_container.py")
    spec = importlib.util.spec_from_file_location("term_canary_container", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def exists(helper, client, kind, name):
    code, _ = helper.remote(client, f"docker {kind} inspect {name} --format '{{{{.Id}}}}'",
                            expected=(0, 1), stage="inspect")
    return code == 0


def verify_owned(helper, client, kind, name):
    _, raw = helper.remote(client, f"docker {kind} inspect {name} "
                           "--format '{{json .Config.Labels}}'" if kind == "image"
                           else f"docker {kind} inspect {name} --format '{{{{json .Labels}}}}'"
                           if kind == "network"
                           else f"docker {kind} inspect {name} --format '{{{{json .Config.Labels}}}}'",
                           stage="ownership")
    if json.loads(raw or "null").get("codex.task") != LABEL.split("=", 1)[1]:
        raise RuntimeError("CANARY_OWNERSHIP_MISMATCH")


def make_context(destination):
    # Dữ liệu vào: allowlist source, migration và Dockerfile; không đóng gói .env.
    # Việc chính: tạo tar tạm trên E: rồi chỉ gửi đúng tập file đã kiểm.
    # Kết quả: image thử có cùng logic backend với nhánh đang kiểm.
    # Khi lỗi: dừng trước khi sửa VPS.
    files = [*FILES, *sorted((ROOT / "backend/src").glob("*.js"))]
    with tarfile.open(destination, "w:gz") as archive:
        for item in files:
            path = item if item.is_absolute() else ROOT / item
            if not path.is_file() or path.is_symlink():
                raise RuntimeError("CANARY_CONTEXT_FILE_INVALID")
            archive.add(path, arcname=path.relative_to(ROOT).as_posix(), recursive=False)
        archive.add(ROOT / SCRIPTS / "Dockerfile.term-pg-concurrency",
                    arcname="Dockerfile", recursive=False)


def cleanup(helper, client):
    # Gỡ đúng object có nhãn canary; không đụng image/network/container khác.
    errors = []
    for name in [TEST, POSTGRES]:
        try:
            if exists(helper, client, "container", name):
                verify_owned(helper, client, "container", name)
                helper.remote(client, f"docker stop --time 10 {name}",
                              expected=(0, 1), stage="stop")
                helper.remote(client, f"docker rm {name}", stage="remove")
        except Exception:
            errors.append("CANARY_CONTAINER_CLEANUP_FAILED")
    try:
        if exists(helper, client, "network", NETWORK):
            verify_owned(helper, client, "network", NETWORK)
            helper.remote(client, f"docker network rm {NETWORK}", stage="network_remove")
    except Exception:
        errors.append("CANARY_NETWORK_CLEANUP_FAILED")
    try:
        if exists(helper, client, "image", IMAGE):
            verify_owned(helper, client, "image", IMAGE)
            helper.remote(client, f"docker image rm {IMAGE}", stage="image_remove")
    except Exception:
        errors.append("CANARY_IMAGE_CLEANUP_FAILED")
    if any(exists(helper, client, kind, name) for kind, name in [
        ("container", TEST), ("container", POSTGRES),
        ("network", NETWORK), ("image", IMAGE)
    ]):
        errors.append("CANARY_ROLLBACK_READBACK_FAILED")
    return sorted(set(errors))


def run(helper, client):
    # Không dùng lại object có cùng tên để tránh gỡ nhầm tài nguyên không sở hữu.
    for kind, name in [("container", TEST), ("container", POSTGRES),
                       ("network", NETWORK), ("image", IMAGE)]:
        if exists(helper, client, kind, name):
            raise RuntimeError("CANARY_TARGET_ALREADY_EXISTS")
    remote_path = "/tmp/codex-term-pg-" + uuid.uuid4().hex + ".tgz"
    with tempfile.TemporaryDirectory(dir="E:/Codex-Data/temp") as directory:
        local_path = Path(directory) / "term-pg-context.tgz"
        make_context(local_path)
        sftp = client.open_sftp()
        try:
            sftp.put(str(local_path), remote_path)
        finally:
            sftp.close()
        try:
            helper.remote(client, f"docker build --quiet --label {LABEL} "
                          f"-t {IMAGE} - < {remote_path}", timeout=360, stage="build")
        finally:
            helper.remote(client, f"rm -f -- {remote_path}", stage="temp_cleanup")
    helper.remote(client, f"docker network create --internal --label {LABEL} {NETWORK}",
                  stage="network_create")
    helper.remote(client, f"docker run -d --name {POSTGRES} --label {LABEL} "
                  f"--network {NETWORK} --network-alias canary-pg --restart no "
                  "--tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m "
                  "--memory 512m --cpus 1.0 "
                  "-e POSTGRES_DB=term_canary -e POSTGRES_HOST_AUTH_METHOD=trust "
                  "postgres:17-alpine", stage="postgres_run")
    for _ in range(40):
        code, _ = helper.remote(client, f"docker exec {POSTGRES} "
                                "pg_isready -U postgres -d term_canary",
                                expected=(0, 1, 2), stage="postgres_ready")
        if code == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("CANARY_POSTGRES_NOT_READY")
    code, body = helper.remote(client, f"docker run --name {TEST} --label {LABEL} "
                               f"--network {NETWORK} --restart no --read-only "
                               "--tmpfs /tmp:rw,noexec,nosuid,size=32m "
                               "--cap-drop ALL --security-opt no-new-privileges "
                               "--memory 512m --cpus 1.0 "
                               "-e TERM_CANARY_DATABASE_URL="
                               "postgresql://postgres@canary-pg:5432/term_canary "
                               f"{IMAGE}", timeout=90, expected=(0, 1, 2), stage="test")
    try:
        result = json.loads(body)
    except json.JSONDecodeError:
        return {"toolOutcome": "failure", "businessOutcome": "unknown",
                "errorCode": "CANARY_TEST_OUTPUT_INVALID", "exitCode": code}
    result["exitCode"] = code
    if code != 0 and result.get("businessOutcome") == "success":
        result["businessOutcome"] = "unknown"
        result["errorCode"] = "CANARY_EXIT_STATUS_CONFLICT"
    return result


def main():
    helper = load_ssh_helper()
    client = helper.connect()
    result = {"toolOutcome": "failure", "businessOutcome": "unknown"}
    try:
        try:
            result = run(helper, client)
        except Exception as exc:
            result = {"toolOutcome": "failure", "businessOutcome": "unknown",
                      "errorCode": str(exc) if isinstance(exc, RuntimeError)
                      else type(exc).__name__}
        if result.get("errorCode") == "CANARY_TARGET_ALREADY_EXISTS":
            result["rollbackStatus"] = "not_started"
        else:
            try:
                cleanup_errors = cleanup(helper, client)
            except Exception:
                cleanup_errors = ["CANARY_CLEANUP_READBACK_FAILED"]
            result["rollbackStatus"] = "complete" if not cleanup_errors else "partial"
            if cleanup_errors:
                result["cleanupErrors"] = cleanup_errors
    finally:
        client.close()
    print(json.dumps(result, ensure_ascii=False))
    if result.get("businessOutcome") != "success" or result["rollbackStatus"] != "complete":
        raise SystemExit(2)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
