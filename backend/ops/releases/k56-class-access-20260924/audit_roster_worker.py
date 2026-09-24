"""Đọc trạng thái đối soát K56 sau phát hành, không xuất log hoặc hồ sơ thô."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: service K56/K67, checkpoint và log 15 phút gần nhất.
# Việc chính: chỉ đếm sự kiện thành công/lỗi của bộ đối soát và đọc số liệu.
# Kết quả: metadata đủ xác nhận một nhịp làm việc, không in log thô.
# Khi lỗi: trả mã lỗi, không kết luận hệ thống ổn định.
import json
import subprocess
import sys

def run(args, code, input_text=None):
    result = subprocess.run(args, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip(), result.stderr.strip()

try:
    k56, _ = run(['docker','inspect','--format',
       '{{.Image}}|{{.State.Health.Status}}|{{.RestartCount}}',
       'izone-k56-ic2264-api'], 'K56_INSPECT_FAILED')
    k67, _ = run(['docker','inspect','--format',
       '{{.Image}}|{{.State.Health.Status}}|{{.RestartCount}}',
       'mapping-review-api'], 'K67_INSPECT_FAILED')
    # Đọc tên image và thời điểm tạo container để nhận diện phát hành song song.
    # Chỉ là metadata; không xem biến môi trường hoặc dữ liệu học viên.
    k67_release, _ = run(['docker','inspect','--format',
       '{{.Config.Image}}|{{.Created}}', 'mapping-review-api'],
       'K67_RELEASE_INSPECT_FAILED')
    stdout_log, stderr_log = run(['docker','logs','--since','15m','izone-k56-ic2264-api'],
                                 'K56_LOG_READ_FAILED')
    log = stdout_log + '\n' + stderr_log
    events = [line for line in log.splitlines() if 'Đã đối soát quyền thi K56:' in line]
    errors = [line for line in log.splitlines()
              if 'Đối soát quyền thi K56 cần kiểm tra:' in line]
    sql = "SELECT json_build_object(" + \
      "'checkpoint',(SELECT last_sync_run_id::text FROM " + \
      "assessment_k56.k56_roster_sync_checkpoint " + \
      "WHERE source_name='n8n_k56_erp_ongoing')," + \
      "'roster',(SELECT count(*) FROM assessment_k56.term_test_roster)," + \
      "'access',(SELECT count(*) FROM assessment_k56.term_test_class_access WHERE enabled)," + \
      "'attempts',(SELECT count(*) FROM assessment_k56.term_test_attempt)," + \
      "'k67Roster',(SELECT count(*) FROM assessment.term_test_roster))::text;"
    body, _ = run(['docker','exec','-i','mapping-postgres','sh','-lc',
      'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db'],
      'COUNTS_READ_FAILED', sql)
    print(json.dumps({'toolOutcome':'success','businessOutcome':'read_only_worker_audit',
      'k56':k56.split('|'),'k67':k67.split('|'),
      'k67Release':k67_release.split('|'),
      'successfulEventsLast15m':len(events),'errorEventsLast15m':len(errors),
      'errorCodes':sorted({line.rsplit(':',1)[-1].strip() for line in errors}),
      'counts':json.loads(body),'productionWrites':0}))
except Exception as exc:
    code = str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome':'failure','errorCode':code}),file=sys.stderr)
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=60)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        if stdout.channel.recv_exit_status() != 0:
            try:
                report = json.loads(error)
            except (ValueError, TypeError):
                report = {"toolOutcome":"failure","errorCode":"AUDIT_REMOTE_FAILED"}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "read_only_worker_audit":
            raise RuntimeError("AUDIT_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
