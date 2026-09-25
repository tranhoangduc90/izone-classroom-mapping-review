"""Chuyển cache bài giả đã ghim thẳng vào container canary qua RAM/SSH."""

import json
import shutil
import subprocess
import sys

import paramiko
import win32cred


EXECUTION_ID = "2341142"
WORKFLOW_ID = "4mmOJmshY0AVIKTi"
OUTPUT_NODE = "Chấm bằng tuyến K56 thử nghiệm"
CONTAINER = "writing-term-api-canary"


def load_anonymized_cache():
    # Dữ liệu vào: đúng execution bài giả đã ghim, không truy vấn lượt học viên khác.
    # Việc chính: lấy duy nhất cacheValue trong RAM và kiểm run/Task.
    # Kết quả: chuỗi cache để seed; không ghi file hoặc in bài/nhận xét.
    # Khi lỗi: dừng trước SSH để tránh gửi nhầm payload.
    n8nctl = shutil.which("n8nctl.cmd")
    if not n8nctl:
        raise RuntimeError("CANARY_N8NCTL_NOT_FOUND")
    result = subprocess.run([n8nctl, "execution", "get", EXECUTION_ID,
                             "--logs", "--json"], capture_output=True,
                            text=True, encoding="utf-8", timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError("CANARY_EXECUTION_READ_FAILED")
    execution = json.loads(result.stdout)
    if (str(execution.get("id")) != EXECUTION_ID
            or execution.get("workflowId") != WORKFLOW_ID
            or execution.get("status") != "success"
            or execution.get("finished") is not True):
        raise RuntimeError("CANARY_EXECUTION_IDENTITY_MISMATCH")
    runs = execution.get("data", {}).get("resultData", {}).get("runData", {}).get(
        OUTPUT_NODE, [])
    if len(runs) != 1:
        raise RuntimeError("CANARY_EXECUTION_OUTPUT_COUNT_INVALID")
    try:
        output = runs[0]["data"]["main"][0][0]["json"]
        cache = output["cacheValue"]
        envelope = json.loads(cache)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise RuntimeError("CANARY_EXECUTION_CACHE_INVALID") from exc
    if (not isinstance(cache, str) or len(cache) > 8_000_000
            or envelope.get("schemaVersion") != 1
            or envelope.get("taskNumber") != 1
            or envelope.get("runKey") != output.get("runKey")
            or not str(envelope.get("runKey", "")).startswith("term-test-2-k56:")):
        raise RuntimeError("CANARY_EXECUTION_CACHE_CONTRACT_FAILED")
    return cache


def main():
    # Dữ liệu vào: cache bài giả và quyền SSH đã lưu trong Credential Manager.
    # Việc chính: truyền cache qua stdin của đúng container thử; không đưa vào dòng lệnh.
    # Kết quả: xác nhận một collect job được tạo, không in định danh hoặc bài làm.
    # Khi lỗi: trả mã tổng quát; không retry vì seed chỉ dùng một lần.
    cache = load_anonymized_cache()
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        command = ("docker exec -i " + CONTAINER + " node "
                   "ops/releases/writing-unified-20260925/term_canary_seed.mjs")
        stdin, stdout, stderr = client.exec_command(command, timeout=45)
        stdin.write(json.dumps({"cacheValue": cache}, ensure_ascii=False))
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8", errors="replace")
        stderr.read()
        if stdout.channel.recv_exit_status() != 0:
            raise RuntimeError("CANARY_REMOTE_SEED_FAILED")
        response = json.loads(body)
        if (response.get("outcome") != "success" or response.get("state") != "ready"
                or response.get("pendingJobs") != 1):
            raise RuntimeError("CANARY_REMOTE_SEED_RESULT_INVALID")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "seed_ready",
                          "pendingJobs": 1, "productionWrites": 0}))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}),
              file=sys.stderr)
        raise SystemExit(2)
