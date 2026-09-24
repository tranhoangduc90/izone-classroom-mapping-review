"""Chỉ đọc đường Pages → proxy → container cho ba bài K56."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: URL Pages công khai, ba prefix API và metadata Docker/Nginx.
# Việc chính: đối chiếu nơi trình duyệt gọi với service thực, không đọc roster.
# Kết quả: chỉ profile/status/image/port và dòng proxy_pass đã lọc.
# Khi lỗi: trả mã, không xuất full Nginx hoặc biến môi trường.
import json
import re
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import urlopen

def run(args, code):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout

def request(url):
    try:
        with urlopen(url, timeout=12) as response:
            status = response.status
            body = response.read().decode('utf-8', 'replace')
    except HTTPError as exc:
        status = exc.code
        body = exc.read().decode('utf-8', 'replace')
    return status, body

try:
    containers = {}
    for name in ('izone-k56-ic2264-api', 'izone-k56-demo-k56-demo-api-1',
                 'mapping-review-api'):
        item = json.loads(run(['docker', 'inspect', name],
                              'DOCKER_INSPECT_FAILED'))[0]
        env = {line.split('=', 1)[0]: line.split('=', 1)[1]
               for line in item['Config'].get('Env') or [] if '=' in line}
        containers[name] = {
            'imageId': item['Image'],
            'imageTag': item['Config']['Image'],
            'profile': env.get('DEPLOYMENT_PROFILE'),
            'ports': sorted(str(binding.get('HostPort'))
                for values in (item['NetworkSettings'].get('Ports') or {}).values()
                for binding in (values or [])),
            'networks': sorted(item['NetworkSettings']['Networks']),
            'health': item['State'].get('Health', {}).get('Status'),
        }
    public = {}
    for prefix in ('mapping-api-demo', 'mapping-api-k56', 'mapping-api'):
        health_status, health_body = request(
            'https://ducizone.ddns.net/' + prefix + '/health')
        roster_status, roster_body = request(
            'https://ducizone.ddns.net/' + prefix
            + '/api/term-tests/roster?class=IC2322&test=term-test-1-k56')
        try:
            profile = json.loads(health_body).get('deploymentProfile')
        except (ValueError, TypeError):
            profile = None
        try:
            roster = json.loads(roster_body)
            student_count = (len(roster.get('students'))
                             if isinstance(roster.get('students'), list) else None)
            error_code = roster.get('error')
        except (ValueError, TypeError):
            student_count, error_code = None, None
        public[prefix] = {'health': health_status, 'profile': profile,
                          'roster': roster_status, 'studentCount': student_count,
                          'errorCode': error_code}
    page_status, page_config = request(
        'https://tranhoangduc90.github.io/izone-ai-team-pages/'
        'term-tests/k56-shared/config.js')
    match = re.search(r"API_BASE_URL:[^\n]*['\"](https://[^'\"]+)['\"]",
                      page_config)
    nginx_routes = []
    try:
        nginx = run(['nginx', '-T'], 'NGINX_CONFIG_READ_FAILED')
    except RuntimeError:
        nginx = ''
    lines = nginx.splitlines()
    for index, line in enumerate(lines):
        if 'location ' in line and any(key in line for key in
                                      ('mapping-api-demo', 'mapping-api-k56',
                                       'mapping-api ')):
            nearby = [part.strip() for part in lines[index:index + 15]
                      if 'proxy_pass ' in part or 'location ' in part]
            nginx_routes.append(nearby[:3])
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'read_only_public_route_audit',
                      'containers': containers, 'public': public,
                      'pageConfigStatus': page_status,
                      'pageApiBase': match.group(1) if match else None,
                      'nginxRoutes': nginx_routes[:6],
                      'productionWrites': 0}))
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
                report = {"toolOutcome": "failure", "errorCode": "ROUTING_AUDIT_FAILED"}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "read_only_public_route_audit":
            raise RuntimeError("ROUTING_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
