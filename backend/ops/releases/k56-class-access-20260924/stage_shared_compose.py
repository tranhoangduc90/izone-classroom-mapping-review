"""Đưa Compose override không chứa secret lên VPS và so cấu hình trước khi up."""

import hashlib
import json
from pathlib import Path
import sys

import paramiko
import win32cred


LOCAL_OVERLAY = Path(__file__).resolve().parent / "compose.ic2264.override.yml"
REMOTE_OVERLAY = "/opt/izone-k56-shared-db-20260924/compose.ic2264.override.yml"

REMOTE_AUDIT = r"""
# Dữ liệu vào: chuỗi Compose đang dùng và overlay K56 mới, đều có trên VPS.
# Việc chính: chỉ chạy docker compose config, so field khác biệt và URL đã ẩn mật khẩu.
# Kết quả: cổng cấu hình đạt hoặc dừng; chưa chạy docker compose up.
# Khi lỗi: không sửa container, không in giá trị environment.
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

overlay = Path('/opt/izone-k56-shared-db-20260924/compose.ic2264.override.yml')
expected_sha = %(overlay_sha)r

def run(args, env=None, code='COMMAND_FAILED'):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=60, check=False,
                            env=env)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

try:
    import hashlib
    if not overlay.is_file() or hashlib.sha256(overlay.read_bytes()).hexdigest() != expected_sha:
        raise RuntimeError('OVERLAY_HASH_MISMATCH')
    item = json.loads(run(['docker', 'inspect', 'izone-k56-ic2264-api'],
                          code='API_INSPECT_FAILED'))[0]
    if item['Image'] != 'sha256:2a00b0bf3593ebb15214cf30d2d1b9df1d84354a541c1841c093438a51bd1f8e':
        raise RuntimeError('API_IMAGE_CHANGED')
    labels = item['Config']['Labels']
    files = labels['com.docker.compose.project.config_files'].split(',')
    workdir = labels['com.docker.compose.project.working_dir']
    project = labels['com.docker.compose.project']
    service = labels['com.docker.compose.service']
    if service != 'k56-ic2264-api' or len(files) != 8:
        raise RuntimeError('COMPOSE_SOURCE_CHANGED')
    runtime_env = {line.split('=', 1)[0]: line.split('=', 1)[1]
                   for line in item['Config']['Env'] if '=' in line}
    for filename in files:
        text = Path(filename).read_text(encoding='utf-8')
        for key in re.findall(r'\$\{([A-Z][A-Z0-9_]*):\?', text):
            runtime_env.setdefault(key, runtime_env.get('BUILD_SHA') or '9b50aca')
    process_env = {**os.environ, **runtime_env}
    base = ['docker', 'compose', '--project-directory', workdir, '-p', project]
    for filename in files:
        base.extend(['-f', filename])
    previous = json.loads(run(base + ['config', '--format', 'json'],
                              env=process_env, code='BASE_COMPOSE_INVALID'))
    candidate = json.loads(run(base + ['-f', str(overlay), 'config', '--format', 'json'],
                               env=process_env, code='NEW_COMPOSE_INVALID'))
    old = previous['services'][service]
    new = candidate['services'][service]
    old_env = old.get('environment') or {}
    new_env = new.get('environment') or {}
    if not isinstance(old_env, dict) or not isinstance(new_env, dict):
        raise RuntimeError('COMPOSE_ENV_SHAPE_CHANGED')
    changed = sorted(key for key in set(old_env) | set(new_env)
                     if old_env.get(key) != new_env.get(key))
    if changed != ['APP_VERSION', 'BUILD_SHA', 'DATABASE_URL']:
        raise RuntimeError('COMPOSE_ENV_UNEXPECTED_DIFF')
    endpoint = urlsplit(new_env['DATABASE_URL'])
    if (endpoint.hostname != 'mapping-postgres'
            or endpoint.username != 'k56_shared_api'
            or endpoint.path != '/mapping_db'):
        raise RuntimeError('COMPOSE_DATABASE_ENDPOINT_WRONG')
    if (new['image'] != 'izone-k56-live-results:20260924.2-shared-db'
            or new_env.get('DEPLOYMENT_PROFILE') != 'k56-ic2264'
            or new_env.get('BUILD_SHA') != '6e2beb915a2b651dbd255ec6c2cdd986b4c5961a87495f86c889920c2b012243'):
        raise RuntimeError('COMPOSE_IMAGE_OR_PROFILE_WRONG')
    if sorted(new.get('networks') or {}) != ['k56-demo', 'mapping-api-net']:
        raise RuntimeError('COMPOSE_NETWORKS_WRONG')
    if candidate['networks']['mapping-api-net'].get('external') is not True:
        raise RuntimeError('SHARED_NETWORK_NOT_EXTERNAL')
    for key in set(old) | set(new):
        if (key not in {'image', 'environment', 'networks', 'env_file'}
                and old.get(key) != new.get(key)):
            raise RuntimeError('COMPOSE_FIELD_CHANGED_' + key.upper())
    if (new.get('ports') != old.get('ports')
            or new.get('volumes') != old.get('volumes')
            or new.get('read_only') != old.get('read_only')
            or new.get('restart') != old.get('restart')):
        raise RuntimeError('COMPOSE_RUNTIME_SHAPE_CHANGED')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'compose_candidate_verified_no_deploy',
                      'configFileCount': len(files) + 1,
                      'image': new['image'],
                      'changedEnvironmentKeys': changed,
                      'networks': sorted(new['networks']),
                      'publishedPorts': [port.get('published') for port in new['ports']],
                      'readOnly': new.get('read_only'),
                      'databaseHost': endpoint.hostname,
                      'databaseRole': endpoint.username,
                      'databaseName': endpoint.path.lstrip('/'),
                      'productionServiceChanged': False}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'productionServiceChanged': False}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    # Dữ liệu vào: overlay Git không secret và trạng thái Compose hiện hành.
    # Việc chính: chỉ tạo file overlay mới rồi so cấu hình đã nội suy trong RAM.
    # Kết quả: không đổi API/DB; người triển khai có cổng trước lệnh up.
    # Khi lỗi: giữ image/container cũ, không in giá trị environment.
    source = LOCAL_OVERLAY.read_bytes()
    source_sha = hashlib.sha256(source).hexdigest()
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
        sftp = client.open_sftp()
        try:
            try:
                with sftp.open(REMOTE_OVERLAY, 'rb') as remote:
                    existing = remote.read()
            except FileNotFoundError:
                with sftp.open(REMOTE_OVERLAY, 'wbx') as remote:
                    remote.write(source)
                sftp.chmod(REMOTE_OVERLAY, 0o600)
            else:
                if len(existing) == 0:
                    # Phiên trước chỉ tạo placeholder rỗng rồi dừng vì mode SFTP sai.
                    with sftp.open(REMOTE_OVERLAY, 'wb') as remote:
                        remote.write(source)
                    sftp.chmod(REMOTE_OVERLAY, 0o600)
                elif hashlib.sha256(existing).hexdigest() != source_sha:
                    raise RuntimeError("REMOTE_OVERLAY_EXISTS_WITH_DIFFERENT_HASH")
        finally:
            sftp.close()
        script = REMOTE_AUDIT % {"overlay_sha": source_sha}
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=90)
        stdin.write(script)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                code = json.loads(error).get("errorCode", "COMPOSE_STAGE_FAILED")
            except (ValueError, TypeError):
                code = "COMPOSE_STAGE_FAILED"
            print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                              "productionServiceChanged": False}), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "compose_candidate_verified_no_deploy":
            raise RuntimeError("COMPOSE_STAGE_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
