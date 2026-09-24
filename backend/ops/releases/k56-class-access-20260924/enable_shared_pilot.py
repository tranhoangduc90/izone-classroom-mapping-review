"""Bật đúng ba cổng lớp IC2264 trong kho chung sau khi đối soát UUID."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: snapshot ERP 105, 36 UUID pilot cũ, backup và canary kín.
# Việc chính: so từng cặp slug–contact–UUID rồi bật ba cổng trong một giao dịch.
# Kết quả: canary thấy IC2264, lớp khác vẫn đóng; API công khai vẫn ở kho cũ.
# Khi lỗi: không chuyển API; báo rõ mutation đã thử để đọc lại trước rollback.
import hashlib
import json
from pathlib import Path
import subprocess
import sys

slugs = ('term-test-1-k56', 'term-test-2-k56', 'mini-test-k56')
pilot_id = '1252'
sync_id = '105'
backup_dir = Path('/opt/backups/k56-shared-cutover-yy5v09Z2')
backup_hashes = {
    'mapping_db-before-k56.dump': '0b186845321309a4e57ab9e641749c92bf8705bd129f8e842197a0f2c35bb49e',
    'k56-separate-before-cutover.dump': '31355f4de1ee6f655c10704c565d739bfe70c212109d5a263e3555e2b4f3d5b1',
}
mutation_attempted = False

def run(args, input_text=None, code='COMMAND_FAILED'):
    result = subprocess.run(args, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=60, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

def psql(container, database, sql, code):
    command = ['docker', 'exec', '-i', container, 'sh', '-lc',
               'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ' + database]
    return run(command, sql + '\n', code)

try:
    for filename, expected in backup_hashes.items():
        target = backup_dir / filename
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise RuntimeError('PILOT_BACKUP_NOT_VERIFIED')
    if run(['docker', 'inspect', '--format', '{{.Image}}', 'izone-k56-ic2264-api'],
           code='PUBLIC_API_INSPECT_FAILED') != 'sha256:2a00b0bf3593ebb15214cf30d2d1b9df1d84354a541c1841c093438a51bd1f8e':
        raise RuntimeError('PUBLIC_API_CHANGED_BEFORE_PILOT')
    canary = json.loads(run(['docker', 'inspect',
                             'izone-k56-shared-api-profile-canary-20260924'],
                            code='PROFILE_CANARY_MISSING'))[0]
    if (canary['Image'] != 'sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7'
            or canary['State']['Status'] != 'running'
            or any(value for value in
                   (canary['NetworkSettings'].get('Ports') or {}).values())):
        raise RuntimeError('PROFILE_CANARY_NOT_SAFE')
    shared = json.loads(psql('mapping-postgres', 'mapping_db',
        "SELECT json_build_object("
        "'latest', (SELECT run.id::text FROM mapping.sync_run AS run "
        "WHERE run.source='n8n_k56_erp_ongoing' ORDER BY run.id DESC LIMIT 1),"
        "'pilotMappings', (SELECT count(*) FROM mapping.classroom_course_mapping "
        "WHERE erp_course_class_id=1252 AND upper(erp_class_name_snapshot)='IC2264'),"
        "'eligible', (SELECT json_agg(erp_student_contact_id::text "
        "ORDER BY erp_student_contact_id) FROM mapping.erp_class_membership_snapshot "
        "WHERE sync_run_id=105 AND erp_course_class_id=1252 "
        "AND source_state='active' AND registration_status='on_going'),"
        "'roster', (SELECT json_agg(json_build_object('slug',test_slug,"
        "'contact',erp_student_contact_id::text,'ref',student_ref::text) "
        "ORDER BY test_slug,erp_student_contact_id) "
        "FROM assessment_k56.term_test_roster WHERE erp_course_class_id=1252),"
        "'access', (SELECT count(*) FROM assessment_k56.term_test_class_access),"
        "'attempts', (SELECT count(*) FROM assessment_k56.term_test_attempt),"
        "'k67Roster', (SELECT count(*) FROM assessment.term_test_roster))::text;",
        'PILOT_SHARED_PREFLIGHT_FAILED'))
    old = json.loads(psql('izone-k56-demo-k56-demo-db-1',
        'izone_mapping_k56_ic2264',
        "SELECT json_build_object('roster', "
        "(SELECT json_agg(json_build_object('slug',test_slug,"
        "'contact',erp_student_contact_id::text,'ref',student_ref::text) "
        "ORDER BY test_slug,erp_student_contact_id) "
        "FROM assessment.term_test_roster),"
        "'attempts',(SELECT count(*) FROM assessment.term_test_attempt))::text;",
        'PILOT_OLD_PREFLIGHT_FAILED'))
    eligible = shared['eligible'] or []
    roster = shared['roster'] or []
    old_roster = old['roster'] or []
    expected_keys = {(slug, contact) for slug in slugs for contact in eligible}
    actual_keys = {(row['slug'], row['contact']) for row in roster}
    if (shared['latest'] != sync_id or shared['pilotMappings'] != 1
            or len(eligible) != 12 or len(set(eligible)) != 12
            or len(roster) != 36 or len(actual_keys) != 36
            or actual_keys != expected_keys
            or roster != old_roster
            or shared['access'] != 0 or shared['attempts'] != 0
            or shared['k67Roster'] != 46 or old['attempts'] != 0):
        raise RuntimeError('PILOT_IDENTITY_OR_SCOPE_MISMATCH')
    sql = '''BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE assessment_k56.term_test_roster,
  assessment_k56.term_test_class_access IN SHARE ROW EXCLUSIVE MODE;
DO $pilot$
BEGIN
  IF (SELECT run.id::text FROM mapping.sync_run AS run
      WHERE run.source='n8n_k56_erp_ongoing'
      ORDER BY run.id DESC LIMIT 1) <> '105'
     OR (SELECT count(*) FROM assessment_k56.term_test_roster
         WHERE erp_course_class_id=1252 AND is_eligible=true) <> 36
     OR (SELECT count(*) FROM assessment_k56.term_test_class_access) <> 0
     OR (SELECT count(*) FROM assessment_k56.term_test_attempt) <> 0
     OR (SELECT count(*) FROM assessment.term_test_roster) <> 46 THEN
    RAISE EXCEPTION 'PILOT_GATE_PREFLIGHT_CHANGED';
  END IF;
END $pilot$;
INSERT INTO assessment_k56.term_test_class_access
  (test_slug, erp_course_class_id, enabled, source)
VALUES
  ('term-test-1-k56',1252,true,'k56_erp_ongoing_sync'),
  ('term-test-2-k56',1252,true,'k56_erp_ongoing_sync'),
  ('mini-test-k56',1252,true,'k56_erp_ongoing_sync');
DO $post$
BEGIN
  IF (SELECT count(*) FROM assessment_k56.term_test_class_access
      WHERE erp_course_class_id=1252 AND enabled=true) <> 3
     OR (SELECT count(*) FROM assessment_k56.term_test_class_access) <> 3 THEN
    RAISE EXCEPTION 'PILOT_GATE_READBACK_MISMATCH';
  END IF;
END $post$;
COMMIT;
'''
    mutation_attempted = True
    psql('mapping-postgres', 'mapping_db', sql, 'PILOT_GATE_TRANSACTION_FAILED')
    after = json.loads(psql('mapping-postgres', 'mapping_db',
        "SELECT json_build_object("
        "'pilotEnabled',(SELECT count(*) FROM assessment_k56.term_test_class_access "
        "WHERE erp_course_class_id=1252 AND enabled=true),"
        "'allAccess',(SELECT count(*) FROM assessment_k56.term_test_class_access),"
        "'k56Attempts',(SELECT count(*) FROM assessment_k56.term_test_attempt),"
        "'k67Roster',(SELECT count(*) FROM assessment.term_test_roster))::text;",
        'PILOT_GATE_READBACK_FAILED'))
    if after != {'pilotEnabled': 3, 'allAccess': 3,
                 'k56Attempts': 0, 'k67Roster': 46}:
        raise RuntimeError('PILOT_GATE_POSTCOMMIT_MISMATCH')
    smoke_js = r'''
// Chỉ trả status và số học viên; không in roster.
const base='http://127.0.0.1:8788/api/term-tests/roster?class=';
const result={};
for (const slug of ['term-test-1-k56','term-test-2-k56','mini-test-k56']) {
  const response=await fetch(base+'IC2264&test='+slug);
  const body=await response.json();
  if (response.status!==200 || !Array.isArray(body.students)
      || body.students.length!==12) throw new Error('PILOT_HTTP_MISMATCH');
  result[slug]={status:response.status,students:body.students.length};
}
for (const [key,slug] of [['newClass','term-test-1-k56'],
                           ['k67','term-test-1']]) {
  const response=await fetch(base+'IC2322&test='+slug);
  if (response.status!==404) throw new Error(key+'_NOT_CLOSED');
  result[key]={status:response.status};
}
process.stdout.write(JSON.stringify(result)+'\n');
'''
    smoke = json.loads(run(['docker', 'exec', '-i',
                            'izone-k56-shared-api-profile-canary-20260924',
                            'node', '--input-type=module', '-'],
                           smoke_js, 'PILOT_CANARY_HTTP_FAILED'))
    if (len(smoke) != 5 or any(smoke[slug] != {'status': 200, 'students': 12}
                               for slug in slugs)
            or smoke['newClass'] != {'status': 404}
            or smoke['k67'] != {'status': 404}):
        raise RuntimeError('PILOT_CANARY_HTTP_MISMATCH')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'pilot_access_enabled_canary_verified',
                      'syncRunId': sync_id, 'pilotClass': 'IC2264',
                      'uuidPreserved': 36, 'enabledClassTestPairs': 3,
                      'canaryHttp': smoke, 'k67Roster': 46,
                      'publicApiChanged': False,
                      'productionDatabaseWrites': 3}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'mutationAttempted': mutation_attempted,
                      'publicApiChanged': False}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=90)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                report = json.loads(error)
                code = report.get("errorCode", "PILOT_GATE_FAILED")
                attempted = report.get("mutationAttempted", False)
            except (ValueError, TypeError):
                code, attempted = "PILOT_GATE_FAILED", True
            print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                              "mutationAttempted": attempted}), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "pilot_access_enabled_canary_verified":
            raise RuntimeError("PILOT_GATE_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
