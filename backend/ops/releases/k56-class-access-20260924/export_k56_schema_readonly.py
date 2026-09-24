"""Xuất DDL K56 từ production về kho riêng E:, không đọc bản ghi học viên."""

import hashlib
import json
from pathlib import Path
import sys

import paramiko
import win32cred


DB_CONTAINER = "izone-k56-demo-k56-demo-db-1"
SOURCE_DATABASE = "izone_mapping_k56_ic2264"
OUTPUT = Path("E:/Codex-Data/izone-release-candidates/k56-shared-database/k56-assessment-schema.sql")


def remote_read(client, command):
    # Dữ liệu vào: lệnh pg_dump chỉ-schema trong container database K56 đã xác định.
    # Việc chính: kiểm exit; không in stderr vì có thể chứa chi tiết cấu hình riêng.
    # Kết quả: DDL dạng byte, không có hàng dữ liệu hoặc credential.
    stdin, stdout, stderr = client.exec_command(command, timeout=60)
    stdin.channel.shutdown_write()
    raw = stdout.read()
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError("K56_SCHEMA_DUMP_FAILED")
    return raw


def main():
    # Dữ liệu vào: SSH trong Credential Manager; không lấy password ra output.
    # Việc chính: xác minh tên DB rồi xuất riêng schema assessment bằng pg_dump.
    # Kết quả: file riêng tư trên E: và hash để đối soát, không ghi VPS/Git.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0] or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        database = remote_read(client,
            f"docker exec {DB_CONTAINER} sh -lc 'psql -XAt -U \"$POSTGRES_USER\" "
            f"-d {SOURCE_DATABASE} -c \"SELECT current_database()\"'")
        if database.decode("utf-8").strip() != SOURCE_DATABASE:
            raise RuntimeError("UNEXPECTED_K56_DATABASE")
        raw = remote_read(client,
            f"docker exec {DB_CONTAINER} sh -lc 'pg_dump -U \"$POSTGRES_USER\" "
            f"-d {SOURCE_DATABASE} --schema-only --schema=assessment "
            "--no-owner --no-acl'")
    finally:
        client.close()
    if (b"CREATE SCHEMA assessment;" not in raw or b"CREATE TABLE assessment.term_test_roster" not in raw
            or b"COPY " in raw or b"INSERT INTO " in raw):
        raise RuntimeError("SCHEMA_ONLY_VALIDATION_FAILED")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("xb") as output:
        output.write(raw)
    print(json.dumps({"toolOutcome": "success", "businessOutcome": "schema_only_export",
                      "database": "izone_mapping_k56_ic2264", "bytes": len(raw),
                      "sha256": hashlib.sha256(raw).hexdigest(), "path": OUTPUT.as_posix(),
                      "productionWrites": 0}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
