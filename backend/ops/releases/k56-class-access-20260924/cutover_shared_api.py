"""Chuyển riêng API K56 sang kho chung sau cổng pilot; không đổi API K67."""

import argparse
import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: image đã kiểm, tám file Compose hiện hành, overlay và hai backup.
# Việc chính: kiểm bất biến; chỉ khi --deploy mới tái tạo đúng service API K56.
# Kết quả: đọc lại image, health, roster và trạng thái API K67, không in PII.
# Khi lỗi: giữ nguyên trạng thái để điều tra; không tự quay về kho cũ nếu đã có bài mới.
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import urlopen

deploy = __DEPLOY__
name = 'izone-k56-ic2264-api'
service = 'k56-ic2264-api'
old_image = 'sha256:2a00b0bf3593ebb15214cf30d2d1b9df1d84354a541c1841c093438a51bd1f8e'
new_image = 'sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7'
overlay = Path('/opt/izone-k56-shared-db-20260924/compose.ic2264.override.yml')
backup_dir = Path('/opt/backups/k56-shared-cutover-yy5v09Z2')
backup_hashes = {
    'mapping_db-before-k56.dump': '0b186845321309a4e57ab9e641749c92bf8705bd129f8e842197a0f2c35bb49e',
    'k56-separate-before-cutover.dump': '31355f4de1ee6f655c10704c565d739bfe70c212109d5a263e3555e2b4f3d5b1',
}
expected_overlay_sha = '__OVERLAY_SHA__'
mutation_attempted = False

def run(args, code, input_text=None, env=None, timeout=90):
    result = subprocess.run(args, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

def inspect(container):
    items = json.loads(run(['docker', 'inspect', container],
                           'CONTAINER_INSPECT_FAILED'))
    if len(items) != 1:
        raise RuntimeError('CONTAINER_INSPECT_AMBIGUOUS')
    return items[0]

def psql(container, database, sql, code):
    command = ['docker', 'exec', '-i', container, 'sh', '-lc',
               'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ' + database]
    return json.loads(run(command, code, input_text=sql + '\n'))

def counts():
    shared = psql('mapping-postgres', 'mapping_db',
        "SELECT json_build_object("
        "'latest',(SELECT run.id::text FROM mapping.sync_run AS run "
        "WHERE run.source='n8n_k56_erp_ongoing' ORDER BY run.id DESC LIMIT 1),"
        "'definitions',(SELECT count(*) FROM assessment_k56.test_definition),"
        "'roster',(SELECT count(*) FROM assessment_k56.term_test_roster),"
        "'classes',(SELECT count(DISTINCT erp_course_class_id) "
        "FROM assessment_k56.term_test_roster),"
        "'access',(SELECT count(*) FROM assessment_k56.term_test_class_access),"
        "'pilotEnabled',(SELECT count(*) FROM assessment_k56.term_test_class_access "
        "WHERE erp_course_class_id=1252 AND enabled=true),"
        "'attempts',(SELECT count(*) FROM assessment_k56.term_test_attempt),"
        "'k67Roster',(SELECT count(*) FROM assessment.term_test_roster))::text;",
        'SHARED_COUNTS_FAILED')
    old = psql('izone-k56-demo-k56-demo-db-1', 'izone_mapping_k56_ic2264',
        "SELECT json_build_object("
        "'roster',(SELECT count(*) FROM assessment.term_test_roster),"
        "'attempts',(SELECT count(*) FROM assessment.term_test_attempt))::text;",
        'OLD_COUNTS_FAILED')
    return shared, old

def request(path):
    try:
        with urlopen('http://127.0.0.1:8795' + path, timeout=8) as response:
            status = response.status
            body = json.loads(response.read().decode('utf-8'))
    except HTTPError as exc:
        status = exc.code
        body = {}
    return status, body

try:
    if (not overlay.is_file()
            or hashlib.sha256(overlay.read_bytes()).hexdigest() != expected_overlay_sha):
        raise RuntimeError('OVERLAY_CHANGED')
    for filename, expected in backup_hashes.items():
        target = backup_dir / filename
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise RuntimeError('BACKUP_CHANGED_OR_MISSING')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}',
            'izone-k56-live-results:20260924.2-shared-db'],
           'NEW_IMAGE_MISSING') != new_image:
        raise RuntimeError('NEW_IMAGE_CHANGED')
    before = inspect(name)
    k67_before = inspect('mapping-review-api')
    canary = inspect('izone-k56-shared-api-profile-canary-20260924')
    if (before['Image'] != old_image
            or before['State'].get('Health', {}).get('Status') != 'healthy'
            or k67_before['State'].get('Health', {}).get('Status') != 'healthy'
            or canary['Image'] != new_image
            or canary['State'].get('Health', {}).get('Status') != 'healthy'
            or any(value for value in (canary['NetworkSettings'].get('Ports') or {}).values())):
        raise RuntimeError('RUNTIME_PREFLIGHT_CHANGED')
    labels = before['Config']['Labels']
    files = labels['com.docker.compose.project.config_files'].split(',')
    workdir = labels['com.docker.compose.project.working_dir']
    project = labels['com.docker.compose.project']
    if labels['com.docker.compose.service'] != service or len(files) != 8:
        raise RuntimeError('COMPOSE_SOURCE_CHANGED')
    runtime_env = {line.split('=', 1)[0]: line.split('=', 1)[1]
                   for line in before['Config']['Env'] if '=' in line}
    for filename in files:
        source = Path(filename).read_text(encoding='utf-8')
        for key in re.findall(r'\$\{([A-Z][A-Z0-9_]*):\?', source):
            runtime_env.setdefault(key, runtime_env.get('BUILD_SHA') or '9b50aca')
    process_env = {**os.environ, **runtime_env}
    base = ['docker', 'compose', '--project-directory', workdir, '-p', project]
    for filename in files:
        base.extend(['-f', filename])
    candidate = base + ['-f', str(overlay)]
    previous = json.loads(run(base + ['config', '--format', 'json'],
                              'OLD_COMPOSE_INVALID', env=process_env))
    updated = json.loads(run(candidate + ['config', '--format', 'json'],
                             'NEW_COMPOSE_INVALID', env=process_env))
    old_config = previous['services'][service]
    new_config = updated['services'][service]
    old_env = old_config['environment']
    new_env = new_config['environment']
    changed = sorted(key for key in set(old_env) | set(new_env)
                     if old_env.get(key) != new_env.get(key))
    endpoint = urlsplit(new_env['DATABASE_URL'])
    if (changed != ['APP_VERSION', 'BUILD_SHA', 'DATABASE_URL']
            or new_config['image'] != 'izone-k56-live-results:20260924.2-shared-db'
            or new_env.get('DEPLOYMENT_PROFILE') != 'k56-ic2264'
            or endpoint.hostname != 'mapping-postgres'
            or endpoint.username != 'k56_shared_api'
            or endpoint.path != '/mapping_db'
            or sorted(new_config.get('networks') or {}) != ['k56-demo', 'mapping-api-net']
            or updated['networks']['mapping-api-net'].get('external') is not True):
        raise RuntimeError('COMPOSE_CONTRACT_MISMATCH')
    for key in set(old_config) | set(new_config):
        if key not in {'image', 'environment', 'networks', 'env_file'} \
                and old_config.get(key) != new_config.get(key):
            raise RuntimeError('COMPOSE_UNEXPECTED_CHANGE_' + key.upper())
    shared_before, old_before = counts()
    if (shared_before != {'latest': '105', 'definitions': 3, 'roster': 1341,
                          'classes': 29, 'access': 3, 'pilotEnabled': 3,
                          'attempts': 0, 'k67Roster': 46}
            or old_before != {'roster': 36, 'attempts': 0}):
        raise RuntimeError('DATA_PREFLIGHT_CHANGED')
    if not deploy:
        print(json.dumps({'toolOutcome': 'success',
                          'businessOutcome': 'cutover_preflight_ready',
                          'sourceComposeFiles': len(files), 'changedEnvKeys': changed,
                          'sharedCounts': shared_before, 'oldCounts': old_before,
                          'k67ImageId': k67_before['Image'],
                          'publicApiChanged': False}))
        raise SystemExit(0)
    mutation_attempted = True
    run(candidate + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', service],
        'COMPOSE_UP_FAILED', env=process_env, timeout=120)
    after = None
    for _ in range(40):
        after = inspect(name)
        if after['Image'] == new_image and after['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(2)
    if (after['Image'] != new_image
            or after['State'].get('Health', {}).get('Status') != 'healthy'
            or sorted(after['NetworkSettings']['Networks']) !=
            ['izone-k56-demo_default', 'mapping-api-net']):
        raise RuntimeError('NEW_API_NOT_HEALTHY')
    health_status, health_body = request('/health')
    if health_status != 200 or health_body.get('deploymentProfile') != 'k56-ic2264':
        raise RuntimeError('PUBLIC_PORT_HEALTH_FAILED')
    slugs = ('term-test-1-k56', 'term-test-2-k56', 'mini-test-k56')
    roster_counts = {}
    for slug in slugs:
        status, body = request('/api/term-tests/roster?class=IC2264&test=' + slug)
        students = body.get('students')
        if status != 200 or not isinstance(students, list) or len(students) != 12:
            raise RuntimeError('PILOT_ROSTER_FAILED_' + slug)
        roster_counts[slug] = len(students)
    closed_status, _ = request('/api/term-tests/roster?class=IC2322&test=term-test-1-k56')
    k67_status, _ = request('/api/term-tests/roster?class=IC2322&test=term-test-1')
    if closed_status != 404 or k67_status != 404:
        raise RuntimeError('CLOSED_OR_K67_GATE_FAILED')
    k67_after = inspect('mapping-review-api')
    shared_after, old_after = counts()
    if (k67_after['Image'] != k67_before['Image']
            or k67_after['State'].get('Health', {}).get('Status') != 'healthy'
            or shared_after['k67Roster'] != 46
            or old_after['attempts'] != 0):
        raise RuntimeError('K67_OR_OLD_DB_CHANGED')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'k56_shared_api_deployed_readback',
                      'newImageId': after['Image'], 'health': 'healthy',
                      'pilotRosterCounts': roster_counts,
                      'unopenedClassStatus': closed_status,
                      'k67SlugStatus': k67_status,
                      'sharedCounts': shared_after, 'oldCounts': old_after,
                      'k67ImageUnchanged': True,
                      'publicApiChanged': True}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    current_image = None
    try:
        current_image = inspect(name)['Image']
    except Exception:
        pass
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'mutationAttempted': mutation_attempted,
                      'currentImageId': current_image,
                      'rollbackAutomatic': False}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deploy", action="store_true")
    args = parser.parse_args()
    from hashlib import sha256
    from pathlib import Path

    overlay = Path(__file__).resolve().parent / "compose.ic2264.override.yml"
    source_sha = sha256(overlay.read_bytes()).hexdigest()
    script = REMOTE_SCRIPT.replace("__DEPLOY__", "True" if args.deploy else "False")
    script = script.replace("__OVERLAY_SHA__", source_sha)
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
                report = {"toolOutcome": "failure", "errorCode": "CUTOVER_REMOTE_FAILED"}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        expected = ("k56_shared_api_deployed_readback" if args.deploy
                    else "cutover_preflight_ready")
        if report.get("businessOutcome") != expected:
            raise RuntimeError("CUTOVER_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
