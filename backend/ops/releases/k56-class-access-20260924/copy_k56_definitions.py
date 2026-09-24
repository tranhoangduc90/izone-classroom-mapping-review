"""Chuyển ba định nghĩa đề K56 qua RAM, không lưu JSON đề vào Git hay stdout."""

import json
import re
import sys

import paramiko
import win32cred

from trial_shared_migrations import remote


SLUGS = {"term-test-1-k56", "term-test-2-k56", "mini-test-k56"}


def main():
    # Dữ liệu vào: ba định nghĩa đề còn trong database K56 cũ.
    # Việc chính: đối chiếu slug/hash, chuyển bằng pg_dump qua RAM, rồi đọc lại.
    # Kết quả: đúng ba đề trong assessment_k56; K67 không bị thay đổi.
    # Khi lỗi: giao dịch import rollback; không in JSON đề hoặc dữ liệu học viên.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    inserted = False
    try:
        def query(container, database, sql):
            return remote(client, f"docker exec -i {container} sh -lc "
                          f"'psql -X -U \"$POSTGRES_USER\" -d {database} -At'",
                          sql + ";\n", code="DEFINITION_READ_FAILED")

        source = json.loads(query("izone-k56-demo-k56-demo-db-1",
                                  "izone_mapping_k56_ic2264",
                                  "SELECT json_agg(json_build_object('slug', slug, "
                                  "'active', is_active, 'hash', md5(to_jsonb(t)::text)) "
                                  "ORDER BY slug)::text FROM assessment.test_definition AS t "
                                  "WHERE slug IN ('term-test-1-k56', 'term-test-2-k56', "
                                  "'mini-test-k56')"))
        if len(source) != 3 or {row["slug"] for row in source} != SLUGS \
                or not all(row["active"] for row in source):
            raise RuntimeError("SOURCE_DEFINITIONS_INVALID")
        before = json.loads(query("mapping-postgres", "mapping_db",
                                  "SELECT json_build_object("
                                  "'k56', (SELECT count(*) FROM assessment_k56.test_definition),"
                                  "'k67', (SELECT count(*) FROM assessment.test_definition))::text"))
        if before != {"k56": 0, "k67": 3}:
            raise RuntimeError("TARGET_DEFINITIONS_NOT_EMPTY")
        dump = remote(client, "docker exec izone-k56-demo-k56-demo-db-1 sh -lc "
                      "'pg_dump -U \"$POSTGRES_USER\" -d izone_mapping_k56_ic2264 "
                      "--data-only --inserts --column-inserts --no-owner --no-acl "
                      "-t assessment.test_definition'",
                      code="SOURCE_DEFINITION_DUMP_FAILED")
        inserts = [line for line in dump.splitlines()
                   if line.startswith("INSERT INTO assessment.test_definition ")]
        if len(inserts) != 3 or not all(re.fullmatch(
                r"INSERT INTO assessment\.test_definition \(.+\) VALUES \(.+\);",
                line) for line in inserts):
            raise RuntimeError("DEFINITION_DUMP_CONTRACT_CHANGED")
        sql = "BEGIN;\nSET LOCAL statement_timeout = '30s';\n"
        sql += "\n".join(line.replace("INSERT INTO assessment.test_definition ",
                                       "INSERT INTO assessment_k56.test_definition ", 1)
                         for line in inserts)
        sql += "\nCOMMIT;\n"
        remote(client, "docker exec -i mapping-postgres sh -lc "
               "'psql -X -q -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d mapping_db'",
               sql, code="DEFINITION_IMPORT_FAILED")
        inserted = True
        target = json.loads(query("mapping-postgres", "mapping_db",
                                  "SELECT json_agg(json_build_object('slug', slug, "
                                  "'active', is_active, 'hash', md5(to_jsonb(t)::text)) "
                                  "ORDER BY slug)::text FROM assessment_k56.test_definition AS t"))
        after_k67 = int(query("mapping-postgres", "mapping_db",
                              "SELECT count(*) FROM assessment.test_definition"))
        if target != source or after_k67 != 3:
            raise RuntimeError("DEFINITION_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "k56_definitions_copied_verified",
                          "definitions": len(target), "allHashesMatch": True,
                          "k67Definitions": after_k67,
                          "productionDatabaseWrites": 3}, ensure_ascii=False))
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                          "insertAttempted": inserted}), file=sys.stderr)
        raise SystemExit(2)
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
