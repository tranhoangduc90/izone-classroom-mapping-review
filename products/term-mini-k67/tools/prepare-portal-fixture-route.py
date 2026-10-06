"""HTTPS riêng cho Portal giả K67, không sửa vhost hoặc file sản phẩm chung.
Nhận intent/DPAPI; chỉ mở18868 GET/PUT lớp1124. File mới exclusive, readback/hash/nginx test.
Rollback rename đúng file own sang .disabled; giữ bằng chứng, không xóa hoặc ghi đè.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import json
import re
import sys
import uuid
import requests

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path('E:/Codex-Data/k67-backend-separation-20261006/portal-fixture-route')
STATE = PRIVATE / 'state.json'
VHOST = '/etc/nginx/sites-enabled/ducizone.conf'
HOST = 'https://ducizone.ddns.net'
FIXTURE_HOST = HOST + ':18868'

def digest(data): return hashlib.sha256(data).hexdigest()

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / file)
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded); return loaded

def read(sftp, path):
    with sftp.open(path, 'rb') as stream: return stream.read()

def optional(sftp, path):
    try: return read(sftp, path)
    except FileNotFoundError: return None

def config(intent):
    # Chứng chỉ hiện có chỉ được dùng qua filename; không đọc khóa TLS hoặc sửa vhost443.
    return (f'# K67 Portal gia; intent {intent}\nserver {{\n'
      '    listen 18868 ssl;\n'
      '    server_name ducizone.ddns.net;\n'
      '    ssl_certificate /etc/letsencrypt/live/ducizone.ddns.net/fullchain.pem;\n'
      '    ssl_certificate_key /etc/letsencrypt/live/ducizone.ddns.net/privkey.pem;\n'
      f'    location = /k67-portal-fixture/{intent}/1124/student-tests {{\n'
      '        if ($request_method !~ ^(GET|PUT)$) { return 405; }\n'
      '        client_max_body_size 64k;\n'
      '        proxy_connect_timeout 3s;\n'
      '        proxy_read_timeout 15s;\n'
      '        proxy_send_timeout 15s;\n'
      '        proxy_set_header X-K67-Fixture-Service $http_x_k67_fixture_service;\n'
      '        proxy_pass http://127.0.0.1:18867/portal/v1/course-classes/1124/student-tests;\n'
      '    }\n'
      '    location / { return 404; }\n'
      '}\n').encode()

def health():
    result = {}
    for path in ['/mapping-api/health', '/mapping-api-k56/health']:
        response = requests.get(HOST + path, timeout=20, allow_redirects=False)
        if response.status_code != 200: raise RuntimeError('PROTECTED_ROUTE_NOT_HEALTHY')
        result[path] = {'status': response.status_code}
    return result

def verify(intent, keys):
    base = FIXTURE_HOST + '/k67-portal-fixture/' + intent
    headers = {'x-k67-fixture-service': keys['portal']}
    own = requests.get(base + '/1124/student-tests', headers=headers, timeout=20, allow_redirects=False)
    if own.status_code != 200: raise RuntimeError('PORTAL_ROUTE_NOT_READY')
    data = own.json()
    if len(data.get('class_tests', [])) != 6 or len(data.get('student_test_grades', [])) != 18:
        raise RuntimeError('PORTAL_FIXTURE_RESPONSE_MISMATCH')
    if {row['student_id'] for row in data['student_test_grades']} != {9870677001, 9870677002, 9870677003}:
        raise RuntimeError('PORTAL_FIXTURE_STUDENT_MISMATCH')
    checks = {'own_get': 200}
    for label, path, expected in [('no_key', '/1124/student-tests', 401), ('foreign_class', '/1125/student-tests', 404),
       ('control_closed', '/fixture/control', 404), ('backend_closed', '/term-mini-k67-api/health', 404)]:
        response = requests.get(base + path, headers={} if label == 'no_key' else headers, timeout=20, allow_redirects=False)
        if response.status_code != expected: raise RuntimeError('PORTAL_ROUTE_BOUNDARY_' + label.upper())
        checks[label] = response.status_code
    response = requests.post(base + '/1124/student-tests', headers=headers, json={}, timeout=20, allow_redirects=False)
    if response.status_code != 405: raise RuntimeError('PORTAL_ROUTE_METHOD_BOUNDARY')
    checks['post_denied'] = 405
    return checks

def ownership(u, client, state, sftp, rollback_resume=False):
    source = read(sftp, '/etc/nginx/nginx.conf')
    if source.count(b'include /etc/nginx/conf.d/*.conf;') != 1: raise RuntimeError('NGINX_CONF_D_INCLUSION_UNKNOWN')
    desired = config(state['intent']); actual = optional(sftp, state['include'])
    disabled = optional(sftp, state['include'] + '.disabled')
    if actual is not None and actual != desired: raise RuntimeError('INCLUDE_COLLISION')
    if disabled is not None and disabled != desired: raise RuntimeError('DISABLED_INCLUDE_COLLISION')
    if actual is not None and disabled is not None: raise RuntimeError('INCLUDE_STATE_AMBIGUOUS')
    # Đọc nginx -T trong bộ nhớ rồi chỉ kiểm listener; không in/log toàn cấu hình chứa header secret.
    rendered = u.remote(client, ['nginx', '-T'], include_stderr=True).decode('utf-8')
    current_file = None
    for line in rendered.splitlines():
        match = re.match(r'# configuration file (.+):$', line)
        if match: current_file = match.group(1)
        if re.search(r'^\s*listen\s+[^;]*\b18868\b', line) and current_file != state['include']:
            raise RuntimeError('PORT_ALREADY_CONFIGURED_BY_OTHER')
    if actual is None and not (rollback_resume and disabled == desired and state.get('stage') == 'rollback_intent') \
      and u.remote(client, ['ss', '-H', '-ltn', 'sport = :18868']).strip():
        raise RuntimeError('PORT_ALREADY_BOUND')
    return desired, actual, disabled

def prepare(h, u, client, state, keys):
    sftp = client.open_sftp()
    try:
        desired, actual, disabled = ownership(u, client, state, sftp)
        if actual is None:
            state['stage'] = 'create_intent'; h.atomic(STATE, state)
            if disabled is not None:
                # SFTP rename không ghi đè đích tồn tại; không dùng posix_rename.
                sftp.rename(state['include'] + '.disabled', state['include'])
            else:
                with sftp.open(state['include'], 'wx') as stream: stream.write(desired)
                sftp.chmod(state['include'], 0o644)
        if read(sftp, state['include']) != desired: raise RuntimeError('INCLUDE_READBACK_FAILED')
        state['stage'] = 'candidate_on_disk'; h.atomic(STATE, state)
        # Kiểm lại port/source inclusion trước test; không thay file vhost chung ở bất cứ nhánh nào.
        ownership(u, client, state, sftp)
        try: output = u.remote(client, ['nginx', '-t'], include_stderr=True)
        except Exception:
            if read(sftp, state['include']) != desired: raise RuntimeError('ROLLBACK_FOREIGN_INCLUDE_CHANGE')
            sftp.rename(state['include'], state['include'] + '.disabled')
            state['stage'] = 'configuration_test_failed_disabled'; h.atomic(STATE, state)
            raise
        (PRIVATE / ('nginx-test-' + uuid.uuid4().hex + '.private.log')).write_bytes(output)
        u.remote(client, ['systemctl', 'reload', 'nginx'])
        state['route_checks'] = verify(state['intent'], keys)
        state['stage'] = 'ready'; h.atomic(STATE, state)
    finally: sftp.close()

def rollback(h, u, client, state):
    sftp = client.open_sftp()
    try:
        desired, actual, disabled = ownership(u, client, state, sftp, rollback_resume=True)
        if actual is not None:
            if read(sftp, state['include']) != desired: raise RuntimeError('ROLLBACK_FOREIGN_INCLUDE_CHANGE')
            state['stage'] = 'rollback_intent'; h.atomic(STATE, state)
            sftp.rename(state['include'], state['include'] + '.disabled')
        elif disabled != desired: raise RuntimeError('ROLLBACK_INCLUDE_NOT_FOUND')
        u.remote(client, ['nginx', '-t'], include_stderr=True)
        u.remote(client, ['systemctl', 'reload', 'nginx'])
        if u.remote(client, ['ss', '-H', '-ltn', 'sport = :18868']).strip(): raise RuntimeError('ROLLBACK_LISTENER_STILL_BOUND')
        state['stage'] = 'rolled_back'; h.atomic(STATE, state)
    finally: sftp.close()

def main():
    sys.stdout.reconfigure(encoding='utf-8', line_buffering=True); sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)
    parser = argparse.ArgumentParser(); parser.add_argument('--rollback', action='store_true'); args = parser.parse_args()
    h = module('http_fixture', 'prepare-http-fixture.py'); u = h.utilities()
    fixture = json.loads(h.STATE.read_text(encoding='utf-8')); h.validate_state(fixture)
    keys = h.vault(h.STORE / 'credentials.dpapi')
    if keys.get('identity') != h.IDENTITY or keys.get('intent_id') != fixture['intent_id']: raise RuntimeError('FIXTURE_VAULT_MISMATCH')
    expected = {'product_id': 'PRODUCT-TERM-MINI-K67', 'fixture_identity': h.IDENTITY, 'intent': fixture['intent_id'],
      'include': '/etc/nginx/conf.d/k67-portal-fixture-' + fixture['intent_id'] + '.conf',
      'config_sha256': digest(config(fixture['intent_id']))}
    state = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else expected
    if any(state.get(k) != v for k, v in expected.items()): raise RuntimeError('ROUTE_STATE_IDENTITY_MISMATCH')
    h.atomic(STATE, state)
    client = u.connect(); before = u.protected(client); checks_before = health(); revision = h.fingerprint()
    sftp = client.open_sftp()
    try: vhost_before = digest(read(sftp, VHOST))
    finally: sftp.close()
    run_id = 'k67-portal-route-' + uuid.uuid4().hex; error = guard_error = None
    try:
        for name in [h.APP, h.GATE]: h.check_container(json.loads(u.remote(client, ['docker', 'inspect', name]))[0], fixture, name)
        if args.rollback: rollback(h, u, client, state)
        else: prepare(h, u, client, state, keys)
    except Exception as exc: error = str(exc) if re.fullmatch('[A-Z_0-9]+', str(exc)) else type(exc).__name__
    finally:
        try:
            after = u.protected(client); checks_after = health()
            sftp = client.open_sftp()
            try: vhost_after = digest(read(sftp, VHOST))
            finally: sftp.close()
            if before != after or checks_before != checks_after or vhost_before != vhost_after: raise RuntimeError('PROTECTED_STATE_CHANGED')
        except Exception as exc: after = checks_after = vhost_after = None; guard_error = type(exc).__name__
        client.close()
    receipt = {'run_id': run_id, 'tree_revision': revision, 'observed_after_revision': h.fingerprint(),
        'outcome': 'passed' if not error and not guard_error else 'unknown', 'operation_error': error, 'guard_error': guard_error,
        'protected_before': before, 'protected_after': after, 'routes_before': checks_before, 'routes_after': checks_after,
        'vhost_before_sha256': vhost_before, 'vhost_after_sha256': vhost_after,
        'intent': state['intent'], 'stage': state.get('stage'), 'route_checks': state.get('route_checks'),
        'observed_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}
    if receipt['tree_revision'] != receipt['observed_after_revision']: receipt['outcome'] = 'unknown'
    h.atomic(PRIVATE / (run_id + '.json'), receipt)
    print(json.dumps({k: receipt[k] for k in ['run_id', 'outcome', 'operation_error', 'guard_error', 'stage']}))
    return 0 if receipt['outcome'] == 'passed' else 1

if __name__ == '__main__':
    try:
        PRIVATE.mkdir(exist_ok=True)
        owner = module('grading_fixture', 'prepare-grading-fixture.py')
        with owner.single_owner(PRIVATE / 'operation.lock'): sys.exit(main())
    except Exception as exc:
        print(json.dumps({'outcome': 'failure', 'code': str(exc) if re.fullmatch('[A-Z_0-9]+', str(exc)) else type(exc).__name__}))
        sys.exit(1)
