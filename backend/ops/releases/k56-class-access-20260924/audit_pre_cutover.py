"""Đối soát read-only kho cũ/chung và phân quyền giảng viên trước đổi API."""

import json
import sys

import paramiko
import win32cred


SHARED_SQL = r"""
BEGIN READ ONLY;
SELECT json_build_object(
  'database', current_database(),
  'latestK56SyncRun', (SELECT run.id::text FROM mapping.sync_run AS run
      WHERE run.source = 'n8n_k56_erp_ongoing' ORDER BY run.id DESC LIMIT 1),
  'k56Definitions', (SELECT count(*) FROM assessment_k56.test_definition),
  'k56Roster', (SELECT count(*) FROM assessment_k56.term_test_roster),
  'k56RosterClasses', (SELECT count(DISTINCT erp_course_class_id)
      FROM assessment_k56.term_test_roster),
  'k56Access', (SELECT count(*) FROM assessment_k56.term_test_class_access),
  'k56Attempts', (SELECT count(*) FROM assessment_k56.term_test_attempt),
  'k56WritingJobs', (SELECT count(*) FROM assessment_k56.term_test_writing_grading_job),
  'k56PortalStates', (SELECT count(*) FROM assessment_k56.term_test_portal_sync_state),
  'k56AssignedClasses', (SELECT count(DISTINCT access.erp_course_class_id)
      FROM mapping.reviewer_class_access AS access
      WHERE access.erp_course_class_id IN
        (SELECT DISTINCT erp_course_class_id FROM assessment_k56.term_test_roster)),
  'k56AssignmentRows', (SELECT count(*) FROM mapping.reviewer_class_access AS access
      WHERE access.erp_course_class_id IN
        (SELECT DISTINCT erp_course_class_id FROM assessment_k56.term_test_roster)),
  'activeAdmins', (SELECT count(*) FROM mapping.reviewer_account
      WHERE role = 'admin' AND status = 'active'),
  'reviewerSessions', (SELECT count(*) FROM mapping.reviewer_session),
  'k67Roster', (SELECT count(*) FROM assessment.term_test_roster),
  'k67Attempts', (SELECT count(*) FROM assessment.term_test_attempt),
  'k67WritingJobs', (SELECT count(*) FROM assessment.term_test_writing_grading_job),
  'k67RunningJobs', (SELECT count(*) FROM assessment.term_test_writing_grading_job
      WHERE status IN ('processing', 'running', 'claimed'))
)::text;
COMMIT;
"""

OLD_SQL = r"""
BEGIN READ ONLY;
SELECT json_build_object(
  'database', current_database(),
  'roster', (SELECT count(*) FROM assessment.term_test_roster),
  'attempts', (SELECT count(*) FROM assessment.term_test_attempt),
  'writingJobs', (SELECT count(*) FROM assessment.term_test_writing_grading_job),
  'reviewerClassAccess', (SELECT count(*) FROM mapping.reviewer_class_access),
  'activeAdmins', (SELECT count(*) FROM mapping.reviewer_account
      WHERE role = 'admin' AND status = 'active'),
  'reviewerSessions', (SELECT count(*) FROM mapping.reviewer_session)
)::text;
COMMIT;
"""


def select(client, container, database, sql, code):
    command = (f"docker exec -i {container} sh -lc "
               f"'psql -X -q -A -t -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d {database}'")
    stdin, stdout, stderr = client.exec_command(command, timeout=30)
    stdin.write(sql)
    stdin.channel.shutdown_write()
    body = stdout.read().decode("utf-8").strip()
    stderr.read()
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(code)
    lines = [line.strip() for line in body.splitlines() if line.strip().startswith("{")]
    if len(lines) != 1:
        raise RuntimeError(code + "_SHAPE")
    return json.loads(lines[0])


def main():
    # Dữ liệu vào: hai database production, chỉ các số tổng hợp.
    # Việc chính: kiểm bài cũ, bài mới, phân quyền lớp và tải K67 trước cutover.
    # Kết quả: baseline không chứa tên, email, UUID hoặc bài viết.
    # Khi lỗi: dừng, chưa chạy Compose up.
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
        shared = select(client, "mapping-postgres", "mapping_db", SHARED_SQL,
                        "SHARED_PRECUTOVER_QUERY_FAILED")
        old = select(client, "izone-k56-demo-k56-demo-db-1",
                     "izone_mapping_k56_ic2264", OLD_SQL,
                     "OLD_PRECUTOVER_QUERY_FAILED")
        report = {"toolOutcome": "success",
                  "businessOutcome": "read_only_pre_cutover_baseline",
                  "shared": shared, "oldK56": old,
                  "productionWrites": 0}
        print(json.dumps(report))
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
