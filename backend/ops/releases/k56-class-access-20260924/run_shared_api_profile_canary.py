"""Kiểm cấu hình K56 thật trên image mới, vẫn không xuất bản cổng mạng."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: runtime.env K56 hiện có và db-url.env role K56 riêng.
# Việc chính: chạy canary profile k56-ic2264 trên mạng nội bộ, tắt mọi webhook.
# Kết quả: xác nhận flags, role/database, health và cổng lớp chưa mở.
# Khi lỗi: không thay API production hoặc quyền lớp, giữ canary để điều tra.
import json
from pathlib import Path
import subprocess
import sys
import time

name = 'izone-k56-shared-api-profile-canary-20260924'
image = 'izone-k56-live-results:20260924.2-shared-db'
image_id = 'sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7'
old_image_id = 'sha256:2a00b0bf3593ebb15214cf30d2d1b9df1d84354a541c1841c093438a51bd1f8e'
runtime_env = Path('/opt/izone-k56-pilot/runtime.env')
db_env = Path('/opt/izone-k56-shared-db-20260924/db-url.env')

def run(args, code, input_text=None):
    result = subprocess.run(args, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

try:
    if not runtime_env.is_file() or not db_env.is_file():
        raise RuntimeError('ENV_FILE_MISSING')
    if (runtime_env.stat().st_mode & 0o077) != 0 or (db_env.stat().st_mode & 0o077) != 0:
        raise RuntimeError('ENV_FILE_PERMISSIONS_UNSAFE')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
           'CANDIDATE_IMAGE_MISSING') != image_id:
        raise RuntimeError('CANDIDATE_IMAGE_CHANGED')
    if run(['docker', 'inspect', '--format', '{{.Image}}', 'izone-k56-ic2264-api'],
           'PRODUCTION_API_MISSING') != old_image_id:
        raise RuntimeError('PRODUCTION_API_CHANGED')
    exists = subprocess.run(['docker', 'inspect', name],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=10, check=False)
    if exists.returncode == 0:
        prior = json.loads(run(['docker', 'inspect', name],
                               'PRIOR_PROFILE_CANARY_INSPECT_FAILED'))[0]
        ports = prior['NetworkSettings'].get('Ports') or {}
        if (prior['Name'] != '/' + name or prior['Image'] != image_id
                or prior['State']['Status'] != 'exited'
                or any(value for value in ports.values())):
            raise RuntimeError('PROFILE_CANARY_ALREADY_EXISTS')
        run(['docker', 'rm', name], 'PRIOR_PROFILE_CANARY_REMOVE_FAILED')
    canary_id = run([
        'docker', 'run', '-d', '--name', name, '--restart', 'no',
        '--network', 'mapping-api-net', '--volumes-from', 'izone-k56-ic2264-api:ro',
        '--read-only', '--tmpfs', '/tmp:rw,size=16m',
        '--env-file', str(runtime_env), '--env-file', str(db_env),
        '-e', 'DEPLOYMENT_PROFILE=k56-ic2264',
        '-e', 'TERM_TEST_NOTIFY_URL=', '-e', 'TERM_TEST_NOTIFY_SECRET=',
        '-e', 'WRITING_TEST_SYNC_SECRET=',
        '-e', 'APP_VERSION=k56-shared-profile-canary-20260924',
        image], 'PROFILE_CANARY_START_FAILED')
    if len(canary_id) != 64:
        raise RuntimeError('PROFILE_CANARY_ID_INVALID')
    smoke_js = r'''
// Dữ liệu vào: env của canary và HTTP localhost của nó.
// Việc chính: xác nhận flags Portal, role schema và ba cổng đóng.
// Kết quả: chỉ boolean/status, không in URL kết nối hoặc danh tính học viên.
// Khi lỗi: dừng phát hành.
import { loadConfig } from '/app/src/config.js';
const config = loadConfig();
const endpoint = new URL(config.databaseUrl);
if (config.deploymentProfileName !== 'k56-ic2264'
    || config.demoIsolatedMode !== false
    || config.k56PortalPilotEnabled !== true
    || endpoint.hostname !== 'mapping-postgres'
    || endpoint.username !== 'k56_shared_api'
    || endpoint.pathname !== '/mapping_db') throw new Error('PROFILE_CONFIG_MISMATCH');
const base = 'http://127.0.0.1:' + config.port;
const health = await fetch(base + '/health');
const body = await health.json();
if (health.status !== 200 || body.deploymentProfile !== 'k56-ic2264') {
  throw new Error('PROFILE_HEALTH_MISMATCH');
}
const statuses = {};
for (const [name, classCode, test] of [
  ['pilotClosed', 'IC2264', 'term-test-1-k56'],
  ['newClassClosed', 'IC2322', 'term-test-1-k56'],
  ['k67Hidden', 'IC2322', 'term-test-1'],
]) {
  const response = await fetch(base + '/api/term-tests/roster?class='
    + encodeURIComponent(classCode) + '&test=' + encodeURIComponent(test));
  if (response.status !== 404) throw new Error(name + '_NOT_CLOSED');
  statuses[name] = response.status;
}
process.stdout.write(JSON.stringify({profile: body.deploymentProfile,
  portalFlag: config.k56PortalPilotEnabled, databaseRole: endpoint.username,
  health: health.status, statuses}) + '\n');
'''
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
    expected = {'profile': 'k56-ic2264', 'portalFlag': True,
                'databaseRole': 'k56_shared_api', 'health': 200,
                'statuses': {'pilotClosed': 404, 'newClassClosed': 404,
                             'k67Hidden': 404}}
    if smoke != expected:
        raise RuntimeError('PROFILE_CANARY_SMOKE_FAILED')
    inspected = json.loads(run(['docker', 'inspect', name],
                               'PROFILE_CANARY_INSPECT_FAILED'))[0]
    if any(value for value in (inspected['NetworkSettings'].get('Ports') or {}).values()):
        raise RuntimeError('PROFILE_CANARY_PORT_PUBLISHED')
    if run(['docker', 'inspect', '--format', '{{.Image}}',
            'izone-k56-ic2264-api'], 'PRODUCTION_API_READBACK_FAILED') != old_image_id:
        raise RuntimeError('PRODUCTION_API_CHANGED_DURING_CANARY')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'production_profile_canary_isolated',
                      'canaryName': name, 'canaryIdPrefix': canary_id[:12],
                      'smoke': smoke, 'productionApiChanged': False,
                      'publicPortPublished': False,
                      'failedPrivateCanaryRemoved': exists.returncode == 0}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'productionApiChanged': False}), file=sys.stderr)
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
                code = json.loads(error).get("errorCode", "PROFILE_CANARY_FAILED")
            except (ValueError, TypeError):
                code = "PROFILE_CANARY_FAILED"
            print(json.dumps({"toolOutcome": "failure", "errorCode": code}),
                  file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "production_profile_canary_isolated":
            raise RuntimeError("PROFILE_CANARY_READBACK_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
