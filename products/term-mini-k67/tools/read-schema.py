"""Đọc DDL và tài nguyên VPS; không ghi VPS hoặc lấy bài làm.
Lưu snapshot local cho thiết kế; terminal chỉ trả metadata và hash.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import shlex
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path("E:/Codex-Data/k67-backend-separation-20261006")
spec = importlib.util.spec_from_file_location("connector", "E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py")
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)
client, password = connector.connect("vps_1")
password = None

def read(command, timeout=90):
    _, out, err = client.exec_command(command, timeout=timeout)
    data, error = out.read(), err.read()
    code = out.channel.recv_exit_status()
    if code:
        raise RuntimeError(f"REMOTE_READ_EXIT_{code}_STDERR_BYTES_{len(error)}")
    return data

try:
    info = json.loads(read("docker inspect mapping-postgres"))[0]
    env = dict(value.split("=", 1) for value in info["Config"]["Env"] if "=" in value)
    user = env.get("POSTGRES_USER", "postgres")
    database = env.get("POSTGRES_DB", "mapping_db")
    image = json.loads(read("docker image inspect " + shlex.quote(info["Image"])))[0]
    def query(sql):
        command = "docker exec mapping-postgres psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align -U " + shlex.quote(user) + " -d " + shlex.quote(database) + " -c " + shlex.quote("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; " + sql + "; ROLLBACK;")
        raw = read(command).decode("utf-8")
        return json.loads("\n".join(line for line in raw.splitlines() if line.strip() not in ("BEGIN", "SET", "ROLLBACK", "")))
    table_args = " ".join("--table " + shlex.quote(table) for table in ["assessment.term_test_*", "assessment.test_definition", "assessment.mini_test_*"])
    dump = read("docker exec mapping-postgres pg_dump --schema-only --no-owner --no-acl --no-security-labels -U " + shlex.quote(user) + " -d " + shlex.quote(database) + " " + table_args)
    (ROOT / "k67-assessment-schema.sql").write_bytes(dump)
    history_dump = read("docker exec mapping-postgres pg_dump --schema-only --no-owner --no-acl --no-security-labels -U " + shlex.quote(user) + " -d " + shlex.quote(database) + " --schema collaboration")
    (ROOT / "k67-history-schema.sql").write_bytes(history_dump)
    routines = query("SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='assessment' AND p.prokind='f' ORDER BY p.proname) x")
    history_functions = query("SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='collaboration' AND p.prokind='f' ORDER BY p.proname) x")
    mapping = query("SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT table_name,column_name,data_type,udt_name,column_default,is_nullable FROM information_schema.columns WHERE table_schema='mapping' AND table_name IN ('classroom_course_mapping','student_mapping_review','erp_class_membership_snapshot','reviewer_account','reviewer_class_access','reviewer_session') ORDER BY table_name,ordinal_position) x")
    capacity = read("cat /proc/meminfo | head -n 3; df -Pk /opt; getconf _NPROCESSORS_ONLN").decode("utf-8")
    names = read("docker ps -a --format '{{.Names}}'").decode("utf-8").splitlines()
    evidence = {"outcome": "success", "remote_read_only": True, "schema_sha256": hashlib.sha256(dump).hexdigest(), "routines": routines, "history_functions": history_functions, "mapping_columns": mapping, "postgres_image_id": info["Image"], "postgres_repo_digests": image.get("RepoDigests", []), "capacity": capacity, "existing_k67_containers": [name for name in names if "k67" in name.lower() or "term-mini" in name.lower()]}
    (ROOT / "SCHEMA_CONTEXT_INVENTORY.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in evidence.items() if key not in ("routines", "history_functions", "mapping_columns")}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"outcome": "failure", "error": type(exc).__name__, "code": str(exc) if str(exc).startswith("REMOTE_READ_EXIT_") else "READ_FAILED"}))
    sys.exit(1)
finally:
    client.close()
