"""Cấp ba quyền bảng K56 hẹp sau backup và phép thử rollback."""

import argparse
import json
from pathlib import Path
import sys

import paramiko
import win32cred


MIGRATION = (Path(__file__).parents[2] / "migrations" /
             "202609240007_k56_roster_reconcile_grants.sql")
BACKUP = "/opt/backups/k56-shared-cutover-ZsFjJl7l/mapping_db-before-k56.dump"
BACKUP_SHA = "d1b9acd30d543d6bf251576d9349d5737514ef5f302e1e8cdd6bfa32913ebe3d"
CURRENT_IMAGE = "sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7"

STATE_SQL = """
SELECT json_build_object(
  'database', current_database(),
  'roster', (SELECT count(*) FROM assessment_k56.term_test_roster),
  'access', (SELECT count(*) FROM assessment_k56.term_test_class_access),
  'attempts', (SELECT count(*) FROM assessment_k56.term_test_attempt),
  'k67Roster', (SELECT count(*) FROM assessment.term_test_roster),
  'rosterWrite', has_table_privilege('k56_shared_api',
    'assessment_k56.term_test_roster', 'INSERT,UPDATE'),
  'accessWrite', has_table_privilege('k56_shared_api',
    'assessment_k56.term_test_class_access', 'INSERT,UPDATE'),
  'checkpointWrite', has_table_privilege('k56_shared_api',
    'assessment_k56.k56_roster_sync_checkpoint', 'INSERT,UPDATE'),
  'k67Usage', has_schema_privilege('k56_shared_api', 'assessment', 'USAGE')
)::text;
"""


def command(client, value, code, input_text=None):
    # Dữ liệu vào: lệnh Docker/SQL cố định, không kèm credential trên dòng lệnh.
    # Việc chính: giữ exit code và bỏ stderr để không lộ môi trường.
    # Kết quả: chuỗi metadata; khi lỗi trả mã an toàn.
    stdin, stdout, stderr = client.exec_command(value, timeout=45)
    if input_text is not None:
        stdin.write(input_text)
    stdin.channel.shutdown_write()
    body = stdout.read().decode("utf-8").strip()
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(code)
    return body


def state(client):
    body = command(client, "docker exec -i mapping-postgres sh -lc "
                   "'psql -X -q -A -t -v ON_ERROR_STOP=1 "
                   "-U \"$POSTGRES_USER\" -d mapping_db'",
                   "K56_GRANT_STATE_READ_FAILED", STATE_SQL)
    lines = [line for line in body.splitlines() if line.startswith("{")]
    if len(lines) != 1:
        raise RuntimeError("K56_GRANT_STATE_SHAPE_INVALID")
    return json.loads(lines[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--deploy", action="store_true")
    args = parser.parse_args()
    if args.dry_run and args.deploy:
        raise RuntimeError("K56_GRANT_MODE_CONFLICT")
    migration = MIGRATION.read_text(encoding="utf-8")
    if migration.count("COMMIT;") != 1 or "assessment_k56." not in migration:
        raise RuntimeError("K56_GRANT_MIGRATION_UNEXPECTED")
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        image = command(client, "docker inspect --format '{{.Image}}|"
                        "{{.State.Health.Status}}' izone-k56-ic2264-api",
                        "K56_API_INSPECT_FAILED")
        k67_health = command(client, "docker inspect --format "
                             "'{{.State.Health.Status}}' mapping-review-api",
                             "K67_API_INSPECT_FAILED")
        backup_hash = command(client, "sha256sum " + BACKUP,
                              "K56_BACKUP_READ_FAILED").split()[0]
        if (image != CURRENT_IMAGE + "|healthy" or k67_health != "healthy"
                or backup_hash != BACKUP_SHA):
            raise RuntimeError("K56_GRANT_PREFLIGHT_CHANGED")
        before = state(client)
        baseline = {"database": "mapping_db", "roster": 1341, "access": 87,
                    "attempts": 0, "k67Roster": 46,
                    "rosterWrite": False, "accessWrite": False,
                    "checkpointWrite": False, "k67Usage": False}
        if before != baseline:
            raise RuntimeError("K56_GRANT_BASELINE_CHANGED")
        if not (args.dry_run or args.deploy):
            outcome = "grant_preflight_ready"
            after = before
        else:
            sql = (migration.replace("COMMIT;", STATE_SQL + "ROLLBACK;")
                   if args.dry_run else migration)
            transaction = command(client, "docker exec -i mapping-postgres sh -lc "
                    "'psql -X -q -A -t -v ON_ERROR_STOP=1 "
                    "-U \"$POSTGRES_USER\" -d mapping_db'",
                    "K56_GRANT_TRANSACTION_FAILED", sql)
            if args.dry_run:
                lines = [line for line in transaction.splitlines() if line.startswith("{")]
                if len(lines) != 1 or json.loads(lines[0]) != {
                        **baseline, "rosterWrite": True, "accessWrite": True,
                        "checkpointWrite": True}:
                    raise RuntimeError("K56_GRANT_TRANSACTION_READBACK_FAILED")
            after = state(client)
            expected = {**baseline, "rosterWrite": args.deploy,
                        "accessWrite": args.deploy,
                        "checkpointWrite": args.deploy}
            if after != expected:
                raise RuntimeError("K56_GRANT_READBACK_FAILED")
            outcome = "grant_deployed_verified" if args.deploy else "grant_rollback_verified"
        print(json.dumps({"toolOutcome": "success", "businessOutcome": outcome,
                          "before": before, "after": after,
                          "k67ServiceUnchanged": True,
                          "productionGrantChanged": args.deploy}))
    finally:
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
