"""Thử image Term K56 mới trong container tách biệt, không đổi service."""

import json
import sys

import paramiko
import win32cred

from smoke_term_minimal_image import REMOTE_SCRIPT


OLD_TAG = "izone-k56-live-results:20260924.6-term-minimal-portal-rc"
NEW_TAG = "izone-k56-live-results:20260924.7-term-all-classes-rc"
OLD_ID = "sha256:81dcbf688730155737084b87bc2250851317d283aeb2519a4c47276012517608"
NEW_ID = "sha256:79dacbc8af471f28b6b598041f5a455dcbd33457e394289e3159aa3a17f17531"


def main():
    # Dữ liệu vào: kịch bản smoke đã kiểm và image mới ghim bằng digest.
    # Việc chính: chỉ thay đúng tag/digest trong kịch bản; chạy container không mạng.
    # Kết quả: đọc số ca qua và xác nhận API production chưa đổi.
    # Khi lỗi: dừng, không tự deploy image hoặc in credential.
    if REMOTE_SCRIPT.count(OLD_TAG) != 1 or REMOTE_SCRIPT.count(OLD_ID) != 1:
        raise RuntimeError("SMOKE_TEMPLATE_CHANGED")
    script = REMOTE_SCRIPT.replace(OLD_TAG, NEW_TAG).replace(OLD_ID, NEW_ID)
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=120)
        stdin.write(script)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        if stdout.channel.recv_exit_status() != 0:
            try:
                code = json.loads(error).get("errorCode", "ISOLATED_IMAGE_SMOKE_FAILED")
            except (ValueError, TypeError):
                code = "ISOLATED_IMAGE_SMOKE_FAILED"
            raise RuntimeError(code)
        report = json.loads(body)
        if report.get("businessOutcome") != "isolated_image_smoke":
            raise RuntimeError("ISOLATED_IMAGE_SMOKE_READBACK_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
