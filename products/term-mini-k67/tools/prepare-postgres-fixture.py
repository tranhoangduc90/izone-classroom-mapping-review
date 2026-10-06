"""Dựng PostgreSQL diễn tập K67 riêng và áp DDL vào DB mới.
Chỉ ghi container/thư mục được đặt tên cố định cho fixture; không sửa DB hoặc backend hiện hành.
Lỗi giữ nguyên trạng thái đã tạo để điều tra, không xóa/reset hoặc ghi đè credential.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import secrets
import shlex
import sys
import time
import pywintypes
import win32crypt

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
REMOTE = "/opt/term-mini-k67-fixture"
CONTAINER = "term-mini-k67-postgres-fixture"
DATABASE = "term_mini_k67_test_database"
IMAGE = "postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"
spec = importlib.util.spec_from_file_location("connector", "E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py")
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)
client, password = connector.connect("vps_1")
password = None
stage = "preflight"
created = False

def command(argv, stdin=None, timeout=120):
    # Từng tham số được quote; secret chỉ đi qua stdin hoặc file riêng đã giới hạn quyền.
    incoming, out, err = client.exec_command(" ".join(shlex.quote(value) for value in argv), timeout=timeout)
    if stdin is not None:
        incoming.write(stdin)
        incoming.flush()
        incoming.channel.shutdown_write()
    raw, error = out.read(), err.read()
    code = out.channel.recv_exit_status()
    if code:
        raise RuntimeError(f"REMOTE_EXIT_{code}_STDERR_BYTES_{len(error)}")
    return raw

def protected_state():
    inspected = json.loads(command(["docker", "inspect", "mapping-review-api", "izone-k56-ic2264-api", "mapping-postgres"]))
    return [{"name": row["Name"].lstrip("/"), "image_id": row["Image"],
             "config_sha256": hashlib.sha256(json.dumps({key: row[key] for key in ("Config", "HostConfig", "Mounts")}, sort_keys=True).encode()).hexdigest(),
             "restart_count": row["RestartCount"]} for row in inspected]

def sql(source):
    return command(["docker", "exec", "-i", CONTAINER, "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "-U", "k67_owner", "-d", DATABASE], stdin=source)

try:
    names = command(["docker", "ps", "-a", "--format", "{{.Names}}"] ).decode().splitlines()
    if "--inspect" in sys.argv:
        sftp = client.open_sftp()
        try:
            directories = {}
            for directory in [REMOTE, REMOTE + "/data", REMOTE + "/secrets"]:
                try:
                    directories[directory] = sftp.listdir(directory)
                except FileNotFoundError:
                    directories[directory] = None
            print(json.dumps({"outcome": "success", "remote_read_only": True,
                              "container_exists": CONTAINER in names, "directories": directories}))
        finally:
            sftp.close()
        sys.exit(0)
    if CONTAINER in names:
        raise RuntimeError("FIXTURE_EXISTS_INSPECT_BEFORE_RESUME")
    before = protected_state()
    sftp = client.open_sftp()
    try:
        try:
            sftp.stat(REMOTE)
        except FileNotFoundError:
            sftp.mkdir(REMOTE, mode=0o700)
            sftp.mkdir(REMOTE + "/data", mode=0o700)
            sftp.mkdir(REMOTE + "/secrets", mode=0o700)
        else:
            if "--resume-empty" not in sys.argv:
                raise RuntimeError("FIXTURE_DIRECTORY_EXISTS_INSPECT_BEFORE_RESUME")
            if sorted(sftp.listdir(REMOTE)) != ["data", "secrets"] or sftp.listdir(REMOTE + "/data") or sftp.listdir(REMOTE + "/secrets"):
                raise RuntimeError("FIXTURE_NOT_EMPTY_REFUSE_RESUME")
        stage = "prepare_fixture_credentials"
        # Kho mã hóa DPAPI riêng trên E; chỉ tài khoản Windows này giải được.
        # Không đổi/xóa các credential đã tồn tại và không lưu plaintext vào file local.
        vault = Path("E:/Codex-Data/k67-backend-separation-20261006/fixture-credentials.dpapi")
        if vault.exists():
            _, plaintext = win32crypt.CryptUnprotectData(vault.read_bytes(), None, None, None, 0)
            passwords = json.loads(plaintext.decode("utf-8"))
        else:
            passwords = {}
            for role in ["k67_owner", "k67_app", "k67_context_sync"]:
                try:
                    _, value = connector.credential_password("Codex/K67/fixture/" + role)
                except pywintypes.error as error:
                    if error.args[0] != 1168:
                        raise
                    value = secrets.token_urlsafe(48)
                passwords[role] = value
            ciphertext = win32crypt.CryptProtectData(json.dumps(passwords).encode("utf-8"), "K67 fixture", None, None, None, 0)
            with vault.open("xb") as stream:
                stream.write(ciphertext)
            _, checked = win32crypt.CryptUnprotectData(vault.read_bytes(), None, None, None, 0)
            if json.loads(checked.decode("utf-8")) != passwords:
                raise RuntimeError("ENCRYPTED_VAULT_READBACK_FAILED")
        secret_file = REMOTE + "/secrets/owner-password"
        with sftp.file(secret_file, "wx") as stream:
            stream.write(passwords["k67_owner"] + "\n")
        sftp.chmod(secret_file, 0o400)
        # Kiểm lại quyền thật; không giữ hoặc in giá trị secret vào evidence.
        if sftp.stat(secret_file).st_mode & 0o777 != 0o400:
            raise RuntimeError("SECRET_FILE_MODE_MISMATCH")
    finally:
        sftp.close()
    stage = "create_fixture_container"
    command(["docker", "run", "--detach", "--name", CONTAINER,
             "--label", "com.izone.product=PRODUCT-TERM-MINI-K67",
             "--label", "com.izone.purpose=synthetic-fixture-20261006",
             "--cpus", "0.5", "--memory", "256m", "--pids-limit", "100",
             "--publish", "127.0.0.1:55467:5432",
             "--mount", "type=bind,src=" + REMOTE + "/data,dst=/var/lib/postgresql/data",
             "--mount", "type=bind,src=" + secret_file + ",dst=/run/secrets/owner-password,readonly",
             "--env", "POSTGRES_USER=k67_owner", "--env", "POSTGRES_DB=" + DATABASE,
             "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/owner-password", IMAGE])
    created = True
    stage = "wait_for_fixture"
    deadline = time.monotonic() + 60
    while True:
        try:
            command(["docker", "exec", CONTAINER, "pg_isready", "-U", "k67_owner", "-d", DATABASE], timeout=5)
            command(["docker", "exec", CONTAINER, "psql", "--no-psqlrc", "-U", "k67_owner", "-d", DATABASE, "-c", "SELECT 1"], timeout=5)
            break
        except RuntimeError:
            if time.monotonic() > deadline:
                raise RuntimeError("FIXTURE_START_TIMEOUT")
            time.sleep(1)
    stage = "apply_new_fixture_schema"
    # Credential sinh từ token_urlsafe, không chứa dấu nháy; chỉ truyền SQL riêng qua stdin.
    for value in passwords.values():
        if not all(character.isalnum() or character in "-_" for character in value):
            raise RuntimeError("PASSWORD_FORMAT_INVALID")
    parts = ["BEGIN;", "SET LOCAL lock_timeout='5s';"]
    parts += ["CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + passwords[role] + "';" for role in ["k67_app", "k67_context_sync"]]
    for name in ["001-context.sql", "002-history.sql", "003-assessment.sql", "004-grants.sql"]:
        parts.append((ROOT / "db" / name).read_text(encoding="utf-8"))
    parts += ["CREATE TABLE mapping.k67_fixture_identity (product_id text PRIMARY KEY, fixture_id text NOT NULL);",
              "GRANT SELECT ON mapping.k67_fixture_identity TO k67_app, k67_context_sync;",
              "INSERT INTO mapping.k67_fixture_identity VALUES ('PRODUCT-TERM-MINI-K67','synthetic-fixture-20261006');",
              "SELECT collaboration.attach_table(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mapping' AND c.relkind='r';", "COMMIT;"]
    sql("\n".join(parts))
    stage = "readback"
    result = json.loads(command(["docker", "exec", CONTAINER, "psql", "--no-psqlrc", "--tuples-only", "--no-align", "-U", "k67_owner", "-d", DATABASE, "-c",
        "SELECT json_build_object('database',current_database(),'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='assessment' AND table_type='BASE TABLE'),'history_triggers',(SELECT count(*) FROM pg_trigger WHERE tgname IN ('collaboration_row_history','collaboration_truncate_history') AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='assessment'::regnamespace)));"]).decode("utf-8"))
    if result != {"database": DATABASE, "tables": 13, "history_triggers": 26}:
        raise RuntimeError("FIXTURE_SCHEMA_READBACK_MISMATCH")
    after = protected_state()
    if before != after:
        raise RuntimeError("PROTECTED_RUNTIME_CHANGED")
    evidence = {"outcome": "success", "purpose": "isolated_synthetic_fixture", "container": CONTAINER, "database": DATABASE, "pinned_image": IMAGE, "created": created, "protected_runtime_before": before, "protected_runtime_after": after, "schema_readback": result, "production_cutover": False}
    (ROOT / ".codex/product-evidence/postgres-fixture.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in evidence.items() if key not in ("protected_runtime_before", "protected_runtime_after")}, ensure_ascii=False))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    if isinstance(exc, pywintypes.error):
        code = "WIN32_" + str(exc.args[0])
    elif isinstance(exc, AttributeError):
        code = "ATTRIBUTE_" + str(exc.name)
    print(json.dumps({"outcome": "failure", "stage": stage, "created": created, "code": code, "production_cutover": False}))
    sys.exit(1)
finally:
    client.close()
