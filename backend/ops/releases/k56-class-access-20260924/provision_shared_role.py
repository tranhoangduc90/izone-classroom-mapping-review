"""Tạo role K56 NOLOGIN, cấp quyền tối thiểu và kiểm chặn K67 trên DB chung."""

import json
from pathlib import Path
import sys

import paramiko
import win32cred

from trial_shared_migrations import remote


GRANTS = Path(__file__).resolve().parents[2] / "migrations" / "202609240006_k56_shared_api_grants.sql"


def main():
    # Dữ liệu vào: schema K56 đã đóng, role mới chưa tồn tại, grant đã test.
    # Việc chính: tạo role không thể đăng nhập, chỉ cấp mapping/K56 rồi test deny K67.
    # Kết quả: quyền sẵn sàng cho canary, chưa có mật khẩu hoặc API nào chuyển DB.
    # Khi lỗi: dừng và báo đã tạo role hay chưa; không cấp quyền K67.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    created = False
    try:
        command = ("docker exec -i mapping-postgres sh -lc "
                   "'psql -X -q -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d mapping_db'")

        def query(sql):
            return remote(client, "docker exec -i mapping-postgres sh -lc "
                          "'psql -X -A -t -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
                          "-d mapping_db'", sql + ";\n", code="ROLE_READBACK_FAILED")

        before = json.loads(query("SELECT json_build_object("
                                  "'database', current_database(),"
                                  "'schemaExists', to_regnamespace('assessment_k56') IS NOT NULL,"
                                  "'roleExists', EXISTS (SELECT 1 FROM pg_roles "
                                  "WHERE rolname = 'k56_shared_api'))::text"))
        if before != {"database": "mapping_db", "schemaExists": True,
                      "roleExists": False}:
            raise RuntimeError("ROLE_PREFLIGHT_MISMATCH")
        remote(client, command, "BEGIN; CREATE ROLE k56_shared_api NOLOGIN; COMMIT;\n",
               code="ROLE_CREATE_FAILED")
        created = True
        remote(client, command, GRANTS.read_text(encoding="utf-8"),
               code="ROLE_GRANTS_FAILED")
        result = json.loads(query("SELECT json_build_object("
                                  "'canLogin', (SELECT rolcanlogin FROM pg_roles "
                                  "WHERE rolname = 'k56_shared_api'),"
                                  "'mappingUsage', has_schema_privilege('k56_shared_api', "
                                  "'mapping', 'USAGE'),"
                                  "'k56Usage', has_schema_privilege('k56_shared_api', "
                                  "'assessment_k56', 'USAGE'),"
                                  "'k67Usage', has_schema_privilege('k56_shared_api', "
                                  "'assessment', 'USAGE'),"
                                  "'k56RosterSelect', has_table_privilege('k56_shared_api', "
                                  "'assessment_k56.term_test_roster', 'SELECT'),"
                                  "'k67RosterSelect', has_table_privilege('k56_shared_api', "
                                  "'assessment.term_test_roster', 'SELECT'))::text"))
        expected = {"canLogin": False, "mappingUsage": True, "k56Usage": True,
                    "k67Usage": False, "k56RosterSelect": True,
                    "k67RosterSelect": False}
        if result != expected:
            raise RuntimeError("ROLE_ISOLATION_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "k56_role_no_login_isolated",
                          "readback": result, "productionRoleWrites": 2},
                         ensure_ascii=False))
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                          "roleCreated": created}), file=sys.stderr)
        raise SystemExit(2)
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
