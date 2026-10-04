"""Kết nối VPS bằng Windows Credential Manager mà không đưa mật khẩu vào command line.

Dữ liệu nhận vào: tên máy đã khai báo, lệnh hoặc nội dung/file cần tải lên qua stdin/SFTP.
Việc chính: kiểm host key, đăng nhập bằng credential trong Keyring và thực hiện đúng một thao tác.
Kết quả: chỉ in stdout của lệnh hoặc JSON trạng thái; không in password hay nội dung secret.
Khi lỗi: trả exit code 2 và thông báo ngắn đã loại ký tự điều khiển.
"""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import sys
import uuid
import winreg

import paramiko
import win32cred
from cryptography.hazmat.primitives.asymmetric import rsa


HOSTS = {
    "vps_1": ("ducizone.ddns.net", "Codex/SSH/vps_1"),
    "vps_2": ("ducvps2.ddns.net", "Codex/SSH/vps_2"),
    "vps_3": ("ducvps3.ddns.net", "Codex/SSH/vps_3"),
    "thi_thu": ("izonethithu.ddnsking.com", "Codex/SSH/thi_thu"),
}
KNOWN_HOSTS = r"C:\Users\ADMIN\.ssh\known_hosts"
REMOTE_PATH = re.compile(r"^/(?:opt/izone-[A-Za-z0-9._/-]+|tmp/(?:ai-gateway|gemini-worker-v2)-[A-Za-z0-9._-]+\.tgz)$")


def credential_password(target: str) -> tuple[str, str]:
    credential = win32cred.CredRead(target, win32cred.CRED_TYPE_GENERIC)
    blob = credential["CredentialBlob"]
    if isinstance(blob, str):
        password = blob
    else:
        password = ""
        for encoding in ("utf-8", "utf-16-le"):
            try:
                candidate = blob.decode(encoding).rstrip("\x00")
                if candidate and "\x00" not in candidate:
                    password = candidate
                    break
            except UnicodeDecodeError:
                continue
    if not password:
        raise RuntimeError("ssh_password_unavailable")
    stored_username = str(credential.get("UserName") or "root")
    username = stored_username.split("@", 1)[0] if "@" in stored_username else stored_username
    return username, password


def checked_remote_path(value: str) -> str:
    if not REMOTE_PATH.fullmatch(value) or posixpath.normpath(value) != value:
        raise RuntimeError("remote_path_not_allowed")
    return value


def putty_rsa_host_key(host: str) -> paramiko.RSAKey | None:
    """Đọc khóa RSA đã được người dùng tin cậy trong PuTTY, không tự thêm khóa mới."""
    registry_path = r"Software\SimonTatham\PuTTY\SshHostKeys"
    value_name = f"rsa2@22:{host}"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, registry_path) as key:
            raw, _kind = winreg.QueryValueEx(key, value_name)
    except FileNotFoundError:
        return None
    parts = str(raw).split(",", 1)
    if len(parts) != 2:
        raise RuntimeError("putty_host_key_invalid")
    exponent = int(parts[0], 16)
    modulus = int(parts[1], 16)
    public_key = rsa.RSAPublicNumbers(exponent, modulus).public_key()
    return paramiko.RSAKey(key=public_key)


def connect(slot: str) -> tuple[paramiko.SSHClient, str]:
    host, credential_target = HOSTS[slot]
    username, password = credential_password(credential_target)
    client = paramiko.SSHClient()
    client.load_system_host_keys(KNOWN_HOSTS)
    trusted_putty_key = putty_rsa_host_key(host)
    if trusted_putty_key is not None:
        client.get_host_keys().add(host, trusted_putty_key.get_name(), trusted_putty_key)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        host,
        port=22,
        username=username,
        password=password,
        look_for_keys=False,
        allow_agent=False,
        timeout=15,
    )
    return client, password


def run_command(client: paramiko.SSHClient, command: str, timeout: int) -> str:
    if not command.strip() or len(command.encode("utf-8")) > 200_000:
        raise RuntimeError("remote_command_invalid")
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")
    status = stdout.channel.recv_exit_status()
    if status != 0:
        safe_tail = " ".join(error[-500:].split())
        raise RuntimeError(f"remote_command_failed:{status}:{safe_tail}")
    return output


def upload_bytes(client: paramiko.SSHClient, remote_path: str, payload: bytes) -> None:
    destination = checked_remote_path(remote_path)
    temporary = f"{destination}.new-{uuid.uuid4().hex}"
    with client.open_sftp() as sftp:
        try:
            with sftp.open(temporary, "wb") as handle:
                handle.write(payload)
            sftp.chmod(temporary, 0o600)
            sftp.posix_rename(temporary, destination)
        except Exception:
            try:
                sftp.remove(temporary)
            except Exception:
                pass
            raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slot", choices=tuple(HOSTS), required=True)
    parser.add_argument("--action", choices=("probe", "command", "upload-file", "upload-stdin"), required=True)
    parser.add_argument("--local-path", default="")
    parser.add_argument("--remote-path", default="")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    if not 5 <= args.timeout <= 1800:
        raise RuntimeError("timeout_invalid")

    client, password = connect(args.slot)
    try:
        if args.action == "probe":
            run_command(client, "true", args.timeout)
            print(json.dumps({"outcome": "success", "slot": args.slot}, ensure_ascii=False))
        elif args.action == "command":
            sys.stdout.write(run_command(client, sys.stdin.read(), args.timeout))
        elif args.action == "upload-file":
            if not os.path.isfile(args.local_path):
                raise RuntimeError("local_file_missing")
            with open(args.local_path, "rb") as handle:
                upload_bytes(client, args.remote_path, handle.read())
            print(json.dumps({"outcome": "success", "slot": args.slot, "action": args.action}, ensure_ascii=False))
        else:
            upload_bytes(client, args.remote_path, sys.stdin.buffer.read())
            print(json.dumps({"outcome": "success", "slot": args.slot, "action": args.action}, ensure_ascii=False))
        return 0
    finally:
        password = ""
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        raise SystemExit(main())
    except Exception as exc:
        safe = " ".join(str(exc).split())
        print(json.dumps({"outcome": "failure", "error": safe[-600:]}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
