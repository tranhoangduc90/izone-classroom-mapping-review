"""Kiểm mạng n8n/Redis trước khi dựng API Term canary; chỉ đọc metadata Docker."""

import json
import re
import sys

import paramiko
import win32cred


def remote(client, command):
    # Dữ liệu vào: lệnh Docker chỉ đọc, không chứa mật khẩu hoặc bài học viên.
    # Việc chính: lấy stdout trong bộ nhớ và kiểm exit; không đưa stderr ra báo cáo.
    # Kết quả: metadata container/mạng; lỗi thì trả mã an toàn.
    _stdin, stdout, stderr = client.exec_command(command, timeout=20)
    content = stdout.read().decode("utf-8", errors="replace")
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError("TERM_CANARY_REMOTE_READ_FAILED")
    return content


def main():
    # Dữ liệu vào: quyền SSH đã lưu và danh sách container đang chạy.
    # Việc chính: nhận diện đúng n8n, Redis và mạng chung mà không đọc env/volume.
    # Kết quả: cho biết có thể thiết kế canary cô lập hay chưa; chưa tạo gì trên VPS.
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
        all_names = remote(client, "docker ps --format '{{.Names}}'").splitlines()
        safe_names = [name for name in all_names
                      if re.fullmatch(r"[A-Za-z0-9_.-]+", name)]
        n8n_names = [name for name in safe_names if name == "n8n"]
        redis_names = [name for name in safe_names if "redis" in name.lower()]
        if len(n8n_names) != 1 or not redis_names:
            return {"toolOutcome": "success", "businessOutcome": "not_ready",
                    "n8nCount": len(n8n_names), "redisCount": len(redis_names)}
        names = [*n8n_names, *redis_names]
        networks = {}
        for name in names:
            raw = remote(client,
                         "docker inspect --format '{{json .NetworkSettings.Networks}}' "
                         + name)
            networks[name] = sorted(json.loads(raw).keys())
        shared = {name: sorted(set(networks["n8n"]) & set(networks[name]))
                  for name in redis_names}
        redis_probe = "not_checked"
        if "redis" in shared and shared["redis"]:
            ping = remote(client, "docker exec redis redis-cli --raw PING").strip()
            redis_probe = ("ready_without_auth" if ping == "PONG" else
                           "auth_required" if "NOAUTH" in ping else "unexpected")
        memory_kib = int(remote(client, "awk '/MemAvailable:/ {print $2}' /proc/meminfo").strip())
        disk_kib = int(remote(client, "df -Pk /var/lib/docker | awk 'NR==2 {print $4}'").strip())
        return {"toolOutcome": "success",
                "businessOutcome": "ready_for_isolated_design"
                if any(shared.values()) and redis_probe == "ready_without_auth"
                and memory_kib >= 2_097_152 and disk_kib >= 2_097_152
                else "not_ready",
                "n8nNetworks": networks["n8n"],
                "redisSharedNetworks": shared,
                "redisProbe": redis_probe,
                "memoryAvailableMiB": memory_kib // 1024,
                "dockerDiskAvailableMiB": disk_kib // 1024,
                "candidateContainerPresent": "writing-term-api-canary" in safe_names}
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
