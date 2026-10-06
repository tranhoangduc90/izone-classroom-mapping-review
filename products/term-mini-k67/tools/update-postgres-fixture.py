"""Bổ sung đúng delta ngữ cảnh cho DB fixture đã có marker K67.
Không sửa DB nguồn/K56; đọc lại cột và quyền sau transaction, không in credential.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import shlex
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("connector", "E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py")
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)
client, password = connector.connect("vps_1")
password = None

def execute(command, data=None):
    incoming, out, err = client.exec_command(command, timeout=60)
    if data is not None:
        incoming.write(data)
        incoming.flush()
        incoming.channel.shutdown_write()
    raw, error = out.read(), err.read()
    code = out.channel.recv_exit_status()
    if code:
        raise RuntimeError("FIXTURE_SQL_EXIT_" + str(code) + "_STDERR_BYTES_" + str(len(error)))
    return raw

def query(sql):
    return execute("docker exec term-mini-k67-postgres-fixture psql -X -qAt -v ON_ERROR_STOP=1 -U k67_owner -d term_mini_k67_test_database -c " + shlex.quote(sql)).decode("utf-8").strip()

def protected():
    result = {}
    for name in ["mapping-review-api", "izone-k56-ic2264-api"]:
        item = json.loads(execute("docker inspect " + shlex.quote(name)))[0]
        result[name] = hashlib.sha256(json.dumps({"image": item["Image"], "config": item["Config"], "host": item["HostConfig"], "restart_count": item["RestartCount"]}, sort_keys=True).encode()).hexdigest()
    return result

try:
    if query("SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity") != "PRODUCT-TERM-MINI-K67:synthetic-fixture-20261006":
        raise RuntimeError("FIXTURE_MARKER_MISMATCH")
    before = protected()
    if query("SELECT count(*) FROM pg_namespace WHERE nspname='k67_context_api_v1'") != "0":
        raise RuntimeError("FIXTURE_SOURCE_SCHEMA_ALREADY_EXISTS")
    if query("SELECT count(*) FROM pg_roles WHERE rolname='k67_context_reader'") != "0":
        raise RuntimeError("FIXTURE_SOURCE_ROLE_ALREADY_EXISTS")
    # Cùng view/grant nguồn, chỉ đổi đích CONNECT sang DB fixture; không chạy trên mapping_db.
    source = (ROOT / "db/006-context-source.sql").read_text(encoding="utf-8")
    source = source.replace("GRANT CONNECT ON DATABASE mapping_db TO", "GRANT CONNECT ON DATABASE term_mini_k67_test_database TO")
    sql = "BEGIN;\nCREATE ROLE k67_context_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
    sql += (ROOT / "db/005-context-auth.sql").read_text(encoding="utf-8") + "\n" + source + "\nCOMMIT;\n"
    execute("docker exec -i term-mini-k67-postgres-fixture psql -X -q -v ON_ERROR_STOP=1 -U k67_owner -d term_mini_k67_test_database", sql)
    checks = json.loads(query("""SELECT json_build_object(
      'logout_column',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='mapping' AND table_name='reviewer_session' AND column_name='revoked_reason'),
      'revoke_allowed',has_column_privilege('k67_context_sync','mapping.reviewer_session','revoked_at','UPDATE'),
      'token_read_denied',NOT has_column_privilege('k67_context_sync','mapping.reviewer_session','token_hash','SELECT'),
      'session_insert_denied',NOT has_table_privilege('k67_context_sync','mapping.reviewer_session','INSERT'))"""))
    after = protected()
    if not all(checks.values()) or before != after:
        raise RuntimeError("FIXTURE_READBACK_MISMATCH")
    receipt = {"outcome": "success", "checks": checks, "protected_before": before, "protected_after": after}
    (ROOT / ".codex/product-evidence/context-fixture-update.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))
except Exception as exc:
    print(json.dumps({"outcome": "failure", "code": str(exc) if str(exc).startswith("FIXTURE_") else "FIXTURE_UPDATE_FAILED"}))
    sys.exit(1)
finally:
    client.close()
