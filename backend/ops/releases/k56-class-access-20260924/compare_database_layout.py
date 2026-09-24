"""So sánh cấu trúc hai database đang chạy, chỉ đọc và chỉ xuất số đếm."""

import json
import sys
import hashlib

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
// Dữ liệu vào: DATABASE_URL của đúng container API đang chạy.
// Việc chính: đọc schema, định nghĩa đề và số bản ghi tổng hợp, không đọc bài/học viên.
// Kết quả: metadata JSON để quyết định có thể dùng chung database hay không.
// Khi lỗi: exit khác 0; không suy diễn rằng bảng hoặc dữ liệu không tồn tại.
import pg from 'pg';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 10000});
const tables = [
  'mapping.sync_run', 'mapping.erp_class_membership_snapshot',
  'mapping.classroom_course_mapping', 'assessment.test_definition',
  'mapping.student_mapping_review',
  'assessment.term_test_roster', 'assessment.term_test_attempt',
  'assessment.term_test_exam_session', 'assessment.term_test_class_access',
  'assessment.k56_roster_sync_checkpoint',
  'assessment.term_test_portal_sync_state',
  'assessment.term_test_portal_sync_job',
  'assessment.term_test_writing_grading_job',
  'assessment.term_test_writing_grading_final'
];
try {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout = '15s'");
    const identity = (await db.query(`SELECT current_database() AS database,
      current_user AS role`)).rows[0];
    const layout = {};
    for (const table of tables) {
      const exists = (await db.query('SELECT to_regclass($1) IS NOT NULL AS yes',
        [table])).rows[0].yes;
      layout[table] = {exists};
      if (exists) {
        layout[table].rows = (await db.query(`SELECT count(*)::int AS rows FROM ${table}`))
          .rows[0].rows;
      }
    }
    const slugs = layout['assessment.test_definition'].exists
      ? (await db.query(`SELECT slug, is_active FROM assessment.test_definition
        ORDER BY slug LIMIT 100`)).rows : [];
    const rosterByFamily = layout['assessment.term_test_roster'].exists
      ? (await db.query(`SELECT CASE WHEN test_slug LIKE '%k56%' THEN 'k56'
          WHEN test_slug LIKE '%k67%' THEN 'k67' ELSE 'other' END AS family,
          count(*)::int AS rows FROM assessment.term_test_roster
          GROUP BY 1 ORDER BY 1`)).rows : [];
    const attemptsByFamily = layout['assessment.term_test_attempt'].exists
      ? (await db.query(`SELECT CASE WHEN test_slug LIKE '%k56%' THEN 'k56'
          WHEN test_slug LIKE '%k67%' THEN 'k67' ELSE 'other' END AS family,
          count(*)::int AS rows FROM assessment.term_test_attempt
          GROUP BY 1 ORDER BY 1`)).rows : [];
    const relevantColumns = (await db.query(`SELECT table_schema, table_name,
      column_name, data_type FROM information_schema.columns
      WHERE (table_schema, table_name) IN (
        ('mapping', 'classroom_course_mapping'),
        ('assessment', 'term_test_roster'),
        ('assessment', 'term_test_portal_sync_state'),
        ('assessment', 'test_definition'))
      ORDER BY table_schema, table_name, ordinal_position`)).rows;
    const pilotIdentity = layout['mapping.student_mapping_review'].exists
      ? (await db.query(`SELECT erp_student_contact_id::text AS contact_id,
        public_id::text AS public_id FROM mapping.student_mapping_review
        WHERE erp_course_class_id = 1252`)).rows : [];
    const assessmentColumns = (await db.query(`SELECT table_name, column_name,
      data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'assessment'
      ORDER BY table_name, ordinal_position`)).rows;
    const assessmentSecurity = (await db.query(`SELECT c.relname AS table_name,
      c.relrowsecurity AS row_security, c.relforcerowsecurity AS forced_row_security,
      pg_get_userbyid(c.relowner) AS owner
      FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'assessment' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`)).rows;
    await db.query('COMMIT');
    process.stdout.write(JSON.stringify({identity, layout, slugs,
      rosterByFamily, attemptsByFamily, relevantColumns, assessmentColumns,
      assessmentSecurity, pilotIdentity}));
  } finally { db.release(); }
} finally { await pool.end(); }
"""


def read_container(client, container):
    # Dữ liệu vào: tên container API cố định và script SELECT.
    # Việc chính: thực thi trong container để dùng kết nối sẵn có, kiểm exit.
    # Kết quả: JSON tổng hợp, không in credential hay stderr từ máy chủ.
    stdin, stdout, stderr = client.exec_command(
        f"docker exec -i {container} node --input-type=module -", timeout=60)
    stdin.write(REMOTE_SCRIPT)
    stdin.channel.shutdown_write()
    raw = stdout.read()
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(f"COMPARE_READ_FAILED_{container}")
    return json.loads(raw.decode("utf-8"))


def main():
    # Dữ liệu vào: quyền SSH có sẵn trong Credential Manager.
    # Việc chính: đọc hai container độc lập và xác minh tên DB mong đợi.
    # Kết quả: so sánh có cấu trúc, không ghi VPS hoặc dữ liệu riêng.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0] or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        shared = read_container(client, "mapping-review-api")
        k56 = read_container(client, "izone-k56-ic2264-api")
    finally:
        client.close()
    if (shared["identity"]["database"] != "mapping_db"
            or k56["identity"]["database"] != "izone_mapping_k56_ic2264"):
        raise RuntimeError("UNEXPECTED_DATABASES")
    columns_by_database = {}
    for label, data in (("shared", shared), ("k56", k56)):
        columns_by_table = {}
        for column in data.pop("assessmentColumns"):
            columns_by_table.setdefault(column["table_name"], []).append(
                (column["column_name"], column["data_type"], column["is_nullable"]))
        columns_by_database[label] = columns_by_table
        data["assessmentTables"] = {
            table: {"columns": len(columns),
                    "schemaHash": hashlib.sha256(json.dumps(columns).encode("utf-8")).hexdigest()[:12]}
            for table, columns in columns_by_table.items()}
    shared_tables = columns_by_database["shared"]
    k56_tables = columns_by_database["k56"]
    shared_pilot = {row["contact_id"]: row["public_id"]
                    for row in shared.pop("pilotIdentity")}
    k56_pilot = {row["contact_id"]: row["public_id"]
                 for row in k56.pop("pilotIdentity")}
    overlap = set(shared_pilot) & set(k56_pilot)
    common = set(shared_tables) & set(k56_tables)
    differences = {
        table: {"sharedOnlyColumns": sorted(set(shared_tables[table]) - set(k56_tables[table])),
                "k56OnlyColumns": sorted(set(k56_tables[table]) - set(shared_tables[table]))}
        for table in sorted(common) if shared_tables[table] != k56_tables[table]
    }
    print(json.dumps({"toolOutcome": "success", "businessOutcome": "read_only_comparison",
                      "shared": shared, "k56": k56,
                      "assessmentSchemaComparison": {
                          "sharedOnlyTables": sorted(set(shared_tables) - set(k56_tables)),
                          "k56OnlyTables": sorted(set(k56_tables) - set(shared_tables)),
                          "differentTables": differences},
                      "pilotIdentityComparison": {
                          "sharedRows": len(shared_pilot), "k56Rows": len(k56_pilot),
                          "overlappingContacts": len(overlap),
                          "matchingPublicIds": sum(shared_pilot[key] == k56_pilot[key]
                                                   for key in overlap)},
                      "productionWrites": 0},
                     ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
