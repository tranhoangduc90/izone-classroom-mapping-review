"""Áp cấu trúc K56 bổ sung vào mapping_db, không chuyển API hoặc mở lớp."""

import json
from pathlib import Path
import re
import sys

import paramiko
import win32cred

from trial_shared_migrations import ARCHIVE, ARCHIVE_SHA256, MIGRATIONS, MIGRATION_ROOT, remote


def main():
    # Dữ liệu vào: archive đã restore drill, ba migration đã thử trên bản sao.
    # Việc chính: kiểm đúng DB/health/schema rỗng, áp từng migration rồi đọc lại.
    # Kết quả: cấu trúc K56 đóng mặc định; K67 và API đang chạy không đổi.
    # Khi lỗi: dừng, báo bước đã áp; không tự drop schema hoặc retry mù.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    completed = []
    try:
        observed = remote(client, f"sha256sum {ARCHIVE}", code="BACKUP_READ_FAILED")
        if observed.split(" ", 1)[0] != ARCHIVE_SHA256:
            raise RuntimeError("BACKUP_HASH_CHANGED")
        role = remote(client, "docker exec mapping-postgres sh -lc 'printf %s \"$POSTGRES_USER\"'",
                      code="DB_ROLE_READ_FAILED")
        if role != "mapping_admin":
            raise RuntimeError("UNEXPECTED_DB_ROLE")
        for api in ("mapping-review-api", "izone-k56-ic2264-api"):
            health = remote(client, f"docker inspect {api} --format '{{{{.State.Health.Status}}}}'",
                            code="API_HEALTH_READ_FAILED")
            if health != "healthy":
                raise RuntimeError("API_UNHEALTHY_BEFORE_SCHEMA")

        def query(sql):
            return remote(client, "docker exec -i mapping-postgres sh -lc "
                          "'psql -X -U \"$POSTGRES_USER\" -d mapping_db -At'",
                          sql + ";\n", code="SCHEMA_READBACK_FAILED")

        baseline = json.loads(query("SELECT json_build_object("
                                    "'database', current_database(),"
                                    "'k56Exists', to_regnamespace('assessment_k56') IS NOT NULL,"
                                    "'k67Definitions', (SELECT count(*) FROM assessment.test_definition),"
                                    "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster))::text"))
        if baseline != {"database": "mapping_db", "k56Exists": False,
                        "k67Definitions": 3, "k67Roster": 46}:
            raise RuntimeError("UNEXPECTED_SCHEMA_BASELINE")
        for filename in MIGRATIONS:
            sql = (MIGRATION_ROOT / filename).read_text(encoding="utf-8")
            if re.search(r"\bassessment\.", sql):
                raise RuntimeError("MIGRATION_TOUCHES_K67_SCHEMA")
            remote(client, "docker exec -i mapping-postgres sh -lc "
                   "'psql -X -q -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d mapping_db'",
                   sql, code=f"SCHEMA_MIGRATION_FAILED_{filename}")
            completed.append(filename)
        after = json.loads(query("SELECT json_build_object("
                                 "'database', current_database(),"
                                 "'tables', (SELECT count(*) FROM information_schema.tables "
                                 "WHERE table_schema = 'assessment_k56' AND table_type = 'BASE TABLE'),"
                                 "'views', (SELECT count(*) FROM information_schema.views "
                                 "WHERE table_schema = 'assessment_k56'),"
                                 "'roster', (SELECT count(*) FROM assessment_k56.term_test_roster),"
                                 "'access', (SELECT count(*) FROM assessment_k56.term_test_class_access),"
                                 "'k67Definitions', (SELECT count(*) FROM assessment.test_definition),"
                                 "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster))::text"))
        expected = {"database": "mapping_db", "tables": 15, "views": 1,
                    "roster": 0, "access": 0, "k67Definitions": 3, "k67Roster": 46}
        if after != expected:
            raise RuntimeError("SCHEMA_PRODUCTION_READBACK_MISMATCH")
        for api in ("mapping-review-api", "izone-k56-ic2264-api"):
            health = remote(client, f"docker inspect {api} --format '{{{{.State.Health.Status}}}}'",
                            code="API_HEALTH_READ_FAILED")
            if health != "healthy":
                raise RuntimeError("API_UNHEALTHY_AFTER_SCHEMA")
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "k56_schema_installed_closed",
                          "completedMigrations": completed,
                          "readback": after, "apiHealth": "both_healthy",
                          "productionDatabaseWrites": len(completed)}, ensure_ascii=False))
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                          "completedMigrations": completed}), file=sys.stderr)
        raise SystemExit(2)
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
