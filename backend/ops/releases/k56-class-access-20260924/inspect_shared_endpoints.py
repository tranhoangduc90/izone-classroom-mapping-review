"""So đúng endpoint/cluster database mà API mapping và công cụ migration dùng."""

import json
import sys

import paramiko
import win32cred

from trial_shared_migrations import remote


API_SCRIPT = r"""
// Dữ liệu vào: DATABASE_URL của container API đang chạy.
// Việc chính: chỉ đọc địa chỉ đích đã ẩn mật khẩu và fingerprint dữ liệu.
// Kết quả: metadata để chọn đúng cluster; không đọc bài/định danh học viên.
// Khi lỗi: trả exit khác 0 để chặn mọi mutation.
import pg from 'pg';
import dns from 'node:dns/promises';
const url = new URL(process.env.DATABASE_URL);
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1});
try {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const row = (await db.query(`SELECT current_database() AS database,
      current_user AS role, inet_server_addr()::text AS server_address,
      inet_server_port() AS server_port, pg_postmaster_start_time() AS started_at,
      (SELECT max(id)::text FROM mapping.sync_run
       WHERE source = 'n8n_k56_erp_ongoing') AS latest_k56_run,
      (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute AS a
       WHERE a.attrelid = 'mapping.sync_run'::regclass AND a.attname = 'id')
       AS sync_id_type,
      (SELECT count(*)::int FROM mapping.classroom_course_mapping) AS mappings,
      (SELECT count(*)::int FROM assessment.term_test_roster) AS k67_roster,
      to_regnamespace('assessment_k56') IS NOT NULL AS k56_schema_exists`)).rows[0];
    await db.query('COMMIT');
    let resolved = 'unresolved';
    try { resolved = (await dns.lookup(url.hostname)).address; } catch {}
    process.stdout.write(JSON.stringify({endpoint: {
      host: url.hostname, port: url.port || '5432', database: url.pathname.slice(1),
      user: url.username, resolvedAddress: resolved}, row}));
  } finally { db.release(); }
} finally { await pool.end(); }
"""


def main():
    # Dữ liệu vào: API và hai PostgreSQL container trên cùng VPS.
    # Việc chính: so host/cluster/lượt ERP, không đổi cấu hình hoặc dữ liệu.
    # Kết quả: xác định đúng đích cần dùng cho các bước sau.
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
        api = json.loads(remote(client, "docker exec -i mapping-review-api "
                                "node --input-type=module -", API_SCRIPT,
                                code="API_ENDPOINT_READ_FAILED"))
        direct = json.loads(remote(client, "docker exec -i mapping-postgres sh -lc "
                                   "'psql -X -U \"$POSTGRES_USER\" -d mapping_db -At'",
                                   "SELECT json_build_object("
                                   "'database', current_database(),"
                                   "'role', current_user,"
                                   "'serverAddress', inet_server_addr()::text,"
                                   "'serverPort', inet_server_port(),"
                                   "'startedAt', pg_postmaster_start_time(),"
                                   "'latestK56Run', (SELECT max(id)::text FROM mapping.sync_run "
                                   "WHERE source = 'n8n_k56_erp_ongoing'),"
                                   "'latestOrderedRun', (SELECT id::text FROM mapping.sync_run "
                                   "WHERE source = 'n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1),"
                                   "'syncIdType', (SELECT format_type(a.atttypid, a.atttypmod) "
                                   "FROM pg_attribute AS a WHERE a.attrelid = "
                                   "'mapping.sync_run'::regclass AND a.attname = 'id'),"
                                   "'mappings', (SELECT count(*) FROM mapping.classroom_course_mapping),"
                                   "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster),"
                                   "'k56SchemaExists', to_regnamespace('assessment_k56') "
                                   "IS NOT NULL)::text;\n",
                                   code="DIRECT_ENDPOINT_READ_FAILED"))
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "read_only_endpoint_comparison",
                          "api": api, "direct": direct,
                          "productionWrites": 0}, ensure_ascii=False))
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
