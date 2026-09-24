"""Mở ba đề cho đúng lớp K56 ERP ongoing sau giao dịch thử có rollback."""

import argparse
import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: lượt đồng bộ ERP 105 và roster K56 trong mapping_db.
# Việc chính: khóa nguồn/đích, so toàn bộ khóa lớp–học viên–đề, thử rollback
# hoặc thêm đúng 84 quyền còn thiếu trong một giao dịch duy nhất.
# Kết quả: đọc lại 87 quyền và 87 đường roster HTTP, không in dữ liệu học viên.
# Khi lỗi: giao dịch rollback; phải đọc lại quyền trước mọi lần chạy khác.
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

deploy = __DEPLOY__
backup_dir = Path('/opt/backups/k56-shared-cutover-yy5v09Z2')
hashes = {
    'mapping_db-before-k56.dump': '0b186845321309a4e57ab9e641749c92bf8705bd129f8e842197a0f2c35bb49e',
    'k56-separate-before-cutover.dump': '31355f4de1ee6f655c10704c565d739bfe70c212109d5a263e3555e2b4f3d5b1',
}
new_image = 'sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7'
mutation_attempted = False

def run(args, code, input_text=None, timeout=90):
    result = subprocess.run(args, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

def inspect(name):
    items = json.loads(run(['docker', 'inspect', name], 'CONTAINER_INSPECT_FAILED'))
    if len(items) != 1:
        raise RuntimeError('CONTAINER_INSPECT_AMBIGUOUS')
    return items[0]

def psql(sql, code):
    command = ['docker', 'exec', '-i', 'mapping-postgres', 'sh', '-lc',
               'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db']
    return run(command, code, input_text=sql + '\n', timeout=90)

def get_roster(class_code, slug):
    path = ('/api/term-tests/roster?class=' + quote(class_code)
            + '&test=' + quote(slug))
    try:
        with urlopen('http://127.0.0.1:8795' + path, timeout=8) as response:
            return response.status, json.loads(response.read().decode('utf-8'))
    except HTTPError as exc:
        return exc.code, {}

try:
    for filename, expected in hashes.items():
        target = backup_dir / filename
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise RuntimeError('BACKUP_NOT_VERIFIED')
    api = inspect('izone-k56-ic2264-api')
    k67 = inspect('mapping-review-api')
    if (api['Image'] != new_image
            or api['State'].get('Health', {}).get('Status') != 'healthy'
            or k67['State'].get('Health', {}).get('Status') != 'healthy'):
        raise RuntimeError('API_IMAGE_OR_HEALTH_CHANGED')
    before = json.loads(psql("SELECT json_build_object("
        "'latest',(SELECT run.id::text FROM mapping.sync_run AS run "
        "WHERE run.source='n8n_k56_erp_ongoing' ORDER BY run.id DESC LIMIT 1),"
        "'access',(SELECT count(*) FROM assessment_k56.term_test_class_access),"
        "'pilot',(SELECT count(*) FROM assessment_k56.term_test_class_access "
        "WHERE erp_course_class_id=1252 AND enabled=true),"
        "'roster',(SELECT count(*) FROM assessment_k56.term_test_roster),"
        "'k67Roster',(SELECT count(*) FROM assessment.term_test_roster))::text;",
        'BEFORE_COUNTS_FAILED'))
    if before != {'latest': '105', 'access': 3, 'pilot': 3,
                  'roster': 1341, 'k67Roster': 46}:
        raise RuntimeError('BEFORE_COUNTS_CHANGED')
    by_class = json.loads(psql("WITH latest AS (SELECT id,class_names FROM mapping.sync_run "
        "WHERE source='n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1) "
        "SELECT coalesce(json_agg(json_build_object('class',"
        "upper(map.erp_class_name_snapshot),'count',members.students) "
        "ORDER BY map.erp_class_name_snapshot),'[]'::json)::text "
        "FROM mapping.classroom_course_mapping AS map CROSS JOIN latest "
        "JOIN (SELECT erp_course_class_id,count(*) AS students "
        "FROM mapping.erp_class_membership_snapshot,latest "
        "WHERE sync_run_id=latest.id AND source_state='active' "
        "AND registration_status='on_going' GROUP BY erp_course_class_id) members "
        "ON members.erp_course_class_id=map.erp_course_class_id "
        "WHERE upper(map.erp_class_name_snapshot)=ANY(latest.class_names);",
        'HTTP_EXPECTED_COUNTS_FAILED'))
    if (len(by_class) != 29 or sum(row['count'] for row in by_class) != 447
            or not {'IC2322','IC2326'}.issubset({row['class'] for row in by_class})):
        raise RuntimeError('HTTP_CLASS_SCOPE_INVALID')
    ending = 'COMMIT;' if deploy else 'ROLLBACK;'
    sql = r'''
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='40s';
LOCK TABLE mapping.sync_run, mapping.classroom_course_mapping,
  mapping.erp_class_membership_snapshot, assessment_k56.test_definition,
  assessment_k56.term_test_roster, assessment_k56.term_test_class_access
  IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE k56_scope ON COMMIT DROP AS
  WITH latest AS (
    SELECT id, class_names FROM mapping.sync_run
    WHERE source='n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1
  )
  SELECT map.erp_course_class_id AS class_id,
    upper(map.erp_class_name_snapshot) AS class_code
  FROM mapping.classroom_course_mapping AS map, latest
  WHERE upper(map.erp_class_name_snapshot)=ANY(latest.class_names);
CREATE TEMP TABLE k56_members ON COMMIT DROP AS
  WITH latest AS (
    SELECT id FROM mapping.sync_run
    WHERE source='n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1
  )
  SELECT member.erp_course_class_id AS class_id,
    member.erp_student_contact_id AS contact_id
  FROM mapping.erp_class_membership_snapshot AS member
  JOIN k56_scope AS scope
    ON scope.class_id=member.erp_course_class_id
   AND scope.class_code=upper(member.erp_class_name_snapshot)
  CROSS JOIN latest
  WHERE member.sync_run_id=latest.id
    AND member.source_state='active'
    AND member.registration_status='on_going';
CREATE TEMP TABLE k56_expected ON COMMIT DROP AS
  SELECT slug.test_slug, member.class_id, member.contact_id
  FROM (VALUES ('term-test-1-k56'), ('term-test-2-k56'),
               ('mini-test-k56')) AS slug(test_slug)
  CROSS JOIN k56_members AS member;
DO $gate$
DECLARE run_row record;
BEGIN
  SELECT id, status, class_names, row_count, finished_at, error_message
    INTO run_row FROM mapping.sync_run
    WHERE source='n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1;
  IF run_row.id <> 105 OR run_row.status <> 'completed'
     OR run_row.error_message IS NOT NULL
     OR run_row.finished_at > now()
     OR run_row.finished_at < now() - interval '36 hours'
     OR cardinality(run_row.class_names) <> 29
     OR (SELECT count(DISTINCT code) FROM unnest(run_row.class_names) AS code) <> 29
     OR run_row.row_count <> 510 THEN
    RAISE EXCEPTION 'K56_SOURCE_RUN_CHANGED';
  END IF;
  IF (SELECT count(*) FROM k56_scope) <> 29
     OR (SELECT count(DISTINCT class_id) FROM k56_scope) <> 29
     OR (SELECT count(DISTINCT class_code) FROM k56_scope) <> 29
     OR EXISTS (SELECT 1 FROM k56_scope WHERE class_code !~ '^IC[0-9]+$')
     OR (SELECT count(*) FROM k56_members) <> 447
     OR (SELECT count(DISTINCT (class_id, contact_id)) FROM k56_members) <> 447
     OR EXISTS (SELECT 1 FROM k56_scope AS scope WHERE NOT EXISTS
         (SELECT 1 FROM k56_members AS member WHERE member.class_id=scope.class_id))
     OR (SELECT count(*) FROM k56_expected) <> 1341
     OR (SELECT count(*) FROM mapping.erp_class_membership_snapshot
         WHERE sync_run_id=105) <> 510 THEN
    RAISE EXCEPTION 'K56_SCOPE_OR_MEMBERS_CHANGED';
  END IF;
  IF (SELECT count(*) FROM assessment_k56.test_definition
      WHERE slug IN ('term-test-1-k56','term-test-2-k56','mini-test-k56')
        AND is_active=true) <> 3
     OR (SELECT count(*) FROM assessment_k56.term_test_roster) <> 1341
     OR (SELECT count(*) FROM assessment_k56.term_test_roster
         WHERE is_eligible=true) <> 1341
     OR EXISTS (SELECT test_slug, class_id, contact_id FROM k56_expected
                EXCEPT SELECT test_slug, erp_course_class_id,
                  erp_student_contact_id FROM assessment_k56.term_test_roster)
     OR EXISTS (SELECT test_slug, erp_course_class_id,
                  erp_student_contact_id FROM assessment_k56.term_test_roster
                EXCEPT SELECT test_slug, class_id, contact_id FROM k56_expected)
     OR (SELECT count(*) FROM assessment_k56.term_test_class_access) <> 3
     OR (SELECT count(*) FROM assessment_k56.term_test_class_access
         WHERE erp_course_class_id=1252 AND enabled=true) <> 3
     OR (SELECT count(*) FROM assessment.term_test_roster) <> 46 THEN
    RAISE EXCEPTION 'K56_ROSTER_GATE_OR_K67_CHANGED';
  END IF;
END $gate$;
INSERT INTO assessment_k56.term_test_class_access
  (test_slug, erp_course_class_id, enabled, source)
SELECT slug.test_slug, scope.class_id, true, 'k56_erp_ongoing_sync'
FROM (VALUES ('term-test-1-k56'), ('term-test-2-k56'),
             ('mini-test-k56')) AS slug(test_slug)
CROSS JOIN k56_scope AS scope
WHERE scope.class_id <> 1252;
DO $post$
BEGIN
  IF (SELECT count(*) FROM assessment_k56.term_test_class_access) <> 87
     OR (SELECT count(*) FROM assessment_k56.term_test_class_access
         WHERE enabled=true) <> 87
     OR (SELECT count(DISTINCT erp_course_class_id)
         FROM assessment_k56.term_test_class_access) <> 29
     OR (SELECT count(*) FROM assessment.term_test_roster) <> 46 THEN
    RAISE EXCEPTION 'K56_ACCESS_TRANSACTION_READBACK_FAILED';
  END IF;
END $post$;
SELECT json_build_object('enabledPairs',
  (SELECT count(*) FROM assessment_k56.term_test_class_access WHERE enabled=true),
  'classes',(SELECT count(DISTINCT erp_course_class_id)
             FROM assessment_k56.term_test_class_access),
  'rosterRows',(SELECT count(*) FROM assessment_k56.term_test_roster),
  'k67Roster',(SELECT count(*) FROM assessment.term_test_roster))::text;
''' + ending
    mutation_attempted = True
    transaction = psql(sql, 'ACCESS_TRANSACTION_FAILED')
    tx_line = next((line for line in transaction.splitlines()
                    if line.startswith('{') and 'enabledPairs' in line), None)
    if tx_line is None or json.loads(tx_line) != {
            'enabledPairs': 87, 'classes': 29,
            'rosterRows': 1341, 'k67Roster': 46}:
        raise RuntimeError('ACCESS_TRANSACTION_OUTPUT_INVALID')
    after = json.loads(psql("SELECT json_build_object("
        "'enabled',(SELECT count(*) FROM assessment_k56.term_test_class_access "
        "WHERE enabled=true),"
        "'classes',(SELECT count(DISTINCT erp_course_class_id) "
        "FROM assessment_k56.term_test_class_access),"
        "'roster',(SELECT count(*) FROM assessment_k56.term_test_roster),"
        "'k67Roster',(SELECT count(*) FROM assessment.term_test_roster))::text;",
        'ACCESS_COMMIT_READBACK_FAILED'))
    expected_after = {'enabled': 87 if deploy else 3,
                      'classes': 29 if deploy else 1,
                      'roster': 1341, 'k67Roster': 46}
    if after != expected_after:
        raise RuntimeError('ACCESS_POST_TRANSACTION_READBACK_FAILED')
    smoke = None
    if deploy:
        checked = 0
        for row in by_class:
            for slug in ('term-test-1-k56','term-test-2-k56','mini-test-k56'):
                status, body = get_roster(row['class'], slug)
                if (status != 200 or not isinstance(body.get('students'), list)
                        or len(body['students']) != row['count']):
                    raise RuntimeError('HTTP_ROSTER_MISMATCH')
                checked += 1
        hidden, _ = get_roster('IC2322', 'term-test-1')
        absent, _ = get_roster('IC0000', 'term-test-1-k56')
        if checked != 87 or hidden != 404 or absent != 404:
            raise RuntimeError('HTTP_ISOLATION_MISMATCH')
        smoke = {'rosterEndpoints': checked, 'ic2322': True, 'ic2326': True,
                 'k67SlugStatus': hidden, 'unknownClassStatus': absent}
    k67_after = inspect('mapping-review-api')
    if (k67_after['Image'] != k67['Image']
            or k67_after['State'].get('Health', {}).get('Status') != 'healthy'):
        raise RuntimeError('K67_SERVICE_CHANGED')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': ('all_k56_classes_enabled_verified'
                                          if deploy else 'all_k56_classes_rollback_dry_run'),
                      'syncRunId': 105, 'transactionReadback': json.loads(tx_line),
                      'persistentReadback': after, 'httpSmoke': smoke,
                      'k67ImageUnchanged': True,
                      'productionWrites': 84 if deploy else 0}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'mutationAttempted': mutation_attempted,
                      'persistentOutcome': 'unknown_if_mutation_attempted'}),
          file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deploy", action="store_true")
    args = parser.parse_args()
    script = REMOTE_SCRIPT.replace("__DEPLOY__", "True" if args.deploy else "False")
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=180)
        stdin.write(script)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                report = json.loads(error)
            except (ValueError, TypeError):
                report = {"toolOutcome": "failure", "errorCode": "ACCESS_REMOTE_FAILED"}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        expected = ("all_k56_classes_enabled_verified" if args.deploy
                    else "all_k56_classes_rollback_dry_run")
        if report.get("businessOutcome") != expected:
            raise RuntimeError("ACCESS_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
