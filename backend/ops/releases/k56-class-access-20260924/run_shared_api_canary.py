"""Chạy API K56 kín trên mạng kho chung; không đổi URL hoặc container công khai."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: image K56 đã khóa SHA và role riêng chỉ thấy assessment_k56.
# Việc chính: chạy API canary không mở cổng công khai, thử health và lớp còn đóng.
# Kết quả: HTTP/DB thực tế; service production và quyền lớp không đổi.
# Khi lỗi: giữ canary để điều tra, không tự chuyển production.
import json
from pathlib import Path
import subprocess
import sys
import time

image = 'izone-k56-live-results:20260924.2-shared-db'
image_id = 'sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7'
name = 'izone-k56-shared-api-canary-20260924'
secret_file = Path('/opt/izone-k56-shared-db-20260924/db-url.env')
old_image_id = 'sha256:2a00b0bf3593ebb15214cf30d2d1b9df1d84354a541c1841c093438a51bd1f8e'
previous_canary_image_id = 'sha256:c048bc0afd7baf659fe2db616b3a19167933694e0bcf826aa24c836458794183'

def run(args, code, input_text=None):
    result = subprocess.run(args, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=45, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

try:
    if (not secret_file.is_file()
            or (secret_file.stat().st_mode & 0o077) != 0):
        raise RuntimeError('DATABASE_SECRET_FILE_UNSAFE')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
           'CANDIDATE_IMAGE_MISSING') != image_id:
        raise RuntimeError('CANDIDATE_IMAGE_CHANGED')
    if run(['docker', 'inspect', '--format', '{{.Image}}', 'izone-k56-ic2264-api'],
           'PRODUCTION_API_MISSING') != old_image_id:
        raise RuntimeError('PRODUCTION_API_CHANGED_BEFORE_CANARY')
    exists = subprocess.run(['docker', 'inspect', name],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=10, check=False)
    if exists.returncode == 0:
        previous = json.loads(run(['docker', 'inspect', name],
                                  'PREVIOUS_CANARY_INSPECT_FAILED'))[0]
        published = previous['NetworkSettings'].get('Ports') or {}
        if (previous['Image'] != previous_canary_image_id
                or previous['Name'] != '/' + name
                or any(value for value in published.values())):
            raise RuntimeError('CANARY_IDENTITY_CHANGED')
        run(['docker', 'stop', '--time', '10', name],
            'PREVIOUS_CANARY_STOP_FAILED')
        run(['docker', 'rm', name], 'PREVIOUS_CANARY_REMOVE_FAILED')
    env_lines = json.loads(run(['docker', 'inspect', '--format',
                                '{{json .Config.Env}}', 'izone-k56-ic2264-api'],
                               'PRODUCTION_ENV_UNAVAILABLE'))
    client_ids = [line.split('=', 1)[1] for line in env_lines
                  if line.startswith('GOOGLE_CLIENT_ID=')]
    if len(client_ids) != 1 or not client_ids[0]:
        raise RuntimeError('GOOGLE_CLIENT_ID_MISSING')
    canary_id = run([
        'docker', 'run', '-d', '--name', name, '--restart', 'no',
        '--network', 'mapping-api-net', '--env-file', str(secret_file),
        '-e', 'NODE_ENV=production', '-e', 'DEPLOYMENT_PROFILE=k56-demo',
        '-e', 'AUTH_MODE=google', '-e', 'GOOGLE_CLIENT_ID=' + client_ids[0],
        '-e', 'DB_POOL_MAX=2', '-e', 'APP_VERSION=k56-shared-db-canary-20260924',
        image], 'CANARY_START_FAILED')
    if len(canary_id) != 64:
        raise RuntimeError('CANARY_ID_INVALID')
    smoke_js = r'''
// Dữ liệu vào: API canary chỉ trên localhost container.
// Việc chính: kiểm profile, lớp K56 chưa mở và slug K67 không lọt vào.
// Kết quả: chỉ status/error, không xuất roster hoặc token.
// Khi lỗi: exit khác 0 để cổng phát hành dừng.
const base = 'http://127.0.0.1:8788';
const health = await fetch(base + '/health');
const body = await health.json();
if (health.status !== 200 || body.ok !== true
    || body.deploymentProfile !== 'k56-demo') throw new Error('HEALTH_WRONG_PROFILE');
const cases = [
  ['k56Closed', 'IC2322', 'term-test-1-k56'],
  ['k67Hidden', 'IC2322', 'term-test-1'],
];
const result = {health: health.status, profile: body.deploymentProfile};
for (const [label, classCode, test] of cases) {
  const response = await fetch(base + '/api/term-tests/roster?class='
    + encodeURIComponent(classCode) + '&test=' + encodeURIComponent(test));
  const payload = await response.json();
  if (response.status !== 404 || payload.ok !== false) {
    throw new Error(label + '_NOT_CLOSED');
  }
  result[label] = response.status;
}
process.stdout.write(JSON.stringify(result) + '\n');
'''
    last_error = 'CANARY_HEALTH_TIMEOUT'
    smoke = None
    for _ in range(15):
        time.sleep(1)
        process = subprocess.run([
            'docker', 'exec', '-i', name, 'node', '--input-type=module', '-'],
            input=smoke_js, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=15, check=False)
        if process.returncode == 0:
            smoke = json.loads(process.stdout.strip())
            break
        last_error = 'CANARY_SMOKE_FAILED'
    if smoke is None:
        raise RuntimeError(last_error)
    if smoke != {'health': 200, 'profile': 'k56-demo',
                 'k56Closed': 404, 'k67Hidden': 404}:
        raise RuntimeError('CANARY_SMOKE_MISMATCH')
    if run(['docker', 'inspect', '--format', '{{.Image}}',
            'izone-k56-ic2264-api'], 'PRODUCTION_API_READBACK_FAILED') != old_image_id:
        raise RuntimeError('PRODUCTION_API_CHANGED_DURING_CANARY')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'private_canary_closed_and_isolated',
                      'canaryName': name, 'canaryIdPrefix': canary_id[:12],
                      'http': smoke, 'productionApiChanged': False,
                      'publicPortPublished': False,
                      'previousPrivateCanaryRemoved': exists.returncode == 0}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'productionApiChanged': False}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    # Dữ liệu vào: SSH credential trong Credential Manager, script canary không secret.
    # Việc chính: gửi script qua stdin, đọc báo cáo gọn.
    # Kết quả: chưa phát hành API; chỉ chứng minh đường kho chung.
    # Khi lỗi: trả trạng thái thất bại, không in env hoặc response chứa học viên.
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
                code = report.get("errorCode", "CANARY_FAILED")
            except (ValueError, TypeError):
                code = "CANARY_FAILED"
            print(json.dumps({"toolOutcome": "failure", "errorCode": code}),
                  file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "private_canary_closed_and_isolated":
            raise RuntimeError("CANARY_READBACK_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
