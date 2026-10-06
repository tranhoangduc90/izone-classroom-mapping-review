"""Diễn tập n8n/AI thật bằng ba lượt thi giả trong DB K67 đã nhận diện.
Nhận phase và journal bền vững; chạy tối đa ba dispatch, không retry AI tự động.
Giữ execution ID trước khi chờ; đọc lại callback/DB/Portal, sai nguồn thì dừng.
Secret chỉ ở DPAPI/bộ nhớ; raw execution và token giả chỉ ở kho riêng tư trên E.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import copy
import hashlib
import importlib.util
import json
import re
import select
import socketserver
import sys
import threading
import time
import uuid
import requests

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path('E:/Codex-Data/k67-backend-separation-20261006/grading-native')
STATE = PRIVATE / 'state.json'

# Bài viết giả chỉ dùng kiểm đường truyền/chấm; không phải đáp án cho học viên.
ESSAYS = {
 'term-test-1': {'task1': '', 'task2': '''Many teachers report that children struggle to maintain their attention during lessons. I believe that this problem is mainly caused by constant digital stimulation and unsuitable daily routines. Both families and schools can take practical steps to help children concentrate more effectively.

The first cause is the design of online entertainment. Short videos and mobile games offer an immediate reward every few seconds, whereas a classroom explanation usually requires sustained effort. A child who spends several hours switching between videos may find a normal lesson unusually slow. Another factor is inadequate sleep. When children use their phones late at night, they arrive at school tired and have difficulty following instructions. These habits can reinforce each other because a tired child often seeks easy entertainment instead of completing homework.

Parents should therefore establish reasonable limits on recreational screen time and keep phones outside bedrooms at night. The aim should be to create a predictable routine rather than punish children whenever they become distracted. Reading together, outdoor exercise and regular bedtimes provide alternatives that support both physical health and attention. Parents also need to demonstrate these habits themselves, since children notice when adults ignore the rules they impose.

Schools can make a complementary contribution. Teachers could divide a long explanation into manageable sections and include short activities that require students to answer questions or discuss an example. Clear instructions and brief movement breaks can help younger pupils return to the task. However, these methods should still encourage sustained thinking instead of turning every lesson into rapid entertainment.

In conclusion, excessive digital stimulation and poor routines are major reasons for children's concentration difficulties. Consistent support at home and carefully structured teaching can address these causes without placing the entire responsibility on children.'''},
 'term-test-2': {'task1': '''The table compares participation in several physical activities in Australia in 2001 and 2009, with the figures expressed in millions of people.

Overall, the activities did not all follow the same pattern. Some attracted more participants by the end of the period, while others became less popular. There were also noticeable differences in the number of people taking part in each activity in both years.

The activities with increasing participation contributed to a broader range of physical exercise in 2009. Their later figures were higher than their initial figures, although the scale of the increase varied between categories. This means that a rise in participation was not equally strong across every growing activity.

By contrast, the activities that declined recorded fewer participants in 2009 than in 2001. These decreases should be considered alongside the increases rather than interpreted as evidence that every physical activity became less popular. Comparing the two years therefore shows a change in people's preferences across different activities.''',
 'task2': '''People increasingly choose keyboards and touchscreens instead of writing with pens, pencils or brushes. This trend is largely explained by the convenience of digital communication. In my view, it is generally a positive development, although schools should continue to teach basic handwriting skills.

One reason for the decline is that most everyday communication now takes place online. A message typed on a phone can reach someone immediately, while a handwritten letter must be delivered physically. Digital documents are also easier to edit, search and share. An employee can correct a report without rewriting an entire page and can send the revised version to colleagues in different locations. These practical advantages make typing the natural choice for many tasks.

The change also brings useful benefits. People who have difficulty gripping a pen may find an accessible keyboard or speech recognition tool much easier to use. Electronic records can help organisations locate information quickly and reduce the space needed for paper files. For students, typing allows ideas to be reorganised while an essay is being developed, which can make revision more manageable. These benefits concern access and efficiency rather than simply the appearance of the finished document.

Nevertheless, abandoning handwriting completely would be unwise. Children need to recognise letter shapes and learn to write clearly enough for situations where a digital device is unavailable. Handwritten notes can also feel personal, and drawing or writing by hand remains valuable in artistic activities. Schools can preserve these skills without requiring handwriting for every assignment. A balanced approach would teach both handwriting and confident use of digital tools.

In conclusion, speed, flexibility and widespread access to digital technology explain why fewer people write by hand. The overall change is beneficial provided that essential handwriting skills continue to be taught and practised.'''}
}

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / file)
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded); return loaded

def utc(): return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def check(condition, code):
    if not condition: raise RuntimeError(code)

def snapshot(h, u, client, fixture):
    # Chỉ projection bài giả; không đọc source DB hoặc bài học viên thật.
    return json.loads(h.sql(u, client, fixture['database'], """SELECT jsonb_build_object(
      'attempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'attemptToken',id,'slug',test_slug,
        'classId',erp_course_class_id,'studentId',erp_student_contact_id,'writingSubmittedAt',writing_submitted_at,
        'completedAt',completed_at) ORDER BY test_slug),'[]'::jsonb) FROM assessment.term_test_attempt),
      'runs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'attemptId',attempt_id,'taskNumber',task_number,
        'runKey',run_key,'status',status,'taskScore',task_score,'error',last_error_code) ORDER BY run_key),'[]'::jsonb)
        FROM assessment.term_test_writing_grading_run),
      'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'runId',run_id,'type',job_type,'status',status,
        'owner',worker_id,'attemptCount',attempt_count,'error',last_error_code) ORDER BY created_at,id),'[]'::jsonb)
        FROM assessment.term_test_writing_grading_job),
      'criteria',(SELECT coalesce(jsonb_agg(jsonb_build_object('runId',run_id,'code',criterion_code,'status',status,
        'band',band_score) ORDER BY run_id,criterion_code),'[]'::jsonb) FROM assessment.term_test_writing_grading_criterion),
      'finals',(SELECT coalesce(jsonb_agg(jsonb_build_object('attemptId',attempt_id,'status',status,
        'writingScore',writing_score) ORDER BY attempt_id),'[]'::jsonb) FROM assessment.term_test_writing_grading_final),
      'ready',(SELECT count(*) FROM assessment.term_test_writing_grading_job WHERE
        (status='queued' OR (status='retry_wait' AND job_type='collect' AND attempt_count=0 AND last_error_code IS NULL))
        AND next_attempt_at<=now()),'server_now',now())::text"""))

def tunnel(client):
    class Forward(socketserver.BaseRequestHandler):
        def handle(self):
            channel = client.get_transport().open_channel('direct-tcpip', ('127.0.0.1', 18867), self.request.getpeername())
            try:
                while True:
                    ready, _, _ = select.select([self.request, channel], [], [], 30)
                    for source in ready:
                        data = source.recv(65536)
                        if not data: return
                        (channel if source is self.request else self.request).sendall(data)
            finally: channel.close()
    class Server(socketserver.ThreadingTCPServer): daemon_threads = True
    server = Server(('127.0.0.1', 0), Forward)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, 'http://127.0.0.1:' + str(server.server_address[1])

def prepare(h, state, fixture, base, ids):
    state.setdefault('http', {})
    for slug in h.SLUGS:
        ref = fixture['student_refs'][slug]
        def post(label, path, payload, statuses=(200,)):
            key = slug + ':' + label; old = state['http'].get(key)
            if old:
                check(old['path'] == path and old['payload'] == payload, 'HTTP_INTENT_CHANGED')
                check('response' in old, 'HTTP_OUTCOME_UNKNOWN_RECONCILE')
                check(old.get('http_status') in statuses and old['response'].get('ok') is True, 'PREPARATION_HTTP_FAILED')
                return old['response']
            intent = {'path': path, 'payload': payload, 'at': utc()}
            state['http'][key] = intent; h.atomic(STATE, state)
            response = requests.post(base + '/term-mini-k67-api' + path, json=payload, timeout=30)
            intent['http_status'] = response.status_code
            try: intent['response'] = response.json()
            except ValueError: intent['response'] = {'invalid_json': True}
            h.atomic(STATE, state)
            check(response.status_code in statuses and intent['response'].get('ok') is True, 'PREPARATION_HTTP_FAILED')
            return intent['response']
        prefix = '/api/term-tests/' + slug
        prepared = post('prepare', prefix + '/session/prepare', {'classCode': 'K67SIM', 'studentRef': ref}, (201,))
        token = prepared['examSessionToken']
        post('start', prefix + '/session/start', {'examSessionToken': token})
        state.setdefault('submissions', {}).setdefault(slug, str(uuid.uuid4())); h.atomic(STATE, state)
        submission = {'classCode': 'K67SIM', 'studentRef': ref, 'examSessionToken': token,
          'clientSubmissionId': state['submissions'][slug], 'draftRevision': 2, 'answers': {}}
        attempt = post('listening', prefix + '/listening', submission, (201,))['attemptToken']
        state.setdefault('attempts', {})[slug] = attempt; h.atomic(STATE, state)
        post('reading-start', prefix + '/reading/start', {'attemptToken': attempt})
        post('reading', prefix + '/reading', {'attemptToken': attempt, 'draftRevision': 2, 'answers': {}})
        if slug in ESSAYS:
            started = post('writing-start', '/api/term-tests/writing', {'attemptToken': attempt,
              'action': 'start', 'task1': '', 'task2': ''})['writing']
            submitted = post('writing-submit', '/api/term-tests/writing', {'attemptToken': attempt,
              'action': 'submit', **ESSAYS[slug], 'baseRevision': started['revision']})['writing']
            check(submitted.get('submitted') is True, 'WRITING_NOT_SUBMITTED')
    ids.append('k67.native.prepare.three_synthetic_attempts')
    state['prepared'] = True; h.atomic(STATE, state)

def own(g, p, state, grading, role, active=None):
    check(grading['workflows'][role]['stage'] == 'overlay_inactive', 'OVERLAY_NOT_READY')
    candidate = json.loads(g.candidate_path(grading, role).read_text(encoding='utf-8'))
    version = state.get('writer_version') if role == 'writer' else None
    request = {'operation': 'inspect' if active is None else 'active', 'profile': g.ROLES[role][0],
      'role': role, 'candidate': candidate, 'expectedVersion': version or grading['workflows'][role]['versionId']}
    if active is not None: request['active'] = active
    value = g.sdk(p, request, 'native-own-' + role)
    check(value['body_sha256'] == grading['workflows'][role]['body_sha256'], 'OVERLAY_BODY_CHANGED')
    if role != 'writer': check(value['active'] is False, 'PARENT_ACTIVE')
    else:
        check(value['active'] is False or state.get('writer_activation_intent') is True, 'WRITER_ACTIVE_WITHOUT_INTENT')
        state['writer_version'] = value['versionId']
    return candidate, value

def cli(g, p, profile, argv, label, attempt=None):
    return g.call(p, [p.NODE, p.CLI, '--profile', profile, '--json', *argv], label, attempt=attempt)

def step(h, g, p, state, grading, observed):
    check(state.get('prepared'), 'ATTEMPTS_NOT_PREPARED')
    check(not state.get('pending_execution'), 'EXECUTION_IN_PROGRESS')
    check(not any(j['status'] in ['processing', 'failed'] or (j['status'] == 'retry_wait'
      and not (j['type'] == 'collect' and j['attemptCount'] == 0 and j['error'] is None))
      for j in observed['jobs']), 'JOB_RECONCILE_REQUIRED')
    if not observed['ready']: return 'waiting_for_due_job'
    check(len(state.get('executions', [])) < 6, 'EXECUTION_BUDGET_EXHAUSTED')
    role = 'event' if len(state.get('executions', [])) % 2 == 0 else 'poll'
    candidate, live = own(g, p, state, grading, role)
    p.resolve(g.ROLES[role][0], candidate['id'], candidate['name'])
    pending = {'role': role, 'workflowId': candidate['id'], 'attempt': uuid.uuid4().hex, 'at': utc()}
    state['pending_execution'] = pending; h.atomic(STATE, state)
    if role == 'event':
        started = g.sdk(p, {'operation': 'start-notification', 'profile': 'default', 'role': role,
          'candidate': candidate, 'expectedVersion': live['versionId']}, 'native-parent-start', pending['attempt'])
    else:
        started = cli(g, p, 'default', ['workflow', 'run', candidate['id'], '--trigger', 'Chạy thử bằng tay'],
                      'native-parent-start', pending['attempt'])
    check(started.get('workflowId') == candidate['id'] and re.fullmatch(r'[0-9]+', str(started.get('executionId', ''))),
          'EXECUTION_START_IDENTITY_UNKNOWN')
    pending['executionId'] = str(started['executionId']); h.atomic(STATE, state)
    return 'execution_started'

def outputs(run_data, name):
    return [item.get('json', {}) for run in run_data.get(name, [])
            for branch in (run.get('data', {}).get('main', []) or []) for item in (branch or [])]

def execution_proof(h, g, p, u, client, state, grading, pending, details):
    # Nhận candidate/snapshot/schema đúng parent, chạy hàm điền mặc định native chỉ đọc.
    # Kết quả chỉ gồm hash; đổi hàm/schema/body hoặc version live thì dừng kiểm.
    candidate, live = own(g, p, state, grading, pending['role'])
    check(details.get('workflowData', {}).get('id') == candidate['id'], 'EXECUTION_BODY_IDENTITY_MISMATCH')
    schemas = g.sdk(p, {'operation': 'node-descriptions', 'profile': 'default', 'role': pending['role'],
      'candidate': candidate, 'expectedVersion': live['versionId']}, 'native-node-descriptions')
    schema_pin = {'event': '7cbe2af1ad4cc62c7f03e92a5228d88f046b452556b2365b5f240cee994522b6',
      'poll': 'ad9015b46ffccc2c0f1ad27d7f24ebcb138a14910d27dfe1059447ba1f825c8c'}[pending['role']]
    check(schemas['descriptions_sha256'] == schema_pin, 'NODE_DESCRIPTIONS_CHANGED')
    program = r"""
// Nhận dữ liệu qua stdin; chỉ tính hash bằng hàm n8n đang cài, không gọi workflow.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const entry = require.resolve('n8n-workflow', { paths: ['/usr/local/lib/node_modules/n8n'] });
const { NodeHelpers } = require(entry);
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
}
const hash = x => crypto.createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const helperHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(entry), 'node-helpers.js'))).digest('hex');
const version = require(require.resolve('n8n-workflow/package.json', { paths: ['/usr/local/lib/node_modules/n8n'] })).version;
if (version !== '1.118.2' || helperHash !== '8f80f429c388720122e10da5fad970d22ab632d9917698b1e36b4d4c5912482c') throw Error('NATIVE_NORMALIZER_CHANGED');
const raw = fs.readFileSync(0, 'utf8');
if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error('INPUT_TOO_LARGE');
const input = JSON.parse(raw);
if (hash(input.descriptions) !== input.schema_pin) throw Error('NODE_DESCRIPTIONS_CHANGED');
const workflow = input.workflow;
for (const node of workflow.nodes) {
  const selected = input.descriptions.filter(d => d.name === node.type &&
    (Array.isArray(d.version) ? d.version.includes(node.typeVersion) : d.version === node.typeVersion));
  if (selected.length !== 1) throw Error('NODE_DESCRIPTION_NOT_UNIQUE');
  node.parameters = NodeHelpers.getNodeParameters(selected[0].properties, node.parameters, true, false, node, selected[0]) ?? {};
}
const body = w => Object.fromEntries(['name', 'nodes', 'connections', 'settings'].map(k => [k, w[k]]));
const normalized_sha256 = hash(body(workflow)), execution_sha256 = hash(body(input.execution));
process.stdout.write(JSON.stringify({ normalized_sha256, execution_sha256,
  matched: normalized_sha256 === execution_sha256, helper_sha256: helperHash,
  descriptions_sha256: hash(input.descriptions), runtime_version: version }));
"""
    proof = json.loads(u.remote(client, ['docker', 'exec', '-i', 'n8n', 'node', '-e', program], stdin=json.dumps({
      'workflow': candidate, 'execution': details['workflowData'], 'descriptions': schemas['descriptions'], 'schema_pin': schema_pin})))
    h.atomic(PRIVATE / ('execution-' + pending['executionId'] + '.normalization.json'), proof)
    check(proof.get('matched') is True, 'EXECUTION_BODY_CHANGED')
    own(g, p, state, grading, pending['role'])
    return proof

def observe(h, g, p, u, client, state, grading, observed, ids):
    pending = state.get('pending_execution')
    if not pending: return 'no_execution_pending'
    if not pending.get('executionId'):
        journal = g.PRIVATE / ('native-parent-start-' + pending['attempt'] + '.stdout.log')
        check(journal.exists(), 'EXECUTION_START_OUTCOME_UNKNOWN')
        started = json.loads(journal.read_text(encoding='utf-8'))
        check(started.get('workflowId') == pending['workflowId'] and re.fullmatch(r'[0-9]+', str(started.get('executionId', ''))),
              'EXECUTION_START_OUTCOME_UNKNOWN')
        pending['executionId'] = str(started['executionId']); h.atomic(STATE, state)
    identity = pending['executionId']
    meta = cli(g, p, 'default', ['execution', 'get', identity], 'native-parent-status')
    check(str(meta['id']) == identity and meta['workflowId'] == pending['workflowId'], 'EXECUTION_IDENTITY_MISMATCH')
    if meta.get('status') in ['running', 'new', 'waiting']: return 'execution_running'
    details = cli(g, p, 'default', ['execution', 'get', identity, '--logs'], 'native-parent-snapshot')
    h.atomic(PRIVATE / ('execution-' + identity + '.private.json'), details)
    check(str(details['id']) == identity and details['workflowId'] == pending['workflowId'], 'EXECUTION_IDENTITY_MISMATCH')
    check(details.get('status') == 'success', 'NATIVE_PARENT_FAILED')
    proof = execution_proof(h, g, p, u, client, state, grading, pending, details)
    data = details.get('data', {}).get('resultData', {}).get('runData', {})
    jobs = outputs(data, 'Nhận việc chấm')
    if identity == '2461179' and not jobs:
        # Khép đúng lần chạy rỗng đã biết bằng dữ liệu native, không tính là chấm.
        prior_path = PRIVATE / 'k67-grading-native-0090536c080a439489bc62d9e622697a.database.private.json'
        check(hashlib.sha256(prior_path.read_bytes()).hexdigest() ==
          'ad06ce6ff2b88cf0a5361c53a4b8ef3ccf561281140892a86d0a9942fc55e6af', 'EMPTY_RUN_BASELINE_CHANGED')
        prior = json.loads(prior_path.read_text(encoding='utf-8'))
        check(pending['role'] == 'event' and details.get('mode') == 'manual'
          and set(data) == {'Chạy thử bằng tay', 'Kiểm tra thông báo, không nhận bài từ Webhook'}
          and outputs(data, 'Chạy thử bằng tay') == [{}]
          and outputs(data, 'Kiểm tra thông báo, không nhận bài từ Webhook') == []
          and not any(run.get('error') for runs in data.values() for run in runs), 'EMPTY_RUN_NOT_PROVEN')
        check(all(prior[k] == observed[k] for k in ['attempts', 'runs', 'jobs', 'criteria', 'finals']),
              'EMPTY_RUN_DATABASE_CHANGED')
        state.setdefault('noop_executions', []).append({**pending, 'status': 'success', 'normalization': proof,
          'baseline_sha256': hashlib.sha256(prior_path.read_bytes()).hexdigest(), 'kind': 'manual_empty_no_claim'})
        state['pending_execution'] = None; h.atomic(STATE, state)
        ids.append('k67.native.event.manual_empty_no_claim')
        return 'empty_manual_verified_without_grading'
    check(len(jobs) == 1, 'NATIVE_SINGLE_JOB_REQUIRED')
    job = jobs[0]; name = 'Xác nhận đã chấm xong' if job['jobType'] == 'dispatch' else 'Ghi kết quả vào bài thi'
    result = outputs(data, name)
    check(len(result) == 1 and result[0].get('ok') is True and result[0].get('jobId') == job['jobId']
      and result[0].get('runKey') == job['runKey'], 'NATIVE_CALLBACK_NOT_SUCCESSFUL')
    saved = next((j for j in observed['jobs'] if j['id'] == job['jobId']), None)
    check(saved is not None and saved['status'] == 'complete', 'NATIVE_JOB_NOT_COMPLETE')
    run = next((r for r in observed['runs'] if r['runKey'] == job['runKey']), None)
    check(run is not None and run['taskNumber'] == job['taskNumber'], 'NATIVE_RUN_IDENTITY_MISMATCH')
    check(saved['runId'] == run['id'] and saved['owner'] == 'term-mini-k67-writing-event:' + identity,
          'NATIVE_JOB_OWNER_MISMATCH')
    attempt = next(a for a in observed['attempts'] if a['id'] == run['attemptId'])
    if job['jobType'] == 'collect':
        rows = [c for c in observed['criteria'] if c['runId'] == run['id']]
        check(run['status'] == 'complete' and len(rows) == 4 and all(c['status'] == 'complete' for c in rows),
              'NATIVE_CRITERIA_INCOMPLETE')
    ids.append('k67.native.' + job['jobType'] + '.' + attempt['slug'] + '.task' + str(job['taskNumber']))
    state.setdefault('executions', []).append({**pending, 'jobType': job['jobType'], 'jobId': job['jobId'],
      'runKey': job['runKey'], 'status': 'success', 'callback': result[0], 'normalization': proof, 'native_test_id': ids[-1]})
    state['pending_execution'] = None; h.atomic(STATE, state)
    return 'execution_and_callback_verified'

def complete_grading(state, observed):
    check(len(observed['attempts']) == 3 and len(observed['runs']) == 3 and len(observed['criteria']) == 12
      and len(observed['finals']) == 2, 'GRADING_INVENTORY_INCOMPLETE')
    check(all(r['status'] == 'complete' for r in observed['runs']) and all(f['status'] == 'ready' for f in observed['finals']),
          'GRADING_NOT_READY')
    check(len(observed['jobs']) == 6 and all(j['status'] == 'complete' and j['attemptCount'] == 1 for j in observed['jobs']),
          'JOB_INVENTORY_NOT_ONCE')
    check({r['attemptId'] for r in observed['runs']} == {state['attempts'][s] for s in ESSAYS}, 'MINI_WRITING_JOB_OR_WRONG_ATTEMPT')

def portal(h, g, p, state, grading, fixture, keys, service, base, observed, ids):
    complete_grading(state, observed)
    candidate, live = own(g, p, state, grading, 'writer')
    route = json.loads((h.PRIVATE / 'portal-fixture-route/state.json').read_text(encoding='utf-8'))
    check(route.get('stage') == 'ready' and route.get('intent') == fixture['intent_id'], 'PORTAL_ROUTE_NOT_READY')
    check(requests.get('https://ducizone.ddns.net:18868/k67-portal-fixture/' + fixture['intent_id'] + '/1124/student-tests',
      headers={'x-k67-fixture-service': keys['portal']}, timeout=20).status_code == 200, 'PORTAL_AUTH_NOT_READY')
    triggers = [n for n in candidate['nodes'] if n['type'] == 'n8n-nodes-base.webhook']
    check(len(triggers) == 1 and re.fullmatch('[A-Za-z0-9_-]+', triggers[0]['parameters']['path']), 'WRITER_TRIGGER_CHANGED')
    url = 'https://n8n-ai.izone.edu.vn/webhook/' + triggers[0]['parameters']['path']
    state['writer_activation_intent'] = True; h.atomic(STATE, state)
    own(g, p, state, grading, 'writer', True); h.atomic(STATE, state)
    control_headers = {'x-k67-fixture-control': keys['control']}
    def read_portal():
        response = requests.get(base + '/fixture/state', headers=control_headers, timeout=20)
        check(response.status_code == 200, 'PORTAL_STATE_READ_FAILED'); return response.json()
    def send(label, payload, allowed=(200,)):
        state.setdefault('portal', {})
        old = state['portal'].get(label)
        if old:
            check(old['payload'] == payload and old.get('verified') is True, 'PORTAL_OUTCOME_RECONCILE_REQUIRED')
            return old['response']
        before = read_portal(); record = {'payload': payload, 'before': before, 'at': utc()}
        state['portal'][label] = record; h.atomic(STATE, state)
        response = requests.post(url, json=payload, headers={'x-term-test-sync': service['erp_sync']}, timeout=90)
        record['http_status'] = response.status_code
        try: record['response'] = response.json()
        except ValueError: record['response'] = {'invalid_json': True}
        record['after'] = read_portal(); h.atomic(STATE, state)
        check(response.status_code in allowed, 'WRITER_HTTP_UNEXPECTED')
        return record['response']
    for slug in ESSAYS:
        attempt = next(a for a in observed['attempts'] if a['slug'] == slug)
        result = requests.post(base + '/term-mini-k67-api/api/term-tests/result',
          json={'attemptToken': attempt['id']}, timeout=20).json()
        check(result.get('ok') is True and result['writing']['grading']['ready'] is True, 'RESULT_NOT_READY')
        grades = {skill: 2 if result['result'][skill]['band'] == '<2.5' else result['result'][skill]['band']
                  for skill in ['listening', 'reading']}
        grades['writing'] = result['writing']['grading']['writingScore']
        payload = {'version': 1, 'attemptToken': attempt['id'], 'testSlug': slug,
          'classId': str(attempt['classId']), 'studentId': str(attempt['studentId']), 'grades': grades}
        outcome = send(slug, payload)
        check(outcome.get('ok') is True and outcome.get('status') == 'synced'
          and outcome.get('attemptToken') == attempt['id'], 'PORTAL_RESPONSE_IDENTITY_MISMATCH')
        record = state['portal'][slug]
        phase = int(slug[-1]); targets = set()
        for skill, grade in grades.items():
            test_name = 'Phase ' + str(phase) + ' ' + skill.title()
            test_id = next(t['id'] for t in record['after']['class_tests'] if t['name'] == test_name)
            row = next(r for r in record['after']['student_test_grades'] if r['student_id'] == attempt['studentId']
              and r['class_test_id'] == test_id)
            check(row['grade'] == grade, 'PORTAL_GRADE_READBACK_MISMATCH'); targets.add(row['meta']['records'][0]['id'])
        for old in record['before']['student_test_grades']:
            if old['meta']['records'][0]['id'] not in targets:
                check(old in record['after']['student_test_grades'], 'PORTAL_OTHER_ROW_CHANGED')
        record['verified'] = True; h.atomic(STATE, state); ids.append('k67.native.portal.' + slug)
        repeated = send(slug + '-repeat', payload)
        repeated_record = state['portal'][slug + '-repeat']
        check(repeated.get('status') == 'synced' and repeated_record['before']['student_test_grades']
          == repeated_record['after']['student_test_grades'] and
          [a for a in repeated_record['before']['audit'] if a['method'] == 'PUT']
          == [a for a in repeated_record['after']['audit'] if a['method'] == 'PUT'], 'PORTAL_DUPLICATE_MUTATION')
        state['portal'][slug + '-repeat']['verified'] = True; h.atomic(STATE, state)
        ids.append('k67.native.portal.repeat.' + slug)
    state['portal_positive_verified'] = True; h.atomic(STATE, state)

def fault_original_record(h, record, backup):
    # Giữ bằng chứng trước đối soát; file gốc đã có thì phải khớp, không ghi lại.
    progress={'reconciliation','executionId','native_status','consumer','proof_tree_revision'}
    original={key:value for key,value in record.items() if key not in progress}
    if backup.exists(): check(json.loads(backup.read_text(encoding='utf-8'))==original,'OLD_FAULT_RECORD_CHANGED')
    else: h.atomic(backup,original)
    return json.loads(backup.read_text(encoding='utf-8'))

def portal_faults(h, g, p, state, grading, fixture, keys, service, base, observed, ids):
    # Gửi đúng writer own tới Portal giả; mỗi ca lưu intent trước HTTP và đọc snapshot native.
    # Chỉ dùng ô trống của học viên giả thứ ba; không reset điểm hoặc chấm lại bài.
    complete_grading(state, observed)
    check(grading.get('writer_repair',{}).get('status')=='applied', 'WRITER_REPAIR_NOT_APPLIED')
    candidate,_ = own(g,p,state,grading,'writer')
    hooks=[n for n in candidate['nodes'] if n['type']=='n8n-nodes-base.webhook']
    check(len(hooks)==1,'WRITER_TRIGGER_CHANGED')
    url='https://n8n-ai.izone.edu.vn/webhook/'+hooks[0]['parameters']['path']
    state['writer_activation_intent']=True; h.atomic(STATE,state)
    own(g,p,state,grading,'writer',True); h.atomic(STATE,state)
    control={'x-k67-fixture-control':keys['control']}
    def read():
        r=requests.get(base+'/fixture/state',headers=control,timeout=20)
        check(r.status_code==200,'PORTAL_STATE_READ_FAILED'); return r.json()
    def puts(portal): return [a for a in portal['audit'] if a['method']=='PUT']
    def rows(portal): return portal['student_test_grades']
    def send(label,payload,expect_error=None,fault=None,wrong_key=False):
        ledger=state.setdefault('portal_faults',{})
        reconciled = False
        if label in ledger:
            record=ledger[label]
            check(record['payload']==payload,'PORTAL_FAULT_RECONCILE_REQUIRED')
            if record.get('verified') is True:
                check(record.get('proof_tree_revision',record['tree_revision'])==h.fingerprint(),'PORTAL_FAULT_RECONCILE_REQUIRED')
                return record
            # Chỉ đối soát đúng ca khóa sai đã terminal: không gửi lại request hay sửa receipt thất bại.
            prior=PRIVATE/'k67-grading-native-f552264305a04c27b189cfdb93ddb631.json'
            native=PRIVATE/'portal-fault-wrong-key-1818405.private.json'
            check(label=='wrong-key' and record['tree_revision']=='f5773c0416c34f1657e22b7055fa27d4c035589353203c96558c69cbf8584e46'
                and record.get('http_status')==200 and record.get('response')=={'invalid_json':True}
                and h.sha(native.read_bytes())=='8278df185310d31f28edecd3cc792c0e130dd00f79d5f8ccb273618d02f5f643', 'PORTAL_FAULT_RECONCILE_REQUIRED')
            previous_receipt=json.loads(prior.read_text(encoding='utf-8'))
            check(previous_receipt['operation_error']=='WRITER_FALSE_SUCCESS' and previous_receipt['outcome']=='unknown'
                and previous_receipt['guard_error'] is None and previous_receipt['executed_test_ids']==[], 'OLD_FAULT_RECEIPT_CHANGED')
            backup=PRIVATE/'wrong-key-record-before-reconciliation.private.json'
            fault_original_record(h,record,backup)
            details=json.loads(native.read_text(encoding='utf-8')); identity='1818405'
            check(identity not in record['previous_ids'] and rows(read())==rows(record['after'])
                and puts(read())==puts(record['after']),'WRONG_KEY_RECONCILE_STATE_CHANGED')
            qualification={'prior_receipt_sha256':h.sha(prior.read_bytes()),'native_snapshot_sha256':h.sha(native.read_bytes()),
                'original_record_sha256':h.sha(backup.read_bytes()),'no_post_replay':True,'response_representation':'captured-invalidJSON'}
            check(record.get('reconciliation') in [None,qualification] and record.get('executionId') in [None,identity]
                and record.get('native_status') in [None,'error'] and record.get('proof_tree_revision') in [None,h.fingerprint()],
                'WRONG_KEY_RECONCILE_PROGRESS_CHANGED')
            previous_consumer={'accepted':False,'rejected':True,'calls':1,'errorCode':'ERP_SYNC_RESPONSE_NOT_JSON',
                'representation':'captured-invalidJSON'}
            check(record.get('consumer') in [None,previous_consumer],'WRONG_KEY_RECONCILE_PROGRESS_CHANGED')
            record['reconciliation']=qualification
            reconciled=True
        # Lấy ID trước gửi; raw snapshot có header được giữ riêng, chỉ trả metadata trong receipt.
        if not reconciled:
            previous=cli(g,p,'izone-ai',['execution','list','--workflow',candidate['id'],'--limit','20'],'fault-executions-before')
            check(isinstance(previous,list),'EXECUTION_INVENTORY_INVALID')
            record={'payload':payload,'before':read(),'at':utc(),'previous_ids':[str(r['id']) for r in previous],
                'candidate_sha256':grading['writer_repair']['candidate_sha256'],'fault':fault,'wrong_key':wrong_key}
            record['tree_revision']=h.fingerprint()
            ledger[label]=record; h.atomic(STATE,state)
            if fault:
                r=requests.post(base+'/fixture/control',json={'fault':fault},headers=control,timeout=20)
                check(r.status_code==200,'FAULT_CONTROL_FAILED')
            response=requests.post(url,json=payload,headers={'x-term-test-sync':'synthetic-wrong-key' if wrong_key else service['erp_sync']},timeout=90)
            record['http_status']=response.status_code; record['response_text']=response.text
            try: record['response']=response.json()
            except ValueError: record['response']={'invalid_json':True}
            record['after']=read(); h.atomic(STATE,state)
            listed=cli(g,p,'izone-ai',['execution','list','--workflow',candidate['id'],'--limit','20'],'fault-executions-after')
            new=[r for r in listed if str(r['id']) not in record['previous_ids']]
            check(len(new)==1,'WRITER_EXECUTION_LINK_NOT_UNIQUE')
            identity=str(new[0]['id']); details=cli(g,p,'izone-ai',['execution','get',identity,'--logs'],'fault-execution-'+label)
            h.atomic(PRIVATE/('portal-fault-'+label+'-'+identity+'.private.json'),details)
        check(details.get('workflowId')==candidate['id'] and details.get('mode')=='webhook','WRITER_EXECUTION_IDENTITY_CHANGED')
        workflow=details.get('workflowData',{}); result=details.get('data',{}).get('resultData',{})
        check(not workflow.get('pinData') and not result.get('pinData'),'WRITER_PINNED_RESULT_FORBIDDEN')
        check(workflow.get('connections')==candidate['connections'] and len(workflow.get('nodes',[]))==len(candidate['nodes']), 'WRITER_GRAPH_CHANGED')
        for node in candidate['nodes']:
            actual=next((n for n in workflow['nodes'] if n['id']==node['id']),None)
            check(actual and all(actual.get(k)==node.get(k) for k in ['name','type','typeVersion','credentials']), 'WRITER_NODE_IDENTITY_CHANGED')
            if node['type']=='n8n-nodes-base.code': check(actual['parameters'].get('jsCode')==node['parameters']['jsCode'],'WRITER_CODE_CHANGED')
            if node['type']=='n8n-nodes-base.httpRequest': check(actual['parameters'].get('url')==node['parameters']['url'],'WRITER_DESTINATION_CHANGED')
        inputs=outputs(result.get('runData',{}),'Nhận điểm sau khi chấm')
        check(len(inputs)==1 and inputs[0].get('body')==payload,'WRITER_EXECUTION_PAYLOAD_CHANGED')
        record['executionId']=identity; record['native_status']=details.get('status')
        record['consumer']=g.call(p,[p.NODE,str(ROOT/'ops/erp-response-proof.mjs')],'fault-caller-'+label,
            {'httpStatus':record['http_status'],'payload':payload,'responseText':record.get('response_text'),
             'parseFailure':reconciled})
        record['proof_tree_revision']=h.fingerprint(); h.atomic(STATE,state)
        error=json.dumps(result.get('error',{}),ensure_ascii=False)
        if expect_error is not None:
            check(record['consumer']['rejected'] is True and details.get('status')=='error','WRITER_FALSE_SUCCESS')
            check(expect_error in error,'WRITER_UNEXPECTED_ERROR')
        else:
            check(record['http_status']==200 and record['response'].get('status')=='synced'
                and record['consumer']['accepted'] is True and details.get('status')=='success','WRITER_OUTCOME_NOT_SYNCED')
        return record
    def finish(label,record):
        record['verified']=True; h.atomic(STATE,state); ids.append('k67.native.portal.fault.'+label)
    # UUID ổn định theo nhãn: có thể đọc lại ca đã xong mà không tạo request khác.
    def payload(label,**patch):
        value={'version':1,'attemptToken':str(uuid.uuid5(uuid.NAMESPACE_URL,fixture['intent_id']+':'+label)),
            'testSlug':'term-test-1','classId':1124,'studentId':9870677003,'grades':{'listening':0}}
        value.update(patch); return value
    for label,body,error,wrong in [
        ('wrong-key',payload('wrong-key'),'SYNC_UNAUTHORIZED',True),
        ('empty-array',[],'SYNC_INVALID_IDENTITY',False),
        ('two-entities',[payload('a'),payload('b')],'SYNC_INVALID_IDENTITY',False),
        ('foreign-class',payload('foreign-class',classId=1131),'404',False),
        ('foreign-student',payload('foreign-student',studentId=123),'422',False),
        ('missing-phase',payload('missing-phase',testSlug='term-test-3'),'SYNC_CLASS_TEST_NOT_FOUND_LISTENING',False),
        ('invalid-grade',payload('invalid-grade',grades={'listening':6.2}),'SYNC_INVALID_GRADE_LISTENING',False)]:
        record=send(label,body,error,wrong_key=wrong)
        check(rows(record['before'])==rows(record['after']) and puts(record['before'])==puts(record['after']),'INVALID_REQUEST_CHANGED_PORTAL')
        finish(label,record)
    zero=payload('false-ack-zero')
    record=send('false-ack-zero',zero,'SYNC_VERIFY_FAILED_LISTENING',fault='ack_without_write')
    check(rows(record['before'])==rows(record['after']) and len(puts(record['after']))==len(puts(record['before']))+1
        and puts(record['after'])[-1].get('fault')=='ack_without_write' and record['after']['fault']=='none','FALSE_ACK_CHANGED_GRADE')
    finish('false-ack-zero',record)
    record=send('zero-saved',zero)
    row=next(r for r in rows(record['after']) if r['student_id']==9870677003 and r['class_test_id']==6701)
    check(row['grade']==0 and len(puts(record['after']))==len(puts(record['before']))+1,'ZERO_NOT_SAVED_ONCE')
    finish('zero-saved',record)
    record=send('zero-repeat',zero)
    check(rows(record['before'])==rows(record['after']) and puts(record['before'])==puts(record['after']),'ZERO_REPEAT_MUTATION')
    finish('zero-repeat',record)
    record=send('official-conflict',payload('official-conflict',grades={'listening':1}),'SYNC_EXISTING_OFFICIAL_GRADE_LISTENING')
    check(rows(record['before'])==rows(record['after']) and puts(record['before'])==puts(record['after']),'OFFICIAL_GRADE_CHANGED')
    finish('official-conflict',record)
    lost=payload('lost-ack',grades={'reading':5})
    record=send('lost-ack',lost,'',fault='write_then_disconnect')
    check(record['consumer']['rejected'] is True and record['native_status']=='error','LOST_ACK_FALSE_SUCCESS')
    row=next(r for r in rows(record['after']) if r['student_id']==9870677003 and r['class_test_id']==6702)
    check(row['grade']==5 and len(puts(record['after']))==len(puts(record['before']))+1 and record['after']['fault']=='none','LOST_ACK_NOT_PERSISTED_ONCE')
    finish('lost-ack',record)
    record=send('lost-ack-repeat',lost)
    check(rows(record['before'])==rows(record['after']) and puts(record['before'])==puts(record['after']),'LOST_ACK_REPEAT_MUTATION')
    finish('lost-ack-repeat',record)
    state['portal_faults_verified']=True; h.atomic(STATE,state)

def main():
    sys.stdout.reconfigure(encoding='utf-8', line_buffering=True); sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)
    parser = argparse.ArgumentParser(); parser.add_argument('--phase', choices=['prepare', 'step', 'observe', 'portal', 'portal-faults', 'off'], required=True)
    args = parser.parse_args(); h = module('http_fixture', 'prepare-http-fixture.py'); g = module('grading_fixture', 'prepare-grading-fixture.py')
    p = module('grading_provision', 'provision-grading-bundle.py'); u = h.utilities()
    fixture = json.loads(h.STATE.read_text(encoding='utf-8')); h.validate_state(fixture)
    check(fixture['source_hashes'] == h.current_source(), 'FIXTURE_SOURCE_CHANGED')
    grading = json.loads(g.STATE.read_text(encoding='utf-8'))
    check(grading['intent'] == fixture['intent_id'] and not grading.get('pending'), 'GRADING_STATE_NOT_READY')
    keys = h.vault(h.STORE / 'credentials.dpapi'); service = h.vault(p.VAULT)
    check(keys['identity'] == h.IDENTITY and keys['intent_id'] == fixture['intent_id']
      and service['product_id'] == 'PRODUCT-TERM-MINI-K67', 'VAULT_IDENTITY_MISMATCH')
    state = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {
      'product_id': 'PRODUCT-TERM-MINI-K67', 'intent': fixture['intent_id'], 'database': fixture['database']}
    check(state['product_id'] == 'PRODUCT-TERM-MINI-K67' and state['intent'] == fixture['intent_id']
      and state['database'] == fixture['database'], 'NATIVE_STATE_IDENTITY_MISMATCH')
    h.atomic(STATE, state); revision = h.fingerprint(); source_before = g.source_versions(p)
    client = u.connect(); before = u.protected(client)
    server = None; error = guard_error = None; ids = []; stage = None; observed = None
    run_id = 'k67-grading-native-' + uuid.uuid4().hex
    try:
        for name in [h.APP, h.GATE]: h.check_container(json.loads(u.remote(client, ['docker', 'inspect', name]))[0], fixture, name)
        check(h.sql(u, client, fixture['database'], 'SELECT product_id||\':\'||fixture_id FROM mapping.k67_fixture_identity')
          == 'PRODUCT-TERM-MINI-K67:' + fixture['intent_id'], 'DATABASE_MARKER_MISMATCH')
        seed = h.read_seed(u, client, fixture)
        check({r['test_slug']: r['student_ref'] for r in seed['roster']} == fixture['student_refs']
          and {r['erp_student_contact_id'] for r in seed['members']} == {9870677001, 9870677002, 9870677003}, 'FAKE_ROSTER_CHANGED')
        for role in g.ROLES: own(g, p, state, grading, role)
        server, base = tunnel(client)
        observed = snapshot(h, u, client, fixture)
        check(all(a['classId'] == 1124 and a['studentId'] in [9870677001, 9870677002, 9870677003]
          for a in observed['attempts']), 'FOREIGN_ATTEMPT_IN_FIXTURE')
        if args.phase == 'prepare':
            h.sql(u, client, fixture['database'], "UPDATE mapping.k67_context_state SET captured_at=now() WHERE product_id='PRODUCT-TERM-MINI-K67'")
            prepare(h, state, fixture, base, ids); stage = 'attempts_prepared'
        elif args.phase == 'step': stage = step(h, g, p, state, grading, observed)
        elif args.phase == 'observe': stage = observe(h, g, p, u, client, state, grading, observed, ids)
        elif args.phase == 'portal': portal(h, g, p, state, grading, fixture, keys, service, base, observed, ids); stage = 'portal_positive_verified'
        elif args.phase == 'portal-faults': portal_faults(h,g,p,state,grading,fixture,keys,service,base,observed,ids); stage='portal_faults_verified'
        else:
            check(not state.get('pending_execution'), 'EXECUTION_STILL_PENDING')
            _, inactive = own(g, p, state, grading, 'writer', False)
            grading['workflows']['writer']['versionId'] = inactive['versionId']
            grading['workflows']['writer']['body_sha256'] = inactive['body_sha256']
            h.atomic(g.STATE, grading); h.atomic(STATE, state); stage = 'writer_inactive'
        observed = snapshot(h, u, client, fixture); h.atomic(PRIVATE / (run_id + '.database.private.json'), observed)
    except Exception as exc: error = str(exc) if re.fullmatch('[A-Z_0-9]+', str(exc)) else type(exc).__name__
    finally:
        if server: server.shutdown(); server.server_close()
        try:
            after = u.protected(client); source_after = g.source_versions(p)
            check(before == after and source_before == source_after, 'PROTECTED_STATE_CHANGED')
        except Exception as exc: after = source_after = None; guard_error = type(exc).__name__
        client.close()
    after_revision = h.fingerprint()
    receipt = {'run_id': run_id, 'tree_revision': revision, 'observed_after_revision': after_revision,
      'phase': args.phase, 'stage': stage, 'outcome': 'passed' if not error and not guard_error and revision == after_revision else 'unknown',
      'operation_error': error, 'guard_error': guard_error, 'exit_code': 0 if not error and not guard_error and revision == after_revision else 1,
      'executed_test_ids': ids, 'protected_before': before, 'protected_after': after, 'source_before': source_before,
      'source_after': source_after, 'intent': fixture['intent_id'], 'observed_at': utc()}
    h.atomic(PRIVATE / (run_id + '.json'), receipt)
    print(json.dumps({k: receipt[k] for k in ['run_id', 'phase', 'stage', 'outcome', 'operation_error', 'guard_error', 'executed_test_ids']}))
    return receipt['exit_code']

if __name__ == '__main__':
    PRIVATE.mkdir(exist_ok=True)
    g = module('grading_fixture_lock', 'prepare-grading-fixture.py')
    with g.single_owner(g.PRIVATE / 'operation.lock'): sys.exit(main())
