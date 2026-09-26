"""Chỉ đọc trạng thái image, cổng quyền và mã nguồn K56 đang chạy."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
// Dữ liệu vào: container API K56 đang chạy và DATABASE_URL ở trong container.
// Việc chính: đọc hash ba file cổng quyền, trạng thái bảng quyền và định nghĩa đề.
// Kết quả: metadata triển khai; không đọc hồ sơ học viên hoặc secret.
// Khi lỗi: exit khác 0 để không báo nhầm production đã sẵn sàng.
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
const paths = ['src/sql.js', 'src/erp-sync.js', 'src/term-test-portal-sync.js'];
const hashes = {};
for (const path of paths) {
  hashes[path] = fs.existsSync(path)
    ? crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')
    : null;
}
const packageHashes = {};
for (const path of ['package.json', 'package-lock.json']) {
  packageHashes[path] = fs.existsSync(path)
    ? crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')
    : null;
}
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageVersions = {
  dependencies: packageJson.dependencies ?? {},
  devDependencies: packageJson.devDependencies ?? {}
};
const db = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 10000});
try {
  const meta = (await db.query(`SELECT current_database() AS database,
    to_regclass('assessment_k56.term_test_class_access') IS NOT NULL AS access_exists`)).rows[0];
  const definitions = (await db.query(`SELECT slug, is_active
    FROM assessment_k56.test_definition WHERE slug = ANY($1::text[])`,
    [['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56']])).rows;
  const access = meta.access_exists ? (await db.query(`SELECT test_slug, enabled,
    count(*)::int AS rows FROM assessment_k56.term_test_class_access
    GROUP BY test_slug, enabled ORDER BY test_slug, enabled`)).rows : [];
  const importColumns = (await db.query(`SELECT table_schema, table_name,
    column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE (table_schema, table_name) IN (
      ('mapping', 'classroom_course_mapping'),
      ('assessment_k56', 'term_test_roster'))
    ORDER BY table_schema, table_name, ordinal_position`)).rows;
  process.stdout.write(JSON.stringify({database: meta.database,
    accessExists: meta.access_exists, access, definitions, hashes, packageHashes,
    packageVersions,
    nodeVersion: process.version, importColumns}));
} finally { await db.end(); }
"""


def ssh_read(client, command, code, stdin_data=None):
    # Dữ liệu vào: lệnh đọc metadata với đích container cố định.
    # Việc chính: kiểm exit rồi mới phân tích output; không in stderr thô.
    # Kết quả: JSON/chuỗi không nhạy cảm; lỗi chỉ có mã.
    stdin, stdout, stderr = client.exec_command(command, timeout=35)
    if stdin_data is not None:
        stdin.write(stdin_data)
    stdin.channel.shutdown_write()
    data = stdout.read().decode("utf-8")
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(code)
    return data.strip()


def main():
    # Dữ liệu vào: quyền SSH cất trong Credential Manager.
    # Việc chính: kiểm image và DB thực tế mà không thay đổi VPS.
    # Kết quả: metadata an toàn để so với source branch trước phát hành.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0] or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        image = ssh_read(client, "docker inspect --format '{{.Image}}|{{.Config.Image}}|{{.State.Health.Status}}|{{.RestartCount}}' izone-k56-ic2264-api", "RELEASE_IMAGE_READ_FAILED")
        metadata = json.loads(ssh_read(client,
            "docker exec -i izone-k56-ic2264-api node --input-type=module -",
            "RELEASE_DB_METADATA_READ_FAILED", REMOTE_SCRIPT))
    finally:
        client.close()
    parts = image.split("|")
    if len(parts) != 4 or metadata.get("database") != "mapping_db":
        raise RuntimeError("UNEXPECTED_RELEASE_TARGET")
    print(json.dumps({"toolOutcome": "success", "imageId": parts[0],
                      "imageTag": parts[1], "health": parts[2],
                      "restartCount": int(parts[3]), "database": metadata["database"],
                      "accessExists": metadata["accessExists"],
                      "access": metadata["access"],
                      "definitions": metadata["definitions"],
                      "sourceHashes": metadata["hashes"],
                      "packageHashes": metadata["packageHashes"],
                      "packageVersions": metadata["packageVersions"],
                      "nodeVersion": metadata["nodeVersion"],
                      "importColumns": metadata["importColumns"]}, ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}), file=sys.stderr)
        raise SystemExit(2)
