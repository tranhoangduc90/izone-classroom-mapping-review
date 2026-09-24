"""Chỉ đọc số lượt và trạng thái job Writing Term/Mini trong mapping_db chung."""

import json
import sys

import paramiko
import win32cred


SQL = r"""
BEGIN READ ONLY;
SELECT json_build_object(
  'database', current_database(),
  'k56Attempts', (SELECT count(*) FROM assessment_k56.term_test_attempt),
  'k56Runs', (SELECT count(*) FROM assessment_k56.term_test_writing_grading_run),
  'k56Jobs', (SELECT count(*) FROM assessment_k56.term_test_writing_grading_job),
  'k56JobStatuses', (
    SELECT coalesce(json_object_agg(status, total), '{}'::json)
    FROM (SELECT status, count(*) AS total
          FROM assessment_k56.term_test_writing_grading_job
          GROUP BY status) AS grouped
  ),
  'k67Attempts', (SELECT count(*) FROM assessment.term_test_attempt),
  'k67Runs', (SELECT count(*) FROM assessment.term_test_writing_grading_run),
  'k67Jobs', (SELECT count(*) FROM assessment.term_test_writing_grading_job),
  'k67JobStatuses', (
    SELECT coalesce(json_object_agg(status, total), '{}'::json)
    FROM (SELECT status, count(*) AS total
          FROM assessment.term_test_writing_grading_job
          GROUP BY status) AS grouped
  )
)::text;
COMMIT;
"""


def main():
    # Dữ liệu nhận vào: đúng mapping_db production qua phiên SSH trong Credential Manager.
    # Việc chính: đếm lượt/job theo hai schema; transaction READ ONLY không đọc nội dung bài.
    # Kết quả: số lượng và trạng thái để tránh tranh bài đang chấm với phép thử tích hợp.
    # Khi lỗi: trả mã lỗi an toàn, không in credential, tên hay hồ sơ học viên.
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
        command = ("docker exec -i mapping-postgres sh -lc "
                   "'psql -X -q -A -t -v ON_ERROR_STOP=1 "
                   "-U \"$POSTGRES_USER\" -d mapping_db'")
        stdin, stdout, stderr = client.exec_command(command, timeout=30)
        stdin.write(SQL)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        stderr.read()
        if stdout.channel.recv_exit_status() != 0:
            raise RuntimeError("WRITING_QUEUE_READ_FAILED")
        rows = [line for line in body.splitlines() if line.startswith("{")]
        if len(rows) != 1:
            raise RuntimeError("WRITING_QUEUE_SHAPE_INVALID")
        data = json.loads(rows[0])
        if data.get("database") != "mapping_db":
            raise RuntimeError("WRITING_QUEUE_DATABASE_MISMATCH")
        print(json.dumps({"toolOutcome": "success", "productionWrites": 0,
                          **data}, ensure_ascii=False))
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
