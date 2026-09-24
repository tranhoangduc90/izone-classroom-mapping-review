"""Thử migration K56 trên bản phục hồi tạm của mapping_db, không sửa DB chính."""

import json
from pathlib import Path
import re
import secrets
import sys

import paramiko
import win32cred


BACKUP_DIR = "/opt/backups/k56-shared-cutover-e4KMSNeA"
ARCHIVE = f"{BACKUP_DIR}/mapping_db-before-k56.dump"
ARCHIVE_SHA256 = "b098540963f07fc39057bbd20d0f27095ff719c1b80135926d955280f4178281"
MIGRATIONS = (
    "202609240003_k56_assessment_schema.sql",
    "202609240004_k56_roster_eligibility.sql",
    "202609240005_k56_class_access.sql",
)
MIGRATION_ROOT = Path(__file__).resolve().parents[2] / "migrations"


def remote(client, command, input_text=None, code="REMOTE_COMMAND_FAILED"):
    # Dữ liệu vào: lệnh cố định và, khi cần, nội dung migration từ Git.
    # Việc chính: kiểm exit của lệnh SSH, không in stderr có thể chứa dữ liệu riêng.
    # Kết quả: stdout chỉ dùng cho metadata đã định nghĩa.
    # Khi lỗi: dừng; cleanup DB tạm luôn chạy ở finally.
    stdin, stdout, stderr = client.exec_command(command, timeout=300)
    if input_text is not None:
        stdin.write(input_text)
    stdin.channel.shutdown_write()
    result = stdout.read().decode("utf-8").strip()
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(code)
    return result


def main():
    # Dữ liệu vào: archive đã restore drill và ba migration chỉ-schema.
    # Việc chính: tạo database tạm, phục hồi rồi chạy migration/đọc lại.
    # Kết quả: xác nhận K67 bất biến trong bản sao; DB tạm được xóa.
    # Khi lỗi: không áp migration lên mapping_db và báo mã an toàn.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    temporary_db = "k56_schema_trial_" + secrets.token_hex(6)
    if not re.fullmatch(r"k56_schema_trial_[0-9a-f]{12}", temporary_db):
        raise RuntimeError("UNSAFE_TEMP_DATABASE_NAME")
    created = False
    try:
        observed_hash = remote(client, f"sha256sum {ARCHIVE}", code="BACKUP_HASH_READ_FAILED")
        if observed_hash.split(" ", 1)[0] != ARCHIVE_SHA256:
            raise RuntimeError("BACKUP_HASH_CHANGED")
        role = remote(client, "docker exec mapping-postgres sh -lc 'printf %s \"$POSTGRES_USER\"'",
                      code="DB_ROLE_READ_FAILED")
        if role != "mapping_admin":
            raise RuntimeError("UNEXPECTED_DB_ROLE")
        remote(client, f"docker exec -e CHECK_DB={temporary_db} mapping-postgres "
               "sh -lc 'createdb -U \"$POSTGRES_USER\" \"$CHECK_DB\"'",
               code="TEMP_DB_CREATE_FAILED")
        created = True
        remote(client, f"docker exec -i -e CHECK_DB={temporary_db} mapping-postgres "
               "sh -lc 'pg_restore -U \"$POSTGRES_USER\" -d \"$CHECK_DB\" "
               "--no-owner --no-acl --exit-on-error' < " + ARCHIVE,
               code="TEMP_DB_RESTORE_FAILED")
        probe = ("SELECT json_build_object("
                 "'k67Definitions', (SELECT count(*) FROM assessment.test_definition),"
                 "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster),"
                 "'k67Jobs', (SELECT count(*) FROM assessment.term_test_writing_grading_job))::text")
        query = lambda sql: remote(
            client, f"docker exec -i -e CHECK_DB={temporary_db} mapping-postgres "
            "sh -lc 'psql -X -U \"$POSTGRES_USER\" -d \"$CHECK_DB\" -At'",
            sql + ";\n", code="TRIAL_READBACK_FAILED")
        before = json.loads(query(probe))
        if before["k67Definitions"] != 3:
            raise RuntimeError("UNEXPECTED_K67_BASELINE")
        for filename in MIGRATIONS:
            sql = (MIGRATION_ROOT / filename).read_text(encoding="utf-8")
            remote(client, f"docker exec -i -e CHECK_DB={temporary_db} mapping-postgres "
                   "sh -lc 'psql -X -q -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
                   "-d \"$CHECK_DB\"'", sql,
                   code=f"TRIAL_MIGRATION_FAILED_{filename}")
        after = json.loads(query(probe))
        if after != before:
            raise RuntimeError("K67_CHANGED_IN_TRIAL")
        k56 = json.loads(query("SELECT json_build_object("
                               "'tables', (SELECT count(*) FROM information_schema.tables "
                               "WHERE table_schema = 'assessment_k56' AND table_type = 'BASE TABLE'),"
                               "'views', (SELECT count(*) FROM information_schema.views "
                               "WHERE table_schema = 'assessment_k56'),"
                               "'resetFunction', to_regprocedure("
                               "'assessment_k56.reset_demo_term_test_student(text,text,uuid)') IS NOT NULL,"
                               "'roster', (SELECT count(*) FROM assessment_k56.term_test_roster),"
                               "'access', (SELECT count(*) FROM assessment_k56.term_test_class_access))::text"))
        if k56 != {"tables": 15, "views": 1, "resetFunction": True,
                   "roster": 0, "access": 0}:
            raise RuntimeError("K56_TRIAL_SCHEMA_INCOMPLETE")
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "postgresql_migrations_trial_verified",
                          "k67": after, "k56": k56,
                          "productionDatabaseWrites": 0}, ensure_ascii=False))
    finally:
        if created:
            remote(client, f"docker exec -e CHECK_DB={temporary_db} mapping-postgres "
                   "sh -lc 'dropdb -U \"$POSTGRES_USER\" \"$CHECK_DB\"'",
                   code="TEMP_DB_CLEANUP_FAILED")
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
