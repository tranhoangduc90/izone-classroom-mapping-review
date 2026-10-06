"""Nối đúng ba workflow K67 vào backend/Portal giả, giữ baseline và ý định bền vững.
--keys chỉ seed khóa riêng; --deploy validate/đọc nguồn/guard/update/readback inactive.
--restore phục hồi baseline khi overlay còn đúng version. Không bật lịch hoặc gọi AI.
Khi mất ACK, đọc lại đúng ý định trước tiếp; không tạo credential trùng hoặc ghi đè.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import uuid
import requests
import msvcrt

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path('E:/Codex-Data/k67-backend-separation-20261006/grading-fixture')
STATE = PRIVATE / 'state.json'
SDK = ROOT / 'ops/grading-fixture.mjs'
ROLES = {
    'event': ('default', 'pY437GnW09WmD9b2', 'a68b16633ffdc59c03f04c544a85c052166c0d062abbc3768817332cae702b9b'),
    'poll': ('default', 'qj1aGCo406QsXtai', '0bd1925ced423e51ab28d02670e3d26a06d9fc8a9e671c232d6a1f7eba9bcaa7'),
    'writer': ('izone-ai', 'nwp6ERqWKb2FkgFl', '8f35b0db4a264792e513c223c25fa85eef2fb48d6612d84423af0f327aefb6f2')}

@contextmanager
def single_owner(path):
    # Chỉ một tiến trình task giữ quyền sửa cùng resource; UI ngoài task không bị khóa bởi đây.
    with path.open('a+b') as stream:
        if stream.tell() == 0: stream.write(b'1'); stream.flush()
        stream.seek(0)
        try: msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError: raise RuntimeError('OWN_FIXTURE_ALREADY_IN_USE') from None
        try: yield
        finally:
            stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / file)
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded); return loaded

def call(p, argv, label, payload=None, attempt=None, accepted_exit_codes=(0,)):
    # Lưu stdout/stderr thật theo UUID; không in payload/exception HTTP có secret.
    base = PRIVATE / (label + '-' + (attempt or uuid.uuid4().hex))
    try: result = subprocess.run(argv, input=json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None,
                                  capture_output=True, timeout=180)
    except subprocess.TimeoutExpired as exc:
        Path(str(base) + '.stdout.log').write_bytes(exc.stdout or b'')
        Path(str(base) + '.stderr.log').write_bytes(exc.stderr or b'')
        raise RuntimeError('CLI_TIMEOUT_OUTCOME_UNKNOWN') from None
    Path(str(base) + '.stdout.log').write_bytes(result.stdout); Path(str(base) + '.stderr.log').write_bytes(result.stderr)
    if result.returncode not in accepted_exit_codes: raise RuntimeError('CLI_EXIT_' + str(result.returncode))
    parsed = json.loads(result.stdout)
    if result.returncode:
        parsed['_native_exit_code'] = result.returncode
        parsed['_stdout_sha256'] = hashlib.sha256(result.stdout).hexdigest()
    return parsed

def sdk(p, payload, label, attempt=None): return call(p, [p.NODE, str(SDK)], label, payload, attempt)

def baselines(h):
    result = {}
    for role, (profile, identity, pin) in ROLES.items():
        store = Path('E:/Codex-Data/n8n-workflow-versions') / identity / ('k67-fixture-' + role + '-20261006')
        manifest = json.loads((store / 'manifest.json').read_text(encoding='utf-8'))
        files = list((store / 'incoming').glob('*.json'))
        if len(files) != 1 or h.sha(files[0].read_bytes()) != pin: raise RuntimeError('VERSIONED_BASELINE_CHANGED')
        w = json.loads(files[0].read_text(encoding='utf-8'))
        if w['id'] != identity or w.get('active') is not False: raise RuntimeError('BASELINE_ID_OR_STATE_CHANGED')
        expected = {'schema_version': 1, 'workflow_id': identity, 'workflow_name': w['name'],
                    'profile': profile, 'host': 'https://n8n-ai.izone.edu.vn' if profile == 'izone-ai' else 'https://ducizone.ddns.net',
                    'task_id': 'k67-fixture-' + role + '-20261006'}
        if any(manifest.get(k) != v for k, v in expected.items()): raise RuntimeError('VERSION_MANIFEST_IDENTITY_CHANGED')
        captures = [r for r in manifest['captures'] if r['kind'] == 'before' and r['sha256'] == pin]
        if len(captures) != 1 or captures[0]['version_id'] != w['versionId'] \
          or h.sha((store / captures[0]['file']).read_bytes()) != pin: raise RuntimeError('VERSION_CAPTURE_CHANGED')
        result[role] = w
    return result

def persist(h, state): h.atomic(STATE, state)

def begin(h, state, operation, **fields):
    if state.get('pending'): raise RuntimeError('PENDING_MUTATION_RECONCILE_FIRST')
    state['pending'] = {'operation': operation, 'attempt': uuid.uuid4().hex,
        'at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), **fields}
    persist(h, state); return state['pending']['attempt']

def complete(h, state): state.pop('pending', None); persist(h, state)

def candidate_path(state, role):
    repair = state.get('writer_repair', {}) if role == 'writer' else {}
    if repair.get('status') == 'applied':
        path = Path(repair['candidate_path'])
        if hashlib.sha256(path.read_bytes()).hexdigest() != repair['candidate_sha256']:
            raise RuntimeError('WRITER_REPAIR_CANDIDATE_CHANGED')
        return path
    return PRIVATE / (role + '.candidate.private.json')

def source_versions(p):
    result = {}
    rows = p.sources()
    for profile in p.HOSTS:
        pins = [{'id': r['workflow']['id'], 'name': r['workflow']['name']} for r in rows if r['profile'] == profile]
        observed = sdk(p, {'operation': 'source-versions', 'profile': profile, 'sources': pins}, 'source-' + profile)
        result.update(observed['versions'])
    if len(result) != 49: raise RuntimeError('SOURCE_INVENTORY_MISMATCH')
    return result

def keys(h, u, p, state, fixture, service, own):
    client = u.connect()
    try:
        u.inspect_fixture(client)
        sftp = client.open_sftp()
        try:
            with sftp.open(u.REMOTE + '/redis.conf', 'rb') as stream: actual_config = stream.read()
        finally: sftp.close()
        if actual_config != u.config(u.password()): raise RuntimeError('REDIS_CONFIG_CHANGED')
        pending = state.get('pending')
        if pending and pending['operation'] != 'redis':
            if not state.get('redis_ready'): raise RuntimeError('PENDING_MUTATION_RECONCILE_FIRST')
        else:
            value = u.cli(client, 'GET termmini:k67:sync_secret')
            if value not in ['', service['grading_sync']]: raise RuntimeError('REDIS_SECRET_COLLISION')
            if not value:
                if not pending: begin(h, state, 'redis')
                result = u.cli(client, 'SET termmini:k67:sync_secret ' + service['grading_sync'] + ' NX')
                if result not in ['', 'OK']: raise RuntimeError('REDIS_SEED_UNKNOWN')
            if u.cli(client, 'GET termmini:k67:sync_secret') != service['grading_sync']: raise RuntimeError('REDIS_SECRET_READBACK_FAILED')
            state['redis_ready'] = True; complete(h, state)
    finally: client.close()
    pending = state.get('pending')
    request = {'operation': 'variable', 'profile': 'izone-ai', 'key': 'K67_ERP_SYNC_SECRET', 'value': service['erp_sync']}
    if not pending or pending['operation'] == 'variable':
        observed = sdk(p, {**request, 'create': False}, 'variable-read')
        if not observed['matched']:
            if not pending: begin(h, state, 'variable')
            observed = sdk(p, {**request, 'create': True}, 'variable-create', state['pending']['attempt'])
        if not observed['matched']: raise RuntimeError('VARIABLE_NOT_READBACK')
        state['variable_id'] = observed['id']; complete(h, state)
    elif not state.get('variable_id'): raise RuntimeError('PENDING_MUTATION_RECONCILE_FIRST')
    if not state.get('portal_credential'):
        pending = state.get('pending')
        if pending:
            if pending['operation'] != 'credential': raise RuntimeError('PENDING_MUTATION_RECONCILE_FIRST')
            journal = PRIVATE / ('credential-create-' + pending['attempt'] + '.stdout.log')
            if not journal.exists(): raise RuntimeError('CREDENTIAL_CREATE_OUTCOME_UNKNOWN')
            try: result = json.loads(journal.read_text(encoding='utf-8'))
            except ValueError: raise RuntimeError('CREDENTIAL_CREATE_OUTCOME_UNKNOWN') from None
        else:
            attempt = begin(h, state, 'credential')
            candidate = {'name': 'K67 · Khóa Portal giả để diễn tập', 'type': 'httpHeaderAuth',
                'data': {'name': 'x-k67-fixture-service', 'value': own['portal']}}
            result = call(p, [p.NODE, p.CLI, '--profile', 'izone-ai', '--json', 'credential', 'create', '-'],
                          'credential-create', candidate, attempt)
        if result.get('name') != 'K67 · Khóa Portal giả để diễn tập' or result.get('type') != 'httpHeaderAuth' \
          or not re.fullmatch('[A-Za-z0-9_-]{8,128}', result.get('id', '')): raise RuntimeError('CREDENTIAL_IDENTITY_MISMATCH')
        state['portal_credential'] = {k: result[k] for k in ['id', 'name']}; complete(h, state)

def candidates(h, p, state, before):
    if not state.get('portal_credential'): raise RuntimeError('FIXTURE_KEYS_NOT_READY')
    out = {}
    for role, w in before.items():
        candidate = sdk(p, {'operation': 'overlay', 'workflow': w, 'options': {'role': role, 'profile': ROLES[role][0],
          'intent': state['intent'], 'credential': state['portal_credential']}}, 'overlay-' + role)
        repair = state.get('writer_repair', {}) if role == 'writer' else {}
        if repair.get('status') == 'applied':
            candidate = sdk(p, {'operation':'repair-writer-readback','profile':'izone-ai','workflow':candidate}, 'overlay-repaired-writer')
        path = candidate_path(state, role)
        if path.exists() and json.loads(path.read_text(encoding='utf-8')) != candidate: raise RuntimeError('OVERLAY_CANDIDATE_CHANGED')
        if not path.exists(): h.atomic(path, candidate)
        p.validate(path)
        scripts = Path('E:/wt/k67-fixture-' + role + '-20261006/n8n-root/n8n-workflows/scripts')
        store = Path('E:/Codex-Data/n8n-workflow-versions') / ROLES[role][1] / ('k67-fixture-' + role + '-20261006')
        baseline = store / 'candidate/candidate.private.json'
        if h.sha(baseline.read_bytes()) != ROLES[role][2]: raise RuntimeError('VERSION_CANDIDATE_CHANGED')
        gate = call(p, [p.NODE, str(scripts / 'kiem-tra-thay-doi-trigger.mjs'), '--before', str(baseline), '--after', str(path), '--json'], 'trigger-' + role)
        if gate.get('headless_deploy_blocked'): raise RuntimeError('TRIGGER_DEPLOY_BLOCKED')
        lineage = call(p, [p.NODE, str(scripts / 'check-item-lineage-risk.mjs'), '--json', str(path)],
                       'lineage-' + role, accepted_exit_codes=(0, 1))
        if lineage.get('ok') is not True:
            # Cún đã rà đúng Webhook một bài và topology tuyến tính của candidate này.
            # Giữ exit1/risk=true; ngoại lệ không bao phủ batch hoặc candidate thay đổi.
            qualified_repair = False
            if repair.get('status') == 'applied':
                report_path = PRIVATE / 'writer-repair/review.private.json'
                report = json.loads(report_path.read_text(encoding='utf-8'))
                qualified_repair = h.sha(report_path.read_bytes()) == repair.get('review_sha256') \
                    and report.get('candidate_sha256') == h.sha(path.read_bytes()) \
                    and report.get('spec_compliance') == 'passed' and report.get('code_quality') == 'passed'
            qualified_original = h.sha(path.read_bytes()) == '26639c562d3c14dd0e62e199137cdebd7973762d857b03272afe6eb7467a4a38' \
                and lineage.get('_stdout_sha256') == 'e7e5e5c10ed450c4d921d2d034e52467de8c3e5949c8bf81fa1cf925d4a51b60'
            if role != 'writer' or lineage.get('_native_exit_code') != 1 or not (qualified_original or qualified_repair):
                raise RuntimeError('LINEAGE_REVIEW_REQUIRED')
            h.atomic(PRIVATE / ('writer-repair/lineage-reviewed.json' if qualified_repair else 'writer-lineage-reviewed.json'), {
                'status': 'reviewed_single_entity_pending_native_readback',
                'reviewer': '/root/cun', 'native_exit_code': 1, 'risk': True,
                'candidate_sha256': h.sha(path.read_bytes()), 'report_sha256': lineage['_stdout_sha256'],
                'limit': 'HTTP webhook một bài và Portal stub response object; không áp dụng batch'})
        out[role] = candidate
    return out

def deploy(h, p, state, before, overlays, restore=False):
    pending = state.get('pending')
    for role in ROLES:
        if pending and (pending['operation'] != ('restore' if restore else 'workflow') or pending.get('role') != role):
            if role not in state.get('workflows', {}): raise RuntimeError('PENDING_MUTATION_RECONCILE_FIRST')
            continue
        old, new = before[role], overlays[role]
        if restore:
            recorded = state.get('workflows', {}).get(role)
            if not recorded: continue
            old, new = {**overlays[role], 'versionId': recorded['versionId']}, before[role]
        payload = {'operation': 'workflow', 'profile': ROLES[role][0], 'role': role, 'before': old, 'candidate': new}
        observed = sdk(p, {**payload, 'update': False}, 'read-' + role)
        if observed['classification'] == 'before':
            if not pending: begin(h, state, 'restore' if restore else 'workflow', role=role)
            observed = sdk(p, {**payload, 'update': True}, 'update-' + role, state['pending']['attempt'])
        if observed['classification'] != 'candidate': raise RuntimeError('WORKFLOW_READBACK_FAILED')
        state.setdefault('workflows', {})[role] = {'versionId': observed['versionId'], 'body_sha256': observed['body_sha256'],
             'stage': 'restored' if restore else 'overlay_inactive'}
        complete(h, state); pending = None
        print(json.dumps({'outcome': 'progress', 'role': role, 'stage': state['workflows'][role]['stage']}), flush=True)

def main():
    sys.stdout.reconfigure(encoding='utf-8', line_buffering=True); sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)
    parser = argparse.ArgumentParser(); modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--keys', action='store_true'); modes.add_argument('--deploy', action='store_true'); modes.add_argument('--restore', action='store_true')
    args = parser.parse_args(); PRIVATE.mkdir(exist_ok=True)
    h = module('http_fixture', 'prepare-http-fixture.py'); u = h.utilities(); p = module('grading_provision', 'provision-grading-bundle.py')
    fixture = json.loads(h.STATE.read_text(encoding='utf-8')); h.validate_state(fixture)
    own = h.vault(h.STORE / 'credentials.dpapi'); service = h.vault(p.VAULT)
    if own.get('identity') != h.IDENTITY or own.get('intent_id') != fixture['intent_id'] or service.get('product_id') != 'PRODUCT-TERM-MINI-K67':
        raise RuntimeError('SERVICE_VAULT_IDENTITY_MISMATCH')
    before = baselines(h)
    expected = {'product_id': 'PRODUCT-TERM-MINI-K67', 'intent': fixture['intent_id'], 'baseline_pins': {role: row[2] for role, row in ROLES.items()}}
    state = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else expected
    if any(state.get(k) != v for k, v in expected.items()): raise RuntimeError('GRADING_FIXTURE_STATE_MISMATCH')
    if args.keys and state.get('pending', {}).get('operation') not in [None, 'redis', 'variable', 'credential']:
        raise RuntimeError('PENDING_MUTATION_RECONCILE_FIRST')
    persist(h, state)
    client = u.connect()
    try:
        protected_before = u.protected(client)
        for name in [h.APP, h.GATE]: h.check_container(json.loads(u.remote(client, ['docker', 'inspect', name]))[0], fixture, name)
        if h.sql(u, client, fixture['database'], "SELECT product_id||':'||fixture_id FROM mapping.k67_fixture_identity") \
          != 'PRODUCT-TERM-MINI-K67:' + fixture['intent_id']: raise RuntimeError('FIXTURE_DB_MARKER_MISMATCH')
    finally: client.close()
    run_id = 'k67-grading-fixture-' + uuid.uuid4().hex; error = guard_error = None
    revision = h.fingerprint(); source_before = source_versions(p)
    try:
        if args.keys: keys(h, u, p, state, fixture, service, own)
        else:
            if args.deploy:
                route = json.loads((h.PRIVATE / 'portal-fixture-route/state.json').read_text(encoding='utf-8'))
                if route.get('stage') != 'ready' or route.get('intent') != state['intent']: raise RuntimeError('PORTAL_ROUTE_NOT_READY')
                response = requests.get('https://ducizone.ddns.net:18868/k67-portal-fixture/' + state['intent'] + '/1124/student-tests',
                    headers={'x-k67-fixture-service': own['portal']}, timeout=20, allow_redirects=False)
                if response.status_code != 200: raise RuntimeError('PORTAL_ROUTE_AUTH_NOT_READY')
            overlays = candidates(h, p, state, before)
            for role, w in before.items(): p.resolve(ROLES[role][0], w['id'], w['name'])
            deploy(h, p, state, before, overlays, args.restore)
        source_after = source_versions(p)
        if source_before != source_after: raise RuntimeError('SOURCE_CHANGED_DURING_FIXTURE')
    except Exception as exc: error = str(exc) if re.fullmatch('[A-Z_0-9]+', str(exc)) else type(exc).__name__; source_after = None
    finally:
        try:
            client = u.connect()
            try: protected_after = u.protected(client)
            finally: client.close()
            if protected_before != protected_after: raise RuntimeError('PROTECTED_STATE_CHANGED')
        except Exception as exc: protected_after = None; guard_error = type(exc).__name__
    after_revision = h.fingerprint()
    receipt = {'run_id': run_id, 'tree_revision': revision, 'observed_after_revision': after_revision,
        'operation': 'keys' if args.keys else 'restore' if args.restore else 'deploy',
        'outcome': 'passed' if not error and not guard_error and revision == after_revision else 'unknown',
        'operation_error': error, 'guard_error': guard_error, 'protected_before': protected_before, 'protected_after': protected_after,
        'source_before': source_before, 'source_after': source_after, 'intent': state['intent'], 'pending': state.get('pending'),
        'observed_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}
    h.atomic(PRIVATE / (run_id + '.json'), receipt)
    print(json.dumps({k: receipt[k] for k in ['run_id', 'operation', 'outcome', 'operation_error', 'guard_error']}))
    return 0 if receipt['outcome'] == 'passed' else 1

if __name__ == '__main__':
    try:
        PRIVATE.mkdir(exist_ok=True)
        with single_owner(PRIVATE / 'operation.lock'): sys.exit(main())
    except Exception as exc:
        print(json.dumps({'outcome': 'failure', 'code': str(exc) if re.fullmatch('[A-Z_0-9]+', str(exc)) else type(exc).__name__}))
        sys.exit(1)
