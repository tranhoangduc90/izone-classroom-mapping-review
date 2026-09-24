"""Chỉ đọc nền tảng triển khai B3, không in credential hoặc dữ liệu học viên."""

import json
from pathlib import Path
import sys

import paramiko
import win32cred


CONTAINER = "izone-k56-ic2264-api"
DB_CONTAINER = "izone-k56-demo-k56-demo-db-1"
COMMANDS = {
    "container": "docker inspect --format '{{.Name}}|{{.Image}}|{{.Config.Image}}|"
                 "{{.State.Health.Status}}|{{.RestartCount}}|"
                 "{{index .Config.Labels \"com.docker.compose.project\"}}|"
                 "{{index .Config.Labels \"com.docker.compose.service\"}}|"
                 "{{index .Config.Labels \"com.docker.compose.project.config_files\"}}|"
                 "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}' "
                 + CONTAINER,
    "services": "docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}'",
    "disk": "df -Pk /opt",
    "backupProbe": f"docker exec {DB_CONTAINER} sh -lc 'pg_dump -U \"$POSTGRES_USER\" "
                   "-d izone_mapping_k56_ic2264 --schema-only --no-owner "
                   "--no-privileges --file=/dev/null && echo BACKUP_READ_OK'",
}

DATABASE_SCRIPT = r"""
// Dữ liệu vào: kết nối database đang dùng bởi API K56.
// Việc chính: chỉ đọc role/quyền/schema, không xem hồ sơ học viên.
// Kết quả: metadata để chọn đúng đường backup và migration.
// Khi lỗi: exit khác 0 để dừng preflight.
import pg from 'pg';
const db = new pg.Pool({connectionString: process.env.DATABASE_URL,
  max: 1, connectionTimeoutMillis: 10000});
try {
  const endpoint = new URL(process.env.DATABASE_URL);
  const row = (await db.query(`SELECT current_database() AS database,
    current_user AS role,
    pg_database_size(current_database())::bigint AS database_bytes,
    has_table_privilege(current_user, 'assessment.term_test_roster', 'SELECT')
      AS roster_select,
    has_table_privilege(current_user, 'assessment.term_test_roster', 'UPDATE')
      AS roster_update,
    to_regclass('assessment.term_test_class_access') IS NOT NULL
      AS access_exists,
    to_regclass('assessment.k56_roster_sync_checkpoint') IS NOT NULL
      AS checkpoint_exists`)).rows[0];
  process.stdout.write(JSON.stringify({...row, endpoint: {
    host: endpoint.hostname, port: endpoint.port,
    database: endpoint.pathname.slice(1), user: endpoint.username}}));
} finally { await db.end(); }
"""


def read_command(client, command, stdin_data=None, label="READ"):
    """Chỉ trả output của lệnh đã kiểm exit; không phát tán stderr thô."""
    stdin, stdout, stderr = client.exec_command(command, timeout=35)
    if stdin_data is not None:
        stdin.write(stdin_data)
    stdin.channel.shutdown_write()
    body = stdout.read().decode("utf-8")
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(f"B3_PREFLIGHT_{label.upper()}_FAILED")
    return body.strip()


def main():
    # Dữ liệu vào: SSH credential trong Windows Credential Manager.
    # Việc chính: đọc Docker, dung lượng và role database; không ghi VPS.
    # Kết quả: trường cần cho runbook phát hành và hoàn tác.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0] or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        if "--validate-shell" in sys.argv:
            source = (Path(__file__).parent / "backup_b3.sh").read_text(encoding="utf-8")
            read_command(client, "bash -n", source, label="shellsyntax")
            print(json.dumps({"toolOutcome": "success",
                              "businessOutcome": "shell_syntax_valid",
                              "productionWrites": 0}))
            return
        if "--diagnose-endpoint" in sys.argv:
            db = json.loads(read_command(
                client, f"docker exec -i {CONTAINER} node --input-type=module -",
                DATABASE_SCRIPT, label="database"))
            print(json.dumps({"toolOutcome": "success",
                              "businessOutcome": "read_only_database_endpoint",
                              "database": db, "productionWrites": 0}))
            return
        if "--diagnose-backup" in sys.argv:
            checks = {
                "dumpTool": "docker exec mapping-postgres pg_dump --version",
                "configuredRole": "docker exec mapping-postgres sh -lc "
                                  "'printf \"%s\" \"${POSTGRES_USER:-unset}\"'",
                "postgresSocket": "docker exec mapping-postgres psql -U postgres "
                                  "-d postgres -Atc 'SELECT current_user'",
                "adminSocket": "docker exec mapping-postgres psql -U mapping_admin "
                               "-d postgres -Atc 'SELECT current_user'",
                "targetDatabase": "docker exec mapping-postgres psql -U postgres "
                                  "-d postgres -Atc \"SELECT count(*) FROM pg_database "
                                  "WHERE datname = 'izone_mapping_k56_ic2264'\"",
                "targetViaAdmin": "docker exec mapping-postgres psql -U mapping_admin "
                                  "-d postgres -Atc \"SELECT count(*) FROM pg_database "
                                  "WHERE datname = 'izone_mapping_k56_ic2264'\"",
                "k56ConfiguredRole": f"docker exec {DB_CONTAINER} sh -lc "
                                     "'printf \"%s\" \"${POSTGRES_USER:-unset}\"'",
                "k56TargetExists": f"docker exec {DB_CONTAINER} sh -lc "
                                   "'psql -U \"$POSTGRES_USER\" -d postgres "
                                   "-Atc \"SELECT count(*) FROM pg_database WHERE "
                                   "datname = '\''izone_mapping_k56_ic2264'\''\"'",
            }
            results = {}
            for key, command in checks.items():
                try:
                    results[key] = {"status": "passed",
                                    "value": read_command(client, command, label=key)}
                except RuntimeError:
                    results[key] = {"status": "failed"}
            print(json.dumps({"toolOutcome": "success",
                              "businessOutcome": "read_only_backup_diagnostic",
                              "checks": results, "productionWrites": 0}))
            return
        observations = {key: read_command(client, command, label=key)
                        for key, command in COMMANDS.items()}
        db = json.loads(read_command(
            client, f"docker exec -i {CONTAINER} node --input-type=module -",
            DATABASE_SCRIPT, label="database"))
    finally:
        client.close()
    parts = observations["container"].split("|")
    if len(parts) != 9 or db.get("database") != "izone_mapping_k56_ic2264":
        raise RuntimeError("B3_PREFLIGHT_UNEXPECTED_TARGET")
    services = [line for line in observations["services"].splitlines()
                if any(term in line.lower() for term in ("k56", "postgres", "mapping"))]
    disk_lines = observations["disk"].splitlines()
    if len(disk_lines) != 2 or observations["backupProbe"] != "BACKUP_READ_OK":
        raise RuntimeError("B3_PREFLIGHT_DISK_UNREADABLE")
    print(json.dumps({"toolOutcome": "success", "businessOutcome": "read_only_b3_preflight",
                      "container": parts[0], "imageId": parts[1],
                      "imageTag": parts[2], "health": parts[3],
                      "restartCount": int(parts[4]), "composeProject": parts[5],
                      "composeService": parts[6], "composeConfigFiles": parts[7],
                      "composeWorkingDirectory": parts[8], "services": services,
                      "disk": disk_lines[1], "database": db,
                      "backupReadReady": True,
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
