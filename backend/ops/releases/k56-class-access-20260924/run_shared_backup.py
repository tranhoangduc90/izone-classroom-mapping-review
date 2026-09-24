"""Chạy backup/restore drill đã kiểm cú pháp; chỉ in metadata, không in dữ liệu."""

import json
from pathlib import Path
import re
import sys

import paramiko
import win32cred


def main():
    # Dữ liệu vào: script backup cố định và SSH credential trong Credential Manager.
    # Việc chính: gửi script vào shell qua stdin, kiểm exit và dấu readback.
    # Kết quả: chỉ đường dẫn riêng tư, hash và tổng số hàng; không xuất dump.
    # Khi lỗi: không suy diễn backup thành công và không chạy migration.
    script = (Path(__file__).parent / "backup_shared_cutover.sh").read_text(
        encoding="utf-8")
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
        if "--validate-shell" in sys.argv:
            syntax_in, syntax_out, syntax_err = client.exec_command("sh -n", timeout=20)
            syntax_in.write(script)
            syntax_in.channel.shutdown_write()
            syntax_out.read()
            syntax_err.read()
            if syntax_out.channel.recv_exit_status() != 0:
                raise RuntimeError("SHARED_BACKUP_SHELL_SYNTAX_INVALID")
            print(json.dumps({"toolOutcome": "success",
                              "businessOutcome": "shared_shell_syntax_valid",
                              "productionDatabaseWrites": 0}))
            return
        stdin, stdout, stderr = client.exec_command("sh -s", timeout=300)
        stdin.write(script)
        stdin.channel.shutdown_write()
        result = stdout.read().decode("utf-8").strip()
        stderr.read()
        status = stdout.channel.recv_exit_status()
    finally:
        client.close()
    match = re.fullmatch(
        r"BACKUP_RESTORE_VERIFIED\|(/opt/backups/k56-shared-cutover-[A-Za-z0-9]+)"
        r"\|([0-9a-f]{64})\|([0-9a-f]{64})\|(\d+)\|(\d+)", result)
    if status != 0 or match is None:
        raise RuntimeError("SHARED_BACKUP_OR_RESTORE_NOT_VERIFIED")
    print(json.dumps({"toolOutcome": "success",
                      "businessOutcome": "backup_restore_verified",
                      "backupDirectory": match.group(1),
                      "sharedSha256": match.group(2),
                      "k56Sha256": match.group(3),
                      "restoredSharedClassRows": int(match.group(4)),
                      "restoredK56RosterRows": int(match.group(5)),
                      "productionDatabaseWrites": 0}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
