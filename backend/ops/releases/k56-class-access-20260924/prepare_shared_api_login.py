"""Tạo tài khoản đăng nhập riêng cho API K56 sau backup đã phục hồi thử."""

import json
from pathlib import Path
import re
import sys

import paramiko
import win32cred


BACKUP_DIR = "/opt/backups/k56-shared-cutover-yy5v09Z2"
SHARED_SHA = "0b186845321309a4e57ab9e641749c92bf8705bd129f8e842197a0f2c35bb49e"
K56_SHA = "31355f4de1ee6f655c10704c565d739bfe70c212109d5a263e3555e2b4f3d5b1"
IMAGE = "izone-k56-live-results:20260924.1-shared-db"
EXPECTED_IMAGE_ID = "sha256:c048bc0afd7baf659fe2db616b3a19167933694e0bcf826aa24c836458794183"

REMOTE_SCRIPT = r"""
# Dữ liệu vào: hai bản backup đã restore drill, image đã kiểm source và role NOLOGIN.
# Việc chính: tạo mật khẩu ngẫu nhiên chỉ trên VPS, lưu file riêng tư, bật LOGIN rồi
# thử bằng đúng image K56 trên mạng kho chung; K67 phải bị database từ chối.
# Kết quả: canary có thể kết nối, chưa đổi API production hay mở quyền lớp.
# Khi lỗi: tắt LOGIN vừa bật và bỏ file riêng do lượt này tạo; không in secret.
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

backup_dir = Path(%(backup_dir)r)
shared_sha = %(shared_sha)r
k56_sha = %(k56_sha)r
image = %(image)r
image_id = %(image_id)r
secret_dir = Path('/opt/izone-k56-shared-db-20260924')
secret_file = secret_dir / 'db-url.env'
role_enabled = False
file_created = False

def run(argv, stdin=None, code='REMOTE_COMMAND_FAILED'):
    result = subprocess.run(argv, input=stdin, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=90, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

def query(sql):
    return run(['docker', 'exec', '-i', 'mapping-postgres', 'sh', '-lc',
                'psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db'],
               sql + ';\n', 'DB_PREFLIGHT_FAILED')

try:
    for filename, expected in [
        ('mapping_db-before-k56.dump', shared_sha),
        ('k56-separate-before-cutover.dump', k56_sha),
    ]:
        target = backup_dir / filename
        if not target.is_file():
            raise RuntimeError('BACKUP_MISSING')
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest != expected:
            raise RuntimeError('BACKUP_HASH_MISMATCH')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
           code='IMAGE_MISSING') != image_id:
        raise RuntimeError('IMAGE_ID_CHANGED')
    if secret_file.exists():
        raise RuntimeError('SECRET_FILE_ALREADY_EXISTS')
    before = json.loads(query("SELECT json_build_object("
        "'database', current_database(),"
        "'login', (SELECT rolcanlogin FROM pg_roles WHERE rolname='k56_shared_api'),"
        "'k56Usage', has_schema_privilege('k56_shared_api','assessment_k56','USAGE'),"
        "'k67Usage', has_schema_privilege('k56_shared_api','assessment','USAGE'),"
        "'k56Roster', (SELECT count(*) FROM assessment_k56.term_test_roster),"
        "'k56Access', (SELECT count(*) FROM assessment_k56.term_test_class_access),"
        "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster))::text"))
    expected = {'database': 'mapping_db', 'login': False, 'k56Usage': True,
                'k67Usage': False, 'k56Roster': 1341, 'k56Access': 0,
                'k67Roster': 46}
    if before != expected:
        raise RuntimeError('ROLE_OR_DATA_PREFLIGHT_CHANGED')
    if secret_dir.exists() and not secret_dir.is_dir():
        raise RuntimeError('SECRET_DIRECTORY_INVALID')
    secret_dir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(secret_dir, 0o700)
    password = secrets.token_urlsafe(36)
    # token_urlsafe chỉ dùng ký tự URL an toàn, không có dấu nháy SQL.
    if not all(char.isalnum() or char in '-_' for char in password):
        raise RuntimeError('PASSWORD_ALPHABET_INVALID')
    database_url = 'postgresql://k56_shared_api:' + password + '@mapping-postgres:5432/mapping_db'
    descriptor = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    file_created = True
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        stream.write('DATABASE_URL=' + database_url + '\n')
    run(['docker', 'exec', '-i', 'mapping-postgres', 'sh', '-lc',
         'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db'],
        "BEGIN; ALTER ROLE k56_shared_api WITH LOGIN PASSWORD '" + password + "'; COMMIT;\n",
        'ROLE_LOGIN_FAILED')
    role_enabled = True
    canary_js = r'''
// Dữ liệu vào: DATABASE_URL chỉ cấp schema K56.
// Việc chính: kiểm kết nối, số roster và việc K67 bị từ chối.
// Kết quả: chỉ in số lượng/mã lỗi, không in mật khẩu hay học viên.
// Khi lỗi: exit khác 0 để hủy LOGIN vừa tạo.
import pg from 'pg';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1});
try {
  const db = await pool.connect();
  try {
    const own = (await db.query('SELECT current_database() AS db, current_user AS role, '
      + '(SELECT count(*)::int FROM assessment_k56.term_test_roster) AS roster')).rows[0];
    let k67Denied = false;
    try { await db.query('SELECT count(*) FROM assessment.term_test_roster'); }
    catch (error) { k67Denied = error.code === '42501'; }
    if (own.db !== 'mapping_db' || own.role !== 'k56_shared_api'
        || own.roster !== 1341 || !k67Denied) throw new Error('ROLE_ISOLATION_FAILED');
    process.stdout.write(JSON.stringify({role: own.role, roster: own.roster,
      k67Denied}) + '\n');
  } finally { db.release(); }
} finally { await pool.end(); }
'''
    login_result = json.loads(run([
        'docker', 'run', '--rm', '-i', '--network', 'mapping-api-net',
        '--env-file', str(secret_file), '--entrypoint', 'node', image,
        '--input-type=module', '-'],
        canary_js, 'ROLE_LOGIN_CANARY_FAILED'))
    if login_result != {'role': 'k56_shared_api', 'roster': 1341,
                        'k67Denied': True}:
        raise RuntimeError('ROLE_LOGIN_CANARY_MISMATCH')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'k56_shared_login_isolated',
                      'role': 'k56_shared_api', 'roster': 1341,
                      'k67Denied': True, 'secretFile': str(secret_file),
                      'productionApiChanged': False,
                      'classAccessRows': 0}))
except Exception as exc:
    role_may_remain = role_enabled
    if role_enabled:
        try:
            run(['docker', 'exec', '-i', 'mapping-postgres', 'sh', '-lc',
                 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db'],
                'ALTER ROLE k56_shared_api NOLOGIN;\n', 'ROLE_DISABLE_FAILED')
            role_may_remain = False
        except Exception:
            pass
    if file_created and secret_file.is_file():
        secret_file.unlink()
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'roleLoginMayRemain': role_may_remain}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    # Dữ liệu vào: SSH credential trong Credential Manager, không truyền secret qua chat.
    # Việc chính: gửi script đã khóa backup/image sang VPS qua stdin.
    # Kết quả: chỉ trạng thái role và đường dẫn file kín.
    # Khi lỗi: giữ nguyên API production, không tuyên bố canary đạt.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    script = REMOTE_SCRIPT % {
        "backup_dir": BACKUP_DIR,
        "shared_sha": SHARED_SHA,
        "k56_sha": K56_SHA,
        "image": IMAGE,
        "image_id": EXPECTED_IMAGE_ID,
    }
    try:
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=120)
        stdin.write(script)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                report = json.loads(error)
                code = report.get("errorCode", "ROLE_PREPARATION_FAILED")
                role_may_remain = report.get("roleLoginMayRemain", False)
            except (ValueError, TypeError):
                code = "ROLE_PREPARATION_FAILED"
                role_may_remain = True
            print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                              "roleLoginMayRemain": role_may_remain}), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "k56_shared_login_isolated":
            raise RuntimeError("ROLE_READBACK_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
