"""Chạy bộ đối soát K56 trên kho thật nhưng rollback, không thay API công khai."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: image đã thử đầy đủ và role K56 trong env file riêng tư.
# Việc chính: chạy đối soát qua chính code ứng viên, luôn rollback.
# Kết quả: số đếm và trạng thái K67/API trước–sau, không xuất hồ sơ.
# Khi lỗi: container tạm tự xóa; không đổi service đang nhận bài.
import json
import subprocess
import sys
from pathlib import Path

image = 'izone-k56-live-results:20260924.4-roster-reconcile'
image_id = 'sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956'
current_id = 'sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7'
runtime_env = Path('/opt/izone-k56-pilot/runtime.env')
db_env = Path('/opt/izone-k56-shared-db-20260924/db-url.env')

def run(args, code, input_text=None, timeout=50):
    result = subprocess.run(args, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

def service_state(name):
    raw = run(['docker', 'inspect', '--format',
               '{{.Image}}|{{.State.Health.Status}}|{{.RestartCount}}', name],
              'SERVICE_INSPECT_FAILED')
    return raw.split('|')

try:
    if (not runtime_env.is_file() or not db_env.is_file()
            or runtime_env.stat().st_mode & 0o077
            or db_env.stat().st_mode & 0o077):
        raise RuntimeError('ENV_FILE_UNSAFE')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
           'IMAGE_INSPECT_FAILED') != image_id:
        raise RuntimeError('CANDIDATE_IMAGE_CHANGED')
    before_k56 = service_state('izone-k56-ic2264-api')
    before_k67 = service_state('mapping-review-api')
    if (before_k56[:2] != [current_id, 'healthy']
            or before_k67[1] != 'healthy'):
        raise RuntimeError('SERVICE_BASELINE_CHANGED')
    js = r'''
// Dữ liệu vào: role K56 từ env file và lượt ERP đã hoàn tất trong mapping_db.
// Việc chính: dùng chính code image ứng viên để ghi thử rồi rollback toàn giao dịch.
// Kết quả: chỉ số đếm và mã trạng thái; không in DATABASE_URL hoặc học viên.
// Khi lỗi: exit khác 0 để người triển khai kiểm và dừng cutover.
import { loadConfig } from '/app/src/config.js';
import { createDatabasePool } from '/app/src/db.js';
import { reconcileK56Roster } from '/app/src/k56-roster-reconcile.js';
const config = loadConfig();
if (config.deploymentProfileName !== 'k56-ic2264'
    || config.k56RosterReconcileEnabled) throw new Error('CANARY_PROFILE_INVALID');
const pool = createDatabasePool(config);
try {
  const diagnosticClient = await pool.connect();
  let lockError = null;
  try {
    await diagnosticClient.query('BEGIN');
    await diagnosticClient.query(`LOCK TABLE assessment.term_test_roster,
      assessment.term_test_class_access, assessment.k56_roster_sync_checkpoint
      IN SHARE ROW EXCLUSIVE MODE`);
    await diagnosticClient.query('ROLLBACK');
  } catch (error) {
    await diagnosticClient.query('ROLLBACK').catch(() => {});
    lockError = error.code || 'UNKNOWN';
  } finally { diagnosticClient.release(); }
  if (lockError) {
    process.stdout.write(JSON.stringify({businessOutcome: 'canary_lock_failed',
      errorCode: lockError}));
  } else {
    try {
      const result = await reconcileK56Roster(pool, {dryRun: true});
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      const diagnostic = (await pool.query(`WITH latest AS (
        SELECT id, class_names, row_count FROM mapping.sync_run
        WHERE source = 'n8n_k56_erp_ongoing' ORDER BY id DESC LIMIT 1)
        SELECT latest.row_count AS expected,
          count(*)::int AS all_rows,
          count(*) FILTER (WHERE upper(member.erp_class_name_snapshot)
            = ANY(latest.class_names))::int AS scoped_rows,
          count(*) FILTER (WHERE map.erp_course_class_id IS NULL)::int AS missing_mapping,
          count(*) FILTER (WHERE map.erp_course_class_id IS NOT NULL
            AND upper(map.erp_class_name_snapshot)
              <> upper(member.erp_class_name_snapshot))::int AS code_mismatch
        FROM latest JOIN mapping.erp_class_membership_snapshot AS member
          ON member.sync_run_id = latest.id
        LEFT JOIN mapping.classroom_course_mapping AS map
          ON map.erp_course_class_id = member.erp_course_class_id
        GROUP BY latest.row_count`)).rows[0];
      const latest = (await pool.query(`SELECT run.id::text AS id,
        run.class_names, run.row_count FROM mapping.sync_run AS run
        WHERE run.source='n8n_k56_erp_ongoing'
        ORDER BY run.id DESC LIMIT 1`)).rows[0];
      const mappingRows = (await pool.query(`SELECT erp_course_class_id::text AS class_id,
        upper(erp_class_name_snapshot) AS class_code
        FROM mapping.classroom_course_mapping
        WHERE upper(erp_class_name_snapshot) = ANY($1::text[])`,
      [latest.class_names.map(code => String(code).toUpperCase())])).rows;
      const memberRows = (await pool.query(`SELECT erp_course_class_id::text AS class_id,
        upper(erp_class_name_snapshot) AS class_code
        FROM mapping.erp_class_membership_snapshot WHERE sync_run_id=$1`,
      [latest.id])).rows;
      const classMap = new Map(mappingRows.map(row => [row.class_id, row.class_code]));
      diagnostic.jsMappingRows = mappingRows.length;
      diagnostic.jsMemberRows = memberRows.length;
      diagnostic.jsMismatches = memberRows.filter(row =>
        classMap.get(row.class_id) !== row.class_code).length;
      diagnostic.latestId = latest.id;
      diagnostic.idType = typeof latest.id;
      diagnostic.byParameter = (await pool.query(`SELECT count(*)::int AS n
        FROM mapping.erp_class_membership_snapshot WHERE sync_run_id=$1`,
      [latest.id])).rows[0].n;
      process.stdout.write(JSON.stringify({businessOutcome: 'canary_reconcile_failed',
        errorCode: error.code || 'UNKNOWN', diagnostic}));
    }
  }
} finally { await pool.end(); }
'''
    body = run(['docker', 'run', '--rm', '-i', '--restart', 'no',
                '--network', 'mapping-api-net', '--read-only',
                '--tmpfs', '/tmp:rw,size=16m',
                '--env-file', str(runtime_env), '--env-file', str(db_env),
                '-e', 'DEPLOYMENT_PROFILE=k56-ic2264',
                '-e', 'K56_ROSTER_RECONCILE_ENABLED=false',
                '--entrypoint', 'node', image, '--input-type=module', '-'],
               'K56_ROSTER_CANARY_FAILED', js, timeout=90)
    result = json.loads(body)
    if result.get('businessOutcome') in ('canary_lock_failed', 'canary_reconcile_failed'):
        code = str(result.get('errorCode', 'UNKNOWN'))
        if not code.replace('_', '').isalnum() or len(code) > 64:
            code = 'UNKNOWN'
        diagnostic = result.get('diagnostic') or {}
        counts = '-'.join(str(diagnostic.get(key, 'x'))
                          for key in ('expected', 'all_rows', 'scoped_rows',
                                      'missing_mapping', 'code_mismatch',
                                      'jsMappingRows', 'jsMemberRows', 'jsMismatches',
                                      'latestId', 'idType', 'byParameter'))
        raise RuntimeError(result['businessOutcome'].upper() + '_' + code + '_' + counts)
    if (result.get('businessOutcome') != 'rollback_dry_run_verified'
            or result.get('syncRunId') != '105'
            or result.get('classCount') != 29
            or result.get('eligibleStudents') != 447
            or result.get('rosterRowsAdded') != 0
            or result.get('classTestPairsEnabled') != 0
            or result.get('productionWrites') != 0):
        raise RuntimeError('K56_ROSTER_CANARY_RESULT_CHANGED')
    after_k56 = service_state('izone-k56-ic2264-api')
    after_k67 = service_state('mapping-review-api')
    if before_k56 != after_k56 or before_k67 != after_k67:
        raise RuntimeError('SERVICE_CHANGED_DURING_CANARY')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'live_rollback_canary_verified',
                      'result': result, 'k56ServiceUnchanged': True,
                      'k67ServiceUnchanged': True}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code}), file=sys.stderr)
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=120)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                report = json.loads(error)
            except (ValueError, TypeError):
                report = {"toolOutcome": "failure", "errorCode": "CANARY_REMOTE_FAILED"}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "live_rollback_canary_verified":
            raise RuntimeError("CANARY_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
