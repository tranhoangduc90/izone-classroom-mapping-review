"""Đọc cấu trúc hàng chờ Writing trong kho chung, không đọc bài học viên."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: metadata PostgreSQL của các bảng Writing đang chạy.
# Việc chính: đọc tên cột, kiểu, ràng buộc và quyền INSERT; không SELECT hàng dữ liệu.
# Kết quả: cấu trúc cần để thiết kế adapter bài thi web và cờ productionWrites=0.
# Khi lỗi: chỉ trả mã lỗi, không in credential, SQL stderr hoặc nội dung bảng.
import json
import subprocess
import sys

sql = '''
WITH wanted(name) AS (
  VALUES ('pair'), ('source_record'), ('test_group'), ('test_pair'),
         ('handoff'), ('stage_result'), ('stage_attempt')
)
SELECT json_build_object(
  'database', current_database(),
  'schemaExists', EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'writing_flow'
  ),
  'tables', (
    SELECT json_agg(json_build_object(
      'name', wanted.name,
      'exists', relation.oid IS NOT NULL,
      'columns', COALESCE((
        SELECT json_agg(json_build_object(
          'name', column_name, 'type', data_type, 'nullable', is_nullable
        ) ORDER BY ordinal_position)
        FROM information_schema.columns
        WHERE table_schema = 'writing_flow' AND table_name = wanted.name
      ), '[]'::json),
      'constraints', COALESCE((
        SELECT json_agg(json_build_object(
          'name', constraint_item.conname,
          'type', constraint_item.contype,
          'definition', pg_get_constraintdef(constraint_item.oid)
        ) ORDER BY constraint_item.conname)
        FROM pg_constraint AS constraint_item
        WHERE constraint_item.conrelid = relation.oid
          AND constraint_item.contype IN ('c', 'f', 'p', 'u')
      ), '[]'::json),
      'apiCanInsert', CASE WHEN relation.oid IS NULL THEN false
        ELSE has_table_privilege('writing_practice_api', relation.oid, 'INSERT')
      END
    ) ORDER BY wanted.name)
    FROM wanted
    LEFT JOIN pg_class AS relation ON relation.relname = wanted.name
      AND relation.relnamespace = (
        SELECT oid FROM pg_namespace WHERE nspname = 'writing_flow'
      )
  )
)::text;
'''

try:
    result = subprocess.run(
        [
            'docker', 'exec', '-i', 'mapping-postgres', 'sh', '-lc',
            'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db',
        ],
        input=sql,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError('SCHEMA_READ_FAILED')
    payload = json.loads(result.stdout.strip())
    payload['toolOutcome'] = 'success'
    payload['productionWrites'] = 0
    print(json.dumps(payload, ensure_ascii=False))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    # Mã truy cập chỉ ở Windows Credential Manager và bộ nhớ của phiên SSH.
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=60)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        _ = stderr.read()
        if stdout.channel.recv_exit_status() != 0:
            raise RuntimeError("REMOTE_SCHEMA_READ_FAILED")
        payload = json.loads(body)
        if payload.get("toolOutcome") != "success" or payload.get("productionWrites") != 0:
            raise RuntimeError("SCHEMA_RESULT_INVALID")
        print(json.dumps(payload, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as exc:
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(json.dumps({"toolOutcome": "failure", "errorCode": code}),
              file=sys.stderr)
        raise SystemExit(2)
