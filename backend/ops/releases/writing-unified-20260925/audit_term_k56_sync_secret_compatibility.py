"""So khớp khóa API K56 với Redis hiện có trên VPS; chỉ trả boolean, không lộ khóa."""

import json
import shlex
import subprocess
import sys
import hashlib
import hmac

import paramiko
import win32cred


REMOTE_CODE = r'''
import hashlib
import hmac
import json
import subprocess
from urllib.parse import urlparse

# Dữ liệu vào: tên hai container cố định và tên biến/key; không nhận secret từ CLI.
# Việc chính: đọc hai secret vào RAM trên VPS, so bằng phép so sánh an toàn.
# Kết quả: chỉ cờ và dấu URL để so trong RAM; không in hoặc lưu giá trị bí mật.
# Khi lỗi: trả mã an toàn; không đưa stderr của Docker vào kết quả.
def read(command):
    result = subprocess.run(command, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False, timeout=10)
    if result.returncode != 0:
        raise RuntimeError("SECRET_READ_FAILED")
    return result.stdout.strip()

k56 = read(["docker", "exec", "izone-k56-ic2264-api", "sh", "-c",
            'printf %s "$WRITING_TEST_SYNC_SECRET"'])
redis = read(["docker", "exec", "redis", "redis-cli", "--raw", "GET",
              "writing:test:sync_secret"])
k56_worker_redis = read(["docker", "exec", "redis", "redis-cli", "--raw", "GET",
                         "writing:test:k56_ic2264_sync_secret"])
notify_url = read(["docker", "exec", "izone-k56-ic2264-api", "sh", "-c",
                   'printf %s "$TERM_TEST_NOTIFY_URL"'])
notify = urlparse(notify_url.decode("utf-8", errors="replace")) if notify_url else None
print(json.dumps({"k56SecretPresent": len(k56) >= 32,
                  "redisKeyPresent": len(redis) >= 32,
                  "matchesExistingRedisKey": len(k56) >= 32 and len(redis) >= 32
                  and hmac.compare_digest(k56, redis),
                  "k56WorkerKeyPresent": len(k56_worker_redis) >= 32,
                  "matchesK56WorkerKey": len(k56) >= 32 and len(k56_worker_redis) >= 32
                  and hmac.compare_digest(k56, k56_worker_redis),
                  "k56NotifierConfigured": bool(notify_url),
                  "notifierHost": notify.hostname if notify else None,
                  "notifierUsesWebhookPath": bool(notify and notify.path.startswith("/webhook/")),
                  "notifierPathMentionsK56": bool(notify and "k56" in notify.path.lower()),
                  "notifierPathDigest": hashlib.sha256(notify.path.encode()).hexdigest()
                  if notify else None},
                 sort_keys=True))
'''


def remote(client, command):
    # Chỉ lấy metadata hoặc ba cờ; không trả nội dung secret từ remote.
    _stdin, stdout, stderr = client.exec_command(command, timeout=25)
    output = stdout.read().decode("utf-8", errors="replace")
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError("K56_SECRET_COMPATIBILITY_REMOTE_CHECK_FAILED")
    return output


def main():
    # Dữ liệu vào: credential SSH trong Windows Keyring; không nhận mật khẩu từ lệnh.
    # Việc chính: kiểm container đúng tên rồi chạy so sánh cục bộ trên VPS.
    # Kết quả: trạng thái có/không, không xuất giá trị khóa hoặc hash.
    # Khi lỗi: trả unknown và mã an toàn; không thử thay đổi Redis/container.
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
        names = set(remote(client, "docker ps --format '{{.Names}}'").splitlines())
        if not {"izone-k56-ic2264-api", "redis"}.issubset(names):
            return {"toolOutcome": "success", "businessOutcome": "not_ready",
                    "targetContainersPresent": False, "productionWrites": 0}
        output = remote(client, "python3 -c " + shlex.quote(REMOTE_CODE))
        flags = json.loads(output)
        if set(flags) != {"k56SecretPresent", "redisKeyPresent",
                          "matchesExistingRedisKey", "k56WorkerKeyPresent",
                          "matchesK56WorkerKey", "k56NotifierConfigured",
                          "notifierHost", "notifierUsesWebhookPath",
                          "notifierPathMentionsK56", "notifierPathDigest"}:
            raise RuntimeError("K56_SECRET_COMPATIBILITY_RESPONSE_INVALID")
        workflow = subprocess.run(
            ["n8nctl.cmd", "--profile", "default", "--json", "workflow", "get",
             "zlXdb0K1UzZeeB3t", "--redact"], capture_output=True,
            encoding="utf-8", errors="replace", check=False, timeout=20)
        if workflow.returncode != 0:
            raise RuntimeError("K56_ACTIVE_WORKFLOW_READ_FAILED")
        nodes = json.loads(workflow.stdout)["nodes"]
        webhooks = [node for node in nodes if node.get("type") == "n8n-nodes-base.webhook"]
        if len(webhooks) != 1:
            raise RuntimeError("K56_ACTIVE_WEBHOOK_COUNT_DRIFT")
        expected_path = "/webhook/" + webhooks[0]["parameters"]["path"]
        expected_digest = hashlib.sha256(expected_path.encode("utf-8")).hexdigest()
        target_matches = bool(flags["notifierPathDigest"] and
                              hmac.compare_digest(flags["notifierPathDigest"], expected_digest))
        del flags["notifierPathDigest"]
        compatible = (flags["k56SecretPresent"] and flags["k56WorkerKeyPresent"]
                      and flags["matchesK56WorkerKey"]
                      and flags["k56NotifierConfigured"]
                      and flags["notifierUsesWebhookPath"]
                      and target_matches)
        return {"toolOutcome": "success", "businessOutcome": "compatible"
                if compatible else "not_ready",
                **flags, "notifierTargetsActiveK56Worker": target_matches,
                "targetContainersPresent": True, "productionWrites": 0}
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                          "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
