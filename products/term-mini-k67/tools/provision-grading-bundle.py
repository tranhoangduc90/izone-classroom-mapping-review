"""Dựng 49 luồng K67 từ snapshot ghim, không bật nhận bài hoặc gọi AI/Portal.

--prepare tạo khóa/error writer và bảng đích; --deploy-inactive validate đủ,
tạo từ lá lên cha rồi đọc ID/nội dung thực. Mất ACK giữ pending, không retry.
Secret qua DPAPI/stdin; snapshot và log riêng tư trên E, không in payload.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import uuid
import win32crypt

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path('E:/Codex-Data/k67-backend-separation-20261006/grading-provision')
STATE = PRIVATE / 'state.json'
TARGET = PRIVATE / 'target.json'
VAULT = PRIVATE / 'service-keys.dpapi'
SCRIPTS = Path('E:/wt/k67-grading-separation-20261006/n8n-root/n8n-workflows/scripts')
CLI = 'C:/Users/ADMIN/AppData/Roaming/npm/node_modules/@trngthnh369/n8nctl/dist/index.js'
LIFECYCLE = Path('E:/Codex-Data/n8n-workflow-lifecycle/k67-grading-separation-20261006.json')
HOSTS = {'default': 'https://ducizone.ddns.net', 'izone-ai': 'https://n8n-ai.izone.edu.vn'}
SETTINGS = {'saveDataErrorExecution': 'all', 'saveDataSuccessExecution': 'all', 'saveManualExecutions': True}
NODE = shutil.which('node')


def write(path, value):
    # Giữ state cũ khi ghi dở: hoàn thành file tạm rồi mới thay atomically.
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def call(argv, label, input_bytes=None, journal_id=None):
    # Giữ log từng lượt bất biến; timeout không được đổi thành thất bại sạch.
    base = PRIVATE / (label + '-' + (journal_id or uuid.uuid4().hex))
    try:
        result = subprocess.run(argv, input=input_bytes, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired as exc:
        Path(str(base) + '.stdout.log').write_bytes(exc.stdout or b'')
        Path(str(base) + '.stderr.log').write_bytes(exc.stderr or b'')
        raise RuntimeError('CLI_TIMEOUT_OUTCOME_UNKNOWN') from None
    Path(str(base) + '.stdout.log').write_bytes(result.stdout)
    Path(str(base) + '.stderr.log').write_bytes(result.stderr)
    if result.returncode:
        raise RuntimeError('CLI_' + re.sub('[^A-Z0-9_]', '_', label.upper()) + '_EXIT_' + str(result.returncode))
    return result.stdout


def ctl(profile, *argv, label='n8n', input_bytes=None, journal_id=None):
    # CLI chỉ nhận một chế độ output; jq projection vẫn trả JSON để đọc.
    mode = [] if '--jq' in argv else ['--json']
    return json.loads(call([NODE, CLI, '--profile', profile, *mode, *argv], label, input_bytes, journal_id))


def resolve(profile, workflow_id=None, name=None):
    argv = [NODE, str(SCRIPTS / 'xac-dinh-dich-n8n.mjs'), '--expected-host', HOSTS[profile]]
    argv += ['--workflow-id', workflow_id, '--profile', profile, '--expected-name', name] if workflow_id else ['--instance-profile', profile]
    if not json.loads(call(argv, 'resolve-' + (workflow_id or profile))).get('ok'):
        raise RuntimeError('N8N_TARGET_UNVERIFIED')


def assert_no_pending(state):
    if state.get('pending'):
        raise RuntimeError('MUTATION_OUTCOME_UNKNOWN_RECONCILE_FIRST')


def dependencies(sources):
    # Mọi cạnh gọi con đóng trong graph cùng instance; cycle dừng trước API.
    rows = {row['workflow']['id']: row for row in sources}
    edges = {}
    if len(rows) != len(sources): raise RuntimeError('DUPLICATE_SOURCE_ID')
    for key, row in rows.items():
        edges[key] = set()
        for node in row['workflow']['nodes']:
            if node['type'] != 'n8n-nodes-base.executeWorkflow': continue
            ref = node['parameters']['workflowId']
            child = ref if isinstance(ref, str) else ref.get('value')
            if child not in rows or rows[child]['profile'] != row['profile']:
                raise RuntimeError('CHILD_OUTSIDE_GRAPH')
            edges[key].add(child)
    done, order = set(), []
    while len(done) != len(rows):
        ready = sorted(key for key, children in edges.items() if key not in done and children <= done)
        if not ready: raise RuntimeError('WORKFLOW_GRAPH_CYCLE')
        done.update(ready)
        order.extend(ready)
    return order


def sources():
    lock = json.loads((ROOT / 'ops/grading-source-lock.json').read_text(encoding='utf-8'))
    rows = []
    for pin in lock['workflows']:
        data = Path(pin['path']).read_bytes()
        workflow = json.loads(data)
        if hashlib.sha256(data).hexdigest() != pin['sha256'] or any(workflow[k] != pin[k] for k in ['id', 'name', 'versionId']):
            raise RuntimeError('PINNED_SOURCE_MISMATCH')
        rows.append({'profile': pin['profile'], 'workflow': workflow})
    if len(rows) != 49: raise RuntimeError('SOURCE_INVENTORY_MISMATCH')
    dependencies(rows)
    return rows


def register(profile, workflow_id, name):
    call([NODE, CLI, '--profile', profile, 'workflow', 'tag', workflow_id, 'Codex tạo', 'Tạm thời', '--create'], 'tag-' + workflow_id)
    # Register có thể đã ghi xong trước mất ACK: đối soát đúng bản ghi, không đăng ký trùng.
    ledger = json.loads(LIFECYCLE.read_text(encoding='utf-8'))
    if ledger.get('schemaVersion') != 1 or ledger.get('taskId') != 'k67-grading-separation-20261006':
        raise RuntimeError('LIFECYCLE_TASK_MISMATCH')
    matches = [row for row in ledger['workflows'] if row['id'] == workflow_id]
    if matches:
        expected = {'id': workflow_id, 'name': name, 'purpose': 'Tách bộ chấm K67, kiểm mô phỏng trước nhận bài',
                    'kind': 'temporary', 'status': 'open', 'expiresAt': '2026-10-13T00:00:00.000Z'}
        if len(matches) != 1 or any(matches[0].get(k) != v for k, v in expected.items()):
            raise RuntimeError('LIFECYCLE_ENTRY_MISMATCH')
        return
    call([NODE, str(SCRIPTS / 'quan-ly-vong-doi-workflow.mjs'), 'register', '--manifest', str(LIFECYCLE),
          '--workflow-id', workflow_id, '--name', name, '--purpose', 'Tách bộ chấm K67, kiểm mô phỏng trước nhận bài',
          '--kind', 'temporary', '--expires-at', '2026-10-13T00:00:00Z'], 'lifecycle-' + workflow_id)


def validate(path):
    call([NODE, CLI, 'workflow', 'validate', str(path)], 'validate-' + path.stem)
    call([NODE, str(SCRIPTS / 'kiem-tra-luu-execution-candidate.mjs'), str(path)], 'gate-' + path.stem)


def workflow_body(row):
    return {k: row[k] for k in ['name', 'nodes', 'connections', 'settings']}


def source_versions(rows):
    result = {}
    for row in rows:
        key = row['workflow']['id']
        observed = ctl(row['profile'], 'workflow', 'get', key, '--jq', '{id,name,versionId,active}', label='source-' + key)
        if observed.get('id') != key or observed.get('name') != row['workflow']['name']:
            raise RuntimeError('SOURCE_LIVE_IDENTITY_MISMATCH')
        result[row['profile'] + ':' + key] = observed
    return result


def create(state, profile, key, candidate):
    assert_no_pending(state)
    row = state['created'].get(key)
    if row:
        if row['profile'] != profile or row['name'] != candidate['name']: raise RuntimeError('OWN_ID_IDENTITY_MISMATCH')
        resolve(profile, row['id'], row['name'])
    else:
        path = PRIVATE / ('candidate-' + key + '.private.json')
        write(path, candidate)
        validate(path)
        state['pending'] = {'operation': 'create', 'profile': profile, 'key': key, 'name': candidate['name'],
                            'candidate_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                            'attempt_id': uuid.uuid4().hex, 'at': datetime.now(timezone.utc).isoformat()}
        write(STATE, state)
        result = ctl(profile, 'workflow', 'deploy', str(path), '--create-only', '--no-normalize',
                     label='create-' + key, journal_id=state['pending']['attempt_id'])
        if not result.get('created') or result.get('activated') or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', result.get('workflowId', '')):
            raise RuntimeError('CREATED_IDENTITY_MISMATCH')
        actual = result['workflowId']
        if actual in state['source_ids'] or actual in [r['id'] for r in state['created'].values()]: raise RuntimeError('CREATED_ID_COLLISION')
        row = {'id': actual, 'profile': profile, 'name': candidate['name'], 'registered': False}
        state['created'][key] = row
        state.pop('pending')
        write(STATE, state)
        resolve(profile, actual, row['name'])
    if not row['registered']:
        register(profile, row['id'], row['name'])
        row['registered'] = True
        write(STATE, state)
    observed = ctl(profile, 'workflow', 'get', row['id'], label='readback-' + row['id'])
    if observed['id'] != row['id'] or observed['active'] or workflow_body(observed) != workflow_body(candidate):
        raise RuntimeError('WORKFLOW_DEFINITION_READBACK_MISMATCH')
    write(PRIVATE / ('live-' + row['id'] + '.private.json'), observed)
    return row['id']


def instant(value):
    if not isinstance(value, str) or not re.search(r'(Z|[+-]\d\d:\d\d)$', value):
        raise RuntimeError('TIMESTAMP_OFFSET_MISSING')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def reconcile(state):
    # Đọc đúng ý định, file ứng viên và API; không create/update trong bước này.
    intent = state.get('pending', {})
    if intent.get('operation') != 'create' or intent.get('profile') not in HOSTS:
        raise RuntimeError('NO_PENDING_WORKFLOW_CREATE')
    key, attempt = intent.get('key', ''), intent.get('attempt_id', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', key) or not re.fullmatch(r'[0-9a-f]{32}', attempt):
        raise RuntimeError('PENDING_IDENTITY_INVALID')
    started = instant(intent['at'])
    if started > datetime.now(timezone.utc).timestamp(): raise RuntimeError('PENDING_TIMESTAMP_FUTURE')
    candidate_path = PRIVATE / ('candidate-' + key + '.private.json')
    if hashlib.sha256(candidate_path.read_bytes()).hexdigest() != intent['candidate_sha256']:
        raise RuntimeError('PENDING_CANDIDATE_CHANGED')
    candidate = json.loads(candidate_path.read_text(encoding='utf-8'))
    if candidate['name'] != intent['name']: raise RuntimeError('PENDING_NAME_MISMATCH')
    logs = list(PRIVATE.glob('create-' + key + '-*.stdout.log'))
    logs = [path for path in logs if path.stat().st_mtime >= started]
    # Các lượt mới ghim UUID log vào ý định; lượt cũ chỉ nhận một journal duy nhất.
    expected = PRIVATE / ('create-' + key + '-' + attempt + '.stdout.log')
    if expected.exists(): logs = [expected]
    if len(logs) != 1: raise RuntimeError('PENDING_JOURNAL_AMBIGUOUS')
    stdout_path = logs[0]
    stderr_path = stdout_path.with_name(stdout_path.name.replace('.stdout.log', '.stderr.log'))
    if stderr_path.stat().st_mtime < started: raise RuntimeError('PENDING_JOURNAL_STALE')
    output = stdout_path.read_text(encoding='utf-8').strip()
    error = stderr_path.read_text(encoding='utf-8').strip()
    profile = intent['profile']
    observed = ctl(profile, 'workflow', 'list', '--all', '--jq', '[.[] | {id,name,active,createdAt}]', label='reconcile-inventory-' + attempt)
    if not isinstance(observed, list): raise RuntimeError('WORKFLOW_INVENTORY_INVALID')
    matches = [row for row in observed if row['name'] == intent['name']]
    if len(matches) > 1: raise RuntimeError('PENDING_NAME_AMBIGUOUS')
    if matches:
        row = ctl(profile, 'workflow', 'get', matches[0]['id'], label='reconcile-readback-' + attempt)
        actual = row.get('id', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', actual) or actual in state['source_ids'] or actual in [r['id'] for r in state['created'].values()]:
            raise RuntimeError('RECONCILED_ID_COLLISION')
        if row.get('active') is not False or instant(row['createdAt']) < started or workflow_body(row) != workflow_body(candidate):
            raise RuntimeError('RECONCILED_DEFINITION_MISMATCH')
        state['created'][key] = {'id': actual, 'profile': profile, 'name': row['name'], 'registered': False}
        result = {'status': 'created_readback', 'workflow_id': actual}
    else:
        # DNS không tìm được host là lỗi trước khi gửi request. Timeout/ACK mất vẫn unknown.
        host = HOSTS[profile].split('://')[1]
        expected_error = 'error: n8n API request failed: getaddrinfo ENOTFOUND ' + host + ' (ENOTFOUND)\nhint: Check that N8N_HOST is reachable and your network is up.'
        if output or error != expected_error: raise RuntimeError('CREATE_OUTCOME_STILL_UNKNOWN')
        result = {'status': 'not_created_dns_failure', 'workflow_id': None}
    evidence = {**result, 'intent': intent, 'observed_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'stdout': {'path': str(stdout_path), 'sha256': hashlib.sha256(stdout_path.read_bytes()).hexdigest()},
                'stderr': {'path': str(stderr_path), 'sha256': hashlib.sha256(stderr_path.read_bytes()).hexdigest()},
                'exact_name_matches': len(matches)}
    evidence_path = PRIVATE / ('reconciled-' + attempt + '.json')
    if evidence_path.exists():
        # Receipt có thể đã lưu trước khi STATE mất ACK; chỉ replay cùng chứng cứ đã đọc lại.
        previous = json.loads(evidence_path.read_text(encoding='utf-8'))
        observed_at = instant(previous.get('observed_at'))
        if not started <= observed_at <= datetime.now(timezone.utc).timestamp() or previous != {**evidence, 'observed_at': previous.get('observed_at')}:
            raise RuntimeError('RECONCILIATION_RECEIPT_MISMATCH')
    else:
        write(evidence_path, evidence)
    state['last_reconciliation'] = {'path': str(evidence_path), 'sha256': hashlib.sha256(evidence_path.read_bytes()).hexdigest(), **result}
    state.pop('pending')
    write(STATE, state)
    print(json.dumps({'outcome': 'success', 'reconciled': result}))


def prepare(state, rows):
    assert_no_pending(state)
    redis = json.loads((PRIVATE.parent / 'n8n-redis-fixture/state.json').read_text(encoding='utf-8'))
    resolve('default', redis['error_workflow'], 'K67 · Ghi nhận lỗi chấm bài')
    if not VAULT.exists():
        payload = {'product_id': 'PRODUCT-TERM-MINI-K67', **{key: secrets.token_urlsafe(48) for key in ['notify', 'grading_sync', 'erp_sync', 'mini_sync', 'session']}}
        with VAULT.open('xb') as vault:
            vault.write(win32crypt.CryptProtectData(json.dumps(payload).encode(), 'K67 service keys', None, None, None, 0))
    keys = json.loads(win32crypt.CryptUnprotectData(VAULT.read_bytes(), None, None, None, 0)[1])
    if keys['product_id'] != 'PRODUCT-TERM-MINI-K67': raise RuntimeError('SERVICE_VAULT_IDENTITY_MISMATCH')
    if not state.get('notify_credential'):
        state['pending'] = {'operation': 'credential-create', 'profile': 'default', 'attempt_id': uuid.uuid4().hex}
        write(STATE, state)
        credential = {'name': 'K67 · Khóa nhận thông báo bài viết', 'type': 'httpHeaderAuth', 'data': {'name': 'x-term-test-notify', 'value': keys['notify']}}
        result = ctl('default', 'credential', 'create', '-', label='notify-credential', input_bytes=json.dumps(credential).encode())
        if not result.get('id') or result.get('name') != credential['name'] or result.get('type') != credential['type']:
            raise RuntimeError('CREDENTIAL_IDENTITY_MISMATCH')
        state['notify_credential'] = {'id': result['id'], 'name': result['name']}
        state.pop('pending')
        write(STATE, state)
    error = {'name': 'K67 · Ghi nhận lỗi gửi điểm', 'active': False, 'nodes': [
        {'id': '6e8a707a-50c9-4bbb-a68d-b6f8356a1a46', 'name': 'Nhận lỗi gửi điểm', 'type': 'n8n-nodes-base.errorTrigger', 'typeVersion': 1, 'position': [0, 0], 'parameters': {}},
        {'id': 'eb44313d-ae92-4cf6-ac3d-ba364ef8e85d', 'name': 'Giữ mã lỗi để kiểm', 'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'position': [240, 0],
         'parameters': {'jsCode': "// Nhận lỗi gửi điểm; giữ mã execution, không lưu bài hoặc khóa.\nconst x = $input.first().json;\nconst data = {\n  product_id: 'PRODUCT-TERM-MINI-K67',\n  execution_id: String(x.execution?.id ?? '')\n};\nreturn [{ json: data }];"}}],
        'connections': {'Nhận lỗi gửi điểm': {'main': [[{'node': 'Giữ mã lỗi để kiểm', 'type': 'main', 'index': 0}]]}}, 'settings': SETTINGS}
    error_id = create(state, 'izone-ai', 'error-writer', error)
    if not TARGET.exists():
        target = {'workflowIds': {r['workflow']['id']: 'k67planned' + uuid.uuid4().hex for r in rows}, 'credentials': {}, 'webhooks': {},
                  'errorWorkflowIds': {'default': redis['error_workflow'], 'izone-ai': error_id}}
        for row in rows:
            w, profile = row['workflow'], row['profile']
            for node in w['nodes']:
                for kind, credential in node.get('credentials', {}).items():
                    key = profile + ':' + kind + ':' + credential['id']
                    if kind == 'redis': binding = redis['redis_credential']
                    elif credential['id'] == 'SbMX3RH2NEySJUE5': binding = state['notify_credential']
                    elif credential['id'] in ['pk7LZxI0lKarGnwy', '5t3dhy3tWIoPzmXc']: binding = credential
                    else: raise RuntimeError('CREDENTIAL_NOT_IN_PINNED_INVENTORY')
                    target['credentials'][key] = binding
                if node['type'] == 'n8n-nodes-base.webhook':
                    slug = 'nhan-bai-viet' if profile == 'default' else 'gui-diem-ve-lop'
                    target['webhooks'][w['id'] + ':' + node['id']] = {'webhookId': str(uuid.uuid4()), 'path': 'term-mini-k67-' + slug}
        write(TARGET, target)
    state['target_prepared'] = True
    write(STATE, state)
    print(json.dumps({'outcome': 'success', 'target_prepared': True, 'active': False}))


def export(target_path, output):
    call([NODE, str(ROOT / 'tools/prepare-grading-bundle.mjs'), '--target', str(target_path), '--output', str(output)], 'export-' + output.name)
    manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['status'] != 'complete' or len(manifest['workflows']) != 49: raise RuntimeError('EXPORT_NOT_COMPLETE')
    return manifest


def deploy(state, rows):
    assert_no_pending(state)
    if not state.get('target_prepared'): raise RuntimeError('TARGET_NOT_PREPARED')
    target = json.loads(TARGET.read_text(encoding='utf-8'))
    initial = PRIVATE / 'initial-candidates'
    if not initial.exists(): export(TARGET, initial)
    inventory = json.loads((initial / 'manifest.json').read_text(encoding='utf-8'))
    expected = {r['sourceId']: json.loads(Path(r['path']).read_text(encoding='utf-8')) for r in inventory['workflows']}
    # Hash luôn kiểm khi resume; validate đủ 49 trước create đầu tiên.
    for row in inventory['workflows']:
        if hashlib.sha256(Path(row['path']).read_bytes()).hexdigest() != row['sha256']: raise RuntimeError('CANDIDATE_HASH_MISMATCH')
        if not state.get('candidates_validated'): validate(Path(row['path']))
    state['candidates_validated'] = inventory['target_sha256']
    write(STATE, state)
    profiles = {row['workflow']['id']: row['profile'] for row in rows}
    planned_to_actual = {expected[key]['id']: row['id'] for key, row in state['created'].items() if key in expected}
    for key in dependencies(rows):
        candidate = json.loads(json.dumps(expected[key]))
        for node in candidate['nodes']:
            if node['type'] == 'n8n-nodes-base.executeWorkflow':
                ref = node['parameters']['workflowId']
                old = ref if isinstance(ref, str) else ref['value']
                if old not in planned_to_actual: raise RuntimeError('REAL_CHILD_ID_NOT_READY')
                node['parameters']['workflowId'] = planned_to_actual[old] if isinstance(ref, str) else {**ref, 'value': planned_to_actual[old]}
        actual = create(state, profiles[key], key, candidate)
        planned_to_actual[expected[key]['id']] = actual
        target['workflowIds'][key] = actual
        write(TARGET, target)
        state['created'][key]['readback_verified'] = True
        write(STATE, state)
        print(json.dumps({'outcome': 'progress', 'readback_verified': sum(bool(r.get('readback_verified')) for r in state['created'].values()), 'expected': 49, 'active': False}), flush=True)
    final = PRIVATE / 'final-candidates'
    if not final.exists(): export(TARGET, final)
    manifest = json.loads((final / 'manifest.json').read_text(encoding='utf-8'))
    for row in manifest['workflows']:
        candidate = json.loads(Path(row['path']).read_text(encoding='utf-8'))
        observed = json.loads((PRIVATE / ('live-' + row['targetId'] + '.private.json')).read_text(encoding='utf-8'))
        if workflow_body(candidate) != workflow_body(observed) or observed['active']: raise RuntimeError('FINAL_GRAPH_READBACK_MISMATCH')
    state['definition_readback_complete'] = True
    write(STATE, state)
    print(json.dumps({'outcome': 'success', 'definitions': 49, 'active': False, 'executed': False}))


def main():
    sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
    sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--deploy-inactive', action='store_true')
    mode.add_argument('--reconcile', action='store_true')
    args = parser.parse_args()
    PRIVATE.mkdir(exist_ok=True)
    rows = sources()
    state = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {
        'schema_version': 1, 'product_id': 'PRODUCT-TERM-MINI-K67', 'created': {}, 'source_ids': [r['workflow']['id'] for r in rows]}
    if state['product_id'] != 'PRODUCT-TERM-MINI-K67' or state['source_ids'] != [r['workflow']['id'] for r in rows]: raise RuntimeError('PROVISION_STATE_IDENTITY_MISMATCH')
    if not args.reconcile: assert_no_pending(state)
    if not NODE or call([NODE, '--version'], 'node-version').decode().strip() != 'v24.15.0': raise RuntimeError('NODE_VERSION_MISMATCH')
    for profile in HOSTS: resolve(profile)
    spec = importlib.util.spec_from_file_location('redis_fixture', ROOT / 'tools/prepare-redis-fixture.py')
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    audit_path = PRIVATE / ('protected-' + uuid.uuid4().hex + '.json')
    audit = {'stage': 'reconcile' if args.reconcile else 'prepare' if args.prepare else 'deploy-inactive', 'outcome': 'unknown'}
    operation_error = guard_error = None
    try:
        client = fixture.connect()
        try: audit['before'] = fixture.protected(client)
        finally: client.close()
        audit['source_before'] = source_versions(rows)
        write(audit_path, audit)
        if args.reconcile: reconcile(state)
        elif args.prepare: prepare(state, rows)
        else: deploy(state, rows)
        audit['source_after'] = source_versions(rows)
        if audit['source_before'] != audit['source_after']: raise RuntimeError('SOURCE_CHANGED_DURING_PROVISION')
        audit['outcome'] = 'passed'
    except Exception as exc:
        operation_error = exc
        audit['operation_error'] = str(exc) if re.fullmatch(r'[A-Z_0-9]+', str(exc)) else type(exc).__name__
        audit['outcome'] = 'failure'
    finally:
        # Lượt API dài không giữ SSH nhàn rỗi; lỗi guard được giữ riêng, không che lỗi dựng.
        try:
            client = fixture.connect()
            try: audit['after'] = fixture.protected(client)
            finally: client.close()
            if audit.get('before') != audit['after']:
                raise RuntimeError('PROTECTED_STATE_CHANGED')
        except Exception as exc:
            guard_error = exc
            audit['guard_error'] = str(exc) if re.fullmatch(r'[A-Z_0-9]+', str(exc)) else type(exc).__name__
            audit['outcome'] = 'unknown'
        finally:
            write(audit_path, audit)
    if operation_error: raise operation_error
    if guard_error: raise RuntimeError('PROTECTION_READBACK_FAILED') from guard_error


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        code = str(exc) if re.fullmatch(r'[A-Z_0-9]+', str(exc)) else type(exc).__name__
        print(json.dumps({'outcome': 'failure', 'code': code, 'state': str(STATE)}))
        sys.exit(1)
