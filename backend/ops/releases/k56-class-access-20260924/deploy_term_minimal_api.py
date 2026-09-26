"""Lưu đường rollback của phép thử 26/09; chặn triển khai lại image GET Portal bị 403."""

import argparse
import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: container/Compose K56 đang chạy và image Term ứng viên đã ghim ID.
# Việc chính: so cấu hình chỉ khác image và nhãn bản build; --deploy mới tạo overlay
# rồi tái tạo riêng API K56. K67, worker, Portal và database không bị sửa trực tiếp.
# Kết quả: chỉ in cờ/đếm tổng hợp, health và image ID; không in env hoặc hồ sơ.
# Khi lỗi: giữ trạng thái tại thời điểm lỗi để điều tra, không rollback mù khi có bài.
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

deploy = __DEPLOY__
service = 'k56-ic2264-api'
container = 'izone-k56-ic2264-api'
candidate_tag = 'izone-k56-live-results:20260924.6-term-minimal-portal-rc'
candidate_id = 'sha256:81dcbf688730155737084b87bc2250851317d283aeb2519a4c47276012517608'
old_id = 'sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956'
overlay_path = Path('/opt/izone-k56-term-20260926/compose.term-minimal-portal.yml')
overlay = '''services:
  k56-ic2264-api:
    image: izone-k56-live-results:20260924.6-term-minimal-portal-rc
    environment:
      APP_VERSION: k56-term-minimal-portal-20260926.6
      BUILD_SHA: dd90c33bcd53f8dc145f98ceb1aa14957c4321676221dbd6d66efc0743168545
'''
mutation_attempted = False

def run(args, code, *, env=None, input_text=None, timeout=45):
    result = subprocess.run(args, input=input_text, text=True,
                            capture_output=True, check=False, env=env,
                            timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

def inspect(name):
    rows = json.loads(run(['docker', 'inspect', name], 'INSPECT_FAILED'))
    if len(rows) != 1:
        raise RuntimeError('INSPECT_AMBIGUOUS')
    return rows[0]

def counts():
    sql = ("BEGIN READ ONLY; SELECT json_build_object("
           "'attempts',(SELECT count(*) FROM assessment_k56.term_test_attempt),"
           "'runs',(SELECT count(*) FROM assessment_k56.term_test_writing_grading_run),"
           "'jobs',(SELECT count(*) FROM assessment_k56.term_test_writing_grading_job)"
           ")::text; COMMIT;")
    command = ['docker', 'exec', '-i', 'mapping-postgres', 'sh', '-lc',
               'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db']
    lines = run(command, 'QUEUE_AUDIT_FAILED', input_text=sql).splitlines()
    objects = [json.loads(line) for line in lines if line.startswith('{')]
    if len(objects) != 1:
        raise RuntimeError('QUEUE_AUDIT_SHAPE')
    return objects[0]

def request_status(path):
    try:
        with urlopen('http://127.0.0.1:8795' + path, timeout=8) as response:
            return response.status, response.read(8192)
    except HTTPError as exc:
        return exc.code, b''

try:
    before = inspect(container)
    k67_before = inspect('mapping-review-api')
    if (before['Image'] != old_id
            or before['State'].get('Health', {}).get('Status') != 'healthy'
            or k67_before['State'].get('Health', {}).get('Status') != 'healthy'):
        raise RuntimeError('RUNTIME_BASE_CHANGED')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}', candidate_tag],
           'CANDIDATE_IMAGE_MISSING') != candidate_id:
        raise RuntimeError('CANDIDATE_IMAGE_CHANGED')

    labels = before['Config']['Labels']
    files = labels['com.docker.compose.project.config_files'].split(',')
    workdir = labels['com.docker.compose.project.working_dir']
    project = labels['com.docker.compose.project']
    if (labels['com.docker.compose.service'] != service
            or project != 'izone-k56-ic2264' or len(files) != 10):
        raise RuntimeError('COMPOSE_BASE_CHANGED')
    if any(not Path(filename).is_file() for filename in files):
        raise RuntimeError('COMPOSE_FILE_MISSING')
    runtime_env = {line.split('=', 1)[0]: line.split('=', 1)[1]
                   for line in before['Config']['Env'] if '=' in line}
    for filename in files:
        source = Path(filename).read_text(encoding='utf-8')
        for key in re.findall(r'\$\{([A-Z][A-Z0-9_]*):\?', source):
            if key not in runtime_env:
                if key not in {'K56_LOAD_GUARD_BUILD_SHA', 'UNIFIED_TERM_TEST_BUILD_SHA'}:
                    raise RuntimeError('COMPOSE_REQUIRED_ENV_CHANGED')
                runtime_env[key] = runtime_env.get('BUILD_SHA', '')
    if not runtime_env.get('BUILD_SHA'):
        raise RuntimeError('BUILD_SHA_MISSING')
    process_env = {**os.environ, **runtime_env}
    base = ['docker', 'compose', '--project-directory', workdir, '-p', project]
    for filename in files:
        base.extend(['-f', filename])
    current = json.loads(run(base + ['config', '--format', 'json'],
                             'BASE_COMPOSE_INVALID', env=process_env))
    planned = json.loads(run(base + ['-f', '-', 'config', '--format', 'json'],
                             'PLANNED_COMPOSE_INVALID', env=process_env,
                             input_text=overlay))
    old_service = current['services'][service]
    new_service = planned['services'][service]
    old_env = old_service['environment']
    new_env = new_service['environment']
    changed_env = sorted(k for k in set(old_env) | set(new_env)
                         if old_env.get(k) != new_env.get(k))
    changed_service = sorted(k for k in set(old_service) | set(new_service)
                             if old_service.get(k) != new_service.get(k))
    if (old_service.get('image') != 'izone-k56-live-results:20260924.4-roster-reconcile'
            or new_service.get('image') != candidate_tag
            or changed_env != ['APP_VERSION', 'BUILD_SHA']
            or changed_service != ['environment', 'image']
            or current.get('networks') != planned.get('networks')
            or set(current['services']) != set(planned['services'])
            or any(current['services'][name] != planned['services'][name]
                   for name in current['services'] if name != service)):
        raise RuntimeError('COMPOSE_DIFF_OUT_OF_SCOPE')
    queue_before = counts()
    if queue_before != {'attempts': 0, 'runs': 0, 'jobs': 0}:
        raise RuntimeError('K56_QUEUE_NOT_EMPTY')
    if overlay_path.exists() and overlay_path.read_text(encoding='utf-8') != overlay:
        raise RuntimeError('OVERLAY_PATH_OCCUPIED')

    if not deploy:
        print(json.dumps({'toolOutcome': 'success', 'businessOutcome': 'preflight_ready',
                          'composeFileCount': len(files), 'changedServiceKeys': changed_service,
                          'changedEnvKeys': changed_env, 'queueBefore': queue_before,
                          'candidateImageId': candidate_id, 'productionWrites': 0}))
        raise SystemExit(0)

    mutation_attempted = True
    overlay_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not overlay_path.exists():
        with overlay_path.open('x', encoding='utf-8') as target:
            target.write(overlay)
    if overlay_path.read_text(encoding='utf-8') != overlay:
        raise RuntimeError('OVERLAY_READBACK_FAILED')
    actual_plan = json.loads(run(base + ['-f', str(overlay_path), 'config',
                                       '--format', 'json'],
                                 'FILE_COMPOSE_INVALID', env=process_env))
    if actual_plan != planned:
        raise RuntimeError('FILE_COMPOSE_DIFFERS_FROM_STDIN')
    run(base + ['-f', str(overlay_path), 'up', '-d', '--no-deps', '--no-build',
                '--force-recreate', service], 'COMPOSE_UP_FAILED',
        env=process_env, timeout=150)
    after = None
    for _ in range(45):
        after = inspect(container)
        if after['Image'] == candidate_id and after['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(2)
    if (after['Image'] != candidate_id
            or after['State'].get('Health', {}).get('Status') != 'healthy'):
        raise RuntimeError('NEW_API_NOT_HEALTHY')
    health_status, health_raw = request_status('/health')
    health = json.loads(health_raw) if health_status == 200 else {}
    unauthorized, _ = request_status('/api/term-tests/writing-grading/portal-snapshot'
                                     '?classId=1164&studentId=1&testSlug=term-test-1-k56')
    k67_after = inspect('mapping-review-api')
    queue_after = counts()
    if (health_status != 200 or health.get('ok') is not True
            or health.get('deploymentProfile') != 'k56-ic2264'
            or unauthorized != 401
            or k67_after['Image'] != k67_before['Image']
            or k67_after['State'].get('Health', {}).get('Status') != 'healthy'):
        raise RuntimeError('POST_DEPLOY_READBACK_FAILED')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'api_deployed_awaiting_e2e',
                      'imageId': after['Image'], 'health': 'healthy',
                      'snapshotWithoutSecretStatus': unauthorized,
                      'queueBefore': queue_before, 'queueAfter': queue_after,
                      'k67ImageUnchanged': True, 'backendChanged': True}))
except SystemExit:
    raise
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'mutationAttempted': mutation_attempted,
                      'rollbackAutomatic': False}), file=sys.stderr)
    raise SystemExit(2)
"""

REMOTE_ROLLBACK_SCRIPT = r"""
# Dữ liệu vào: container K56 đã chạy image mới và 11 file Compose sau phát hành.
# Việc chính: chỉ khi chưa có attempt/run/job K56, dùng lại đúng 10 file cũ.
# Kết quả: API cũ healthy, K67 không đổi; writer mới vẫn giữ nguyên để xử lý riêng.
# Khi lỗi hoặc có bài: không hạ image, giữ bài và sửa tiến theo runbook.
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.request import urlopen

service = 'k56-ic2264-api'
container = 'izone-k56-ic2264-api'
candidate_id = 'sha256:81dcbf688730155737084b87bc2250851317d283aeb2519a4c47276012517608'
old_id = 'sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956'
overlay_path = '/opt/izone-k56-term-20260926/compose.term-minimal-portal.yml'
mutation_attempted = False

def run(args, code, *, env=None, input_text=None, timeout=45):
    result = subprocess.run(args, input=input_text, text=True,
                            capture_output=True, check=False, env=env,
                            timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(code)
    return result.stdout.strip()

def inspect(name):
    rows = json.loads(run(['docker', 'inspect', name], 'INSPECT_FAILED'))
    if len(rows) != 1:
        raise RuntimeError('INSPECT_AMBIGUOUS')
    return rows[0]

def counts():
    sql = ("BEGIN READ ONLY; SELECT json_build_object("
           "'attempts',(SELECT count(*) FROM assessment_k56.term_test_attempt),"
           "'runs',(SELECT count(*) FROM assessment_k56.term_test_writing_grading_run),"
           "'jobs',(SELECT count(*) FROM assessment_k56.term_test_writing_grading_job)"
           ")::text; COMMIT;")
    command = ['docker', 'exec', '-i', 'mapping-postgres', 'sh', '-lc',
               'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db']
    lines = run(command, 'QUEUE_AUDIT_FAILED', input_text=sql).splitlines()
    objects = [json.loads(line) for line in lines if line.startswith('{')]
    if len(objects) != 1:
        raise RuntimeError('QUEUE_AUDIT_SHAPE')
    return objects[0]

try:
    before = inspect(container)
    k67_before = inspect('mapping-review-api')
    if (before['Image'] != candidate_id
            or k67_before['State'].get('Health', {}).get('Status') != 'healthy'
            or not Path(overlay_path).is_file()):
        raise RuntimeError('ROLLBACK_BASE_CHANGED')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}',
            'izone-k56-live-results:20260924.4-roster-reconcile'],
           'OLD_IMAGE_MISSING') != old_id:
        raise RuntimeError('OLD_IMAGE_CHANGED')
    labels = before['Config']['Labels']
    files = labels['com.docker.compose.project.config_files'].split(',')
    workdir = labels['com.docker.compose.project.working_dir']
    project = labels['com.docker.compose.project']
    if (labels['com.docker.compose.service'] != service
            or project != 'izone-k56-ic2264'
            or len(files) != 11 or files[-1] != overlay_path
            or any(not Path(filename).is_file() for filename in files)):
        raise RuntimeError('ROLLBACK_COMPOSE_CHANGED')
    runtime_env = {line.split('=', 1)[0]: line.split('=', 1)[1]
                   for line in before['Config']['Env'] if '=' in line}
    for filename in files:
        for key in re.findall(r'\$\{([A-Z][A-Z0-9_]*):\?',
                              Path(filename).read_text(encoding='utf-8')):
            if key not in runtime_env:
                if key not in {'K56_LOAD_GUARD_BUILD_SHA', 'UNIFIED_TERM_TEST_BUILD_SHA'}:
                    raise RuntimeError('ROLLBACK_REQUIRED_ENV_CHANGED')
                runtime_env[key] = runtime_env.get('BUILD_SHA', '')
    if not runtime_env.get('BUILD_SHA'):
        raise RuntimeError('ROLLBACK_BUILD_SHA_MISSING')
    process_env = {**os.environ, **runtime_env}
    base = ['docker', 'compose', '--project-directory', workdir, '-p', project]
    for filename in files[:-1]:
        base.extend(['-f', filename])
    current = json.loads(run(base + ['-f', overlay_path, 'config', '--format', 'json'],
                             'ROLLBACK_CURRENT_CONFIG_INVALID', env=process_env))
    old = json.loads(run(base + ['config', '--format', 'json'],
                         'ROLLBACK_BASE_CONFIG_INVALID', env=process_env))
    old_service = old['services'][service]
    new_service = current['services'][service]
    old_env = old_service['environment']
    new_env = new_service['environment']
    changed_env = sorted(k for k in set(old_env) | set(new_env)
                         if old_env.get(k) != new_env.get(k))
    changed_service = sorted(k for k in set(old_service) | set(new_service)
                             if old_service.get(k) != new_service.get(k))
    if (old_service.get('image') != 'izone-k56-live-results:20260924.4-roster-reconcile'
            or new_service.get('image') !=
                'izone-k56-live-results:20260924.6-term-minimal-portal-rc'
            or changed_env != ['APP_VERSION', 'BUILD_SHA']
            or changed_service != ['environment', 'image']
            or current.get('networks') != old.get('networks')
            or set(current['services']) != set(old['services'])
            or any(current['services'][name] != old['services'][name]
                   for name in old['services'] if name != service)):
        raise RuntimeError('ROLLBACK_DIFF_OUT_OF_SCOPE')
    queue_before = counts()
    if queue_before != {'attempts': 0, 'runs': 0, 'jobs': 0}:
        raise RuntimeError('ROLLBACK_BLOCKED_K56_HAS_ATTEMPTS')

    mutation_attempted = True
    run(base + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', service],
        'ROLLBACK_COMPOSE_UP_FAILED', env=process_env, timeout=150)
    after = None
    for _ in range(45):
        after = inspect(container)
        if after['Image'] == old_id and after['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(2)
    if (after['Image'] != old_id
            or after['State'].get('Health', {}).get('Status') != 'healthy'):
        raise RuntimeError('ROLLBACK_API_NOT_HEALTHY')
    with urlopen('http://127.0.0.1:8795/health', timeout=8) as response:
        health = json.loads(response.read(8192))
        health_status = response.status
    k67_after = inspect('mapping-review-api')
    queue_after = counts()
    if (health_status != 200 or health.get('ok') is not True
            or k67_after['Image'] != k67_before['Image']
            or k67_after['State'].get('Health', {}).get('Status') != 'healthy'
            or queue_after != {'attempts': 0, 'runs': 0, 'jobs': 0}):
        raise RuntimeError('ROLLBACK_READBACK_FAILED')
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'api_rolled_back_writer_unchanged',
                      'imageId': after['Image'], 'health': 'healthy',
                      'queueBefore': queue_before, 'queueAfter': queue_after,
                      'k67ImageUnchanged': True, 'writerRollbackRequiredSeparately': True}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'mutationAttempted': mutation_attempted,
                      'rollbackAutomatic': False}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    """Chỉ cho phép rollback có guard; ứng viên GET Portal đã thất bại."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--deploy', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    if args.deploy and args.rollback:
        parser.error('--deploy và --rollback không được dùng cùng nhau')
    if not args.rollback:
        # Dữ liệu vào: lựa chọn preflight/deploy cho image đã gặp HTTP 403 từ VPS1.
        # Việc chính: chặn trước khi đọc credential hoặc chạm production.
        # Kết quả: chỉ đường rollback còn dùng được nếu đúng image và kho K56 trống.
        # Khi lỗi: không tự thử lại image này; dùng ứng viên đã qua cổng mới.
        print(json.dumps({'toolOutcome': 'failure',
                          'businessOutcome': 'candidate_blocked',
                          'errorCode': 'PORTAL_GET_403_FROM_VPS1',
                          'productionWrites': 0}), file=sys.stderr)
        raise SystemExit(2)
    credential = win32cred.CredRead('Codex/SSH/vps_1', win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get('UserName') or 'root').strip().split('@', 1)[0]
                or 'root')
    password = credential['CredentialBlob'].decode('utf-16-le')
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect('ducizone.ddns.net', port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        script = (REMOTE_ROLLBACK_SCRIPT if args.rollback else
                  REMOTE_SCRIPT.replace('__DEPLOY__', 'True' if args.deploy else 'False'))
        stdin, stdout, stderr = client.exec_command('python3 -', timeout=220)
        stdin.write(script)
        stdin.channel.shutdown_write()
        body = stdout.read().decode('utf-8').strip()
        error = stderr.read().decode('utf-8').strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                report = json.loads(error)
            except (ValueError, TypeError):
                report = {'toolOutcome': 'failure', 'errorCode': 'REMOTE_FAILED'}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        expected = ('api_rolled_back_writer_unchanged' if args.rollback else
                    'api_deployed_awaiting_e2e' if args.deploy else 'preflight_ready')
        if report.get('businessOutcome') != expected:
            raise RuntimeError('REPORT_OUTCOME_MISMATCH')
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    main()
