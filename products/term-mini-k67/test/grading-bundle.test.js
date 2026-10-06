// Snapshot chỉ đọc; HTTP/Portal/AI đều giả. Kiểm hành vi định tuyến và giữ đúng bài trước native n8n.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildGradingBundle, loadPinnedWorkflows, K67_BACKEND, K67_CACHE, K67_PRODUCTION_API } from '../ops/grading-bundle.mjs';

const lock = JSON.parse(await readFile(new URL('../ops/grading-source-lock.json', import.meta.url), 'utf8'));
const sources = await loadPinnedWorkflows(lock);
const original = JSON.stringify(sources);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function destinations() {
  const target = { workflowIds: {}, credentials: {}, webhooks: {}, errorWorkflowIds: { default: 'K67errorDefault01', 'izone-ai': 'K67errorWriter01' } };
  sources.forEach(({ profile, workflow }, index) => {
    target.workflowIds[workflow.id] = 'K67fixture' + String(index).padStart(6, '0');
    for (const node of workflow.nodes) {
      for (const [kind, credential] of Object.entries(node.credentials ?? {})) {
        const key = profile + ':' + kind + ':' + credential.id;
        target.credentials[key] ??= { id: 'K67credential' + Object.keys(target.credentials).length, name: 'Khóa K67 mô phỏng' };
      }
      if (node.type === 'n8n-nodes-base.webhook') target.webhooks[workflow.id + ':' + node.id] = { webhookId: randomUUID(), path: 'term-mini-k67-fixture-' + index };
    }
  });
  return target;
}
function bundle() { return buildGradingBundle(sources, destinations()); }
function sharedInfrastructureTarget() {
  const target = destinations();
  for (const source of sources) for (const node of source.workflow.nodes) {
    for (const [kind, credential] of Object.entries(node.credentials ?? {})) {
      if (credential.id === 'pk7LZxI0lKarGnwy' || credential.id === '5t3dhy3tWIoPzmXc') {
        target.credentials[source.profile + ':' + kind + ':' + credential.id] = structuredClone(credential);
      }
    }
  }
  return target;
}

test('pinned AI and Portal infrastructure credentials remain only on their exact nodes', () => {
  const built = buildGradingBundle(sources, sharedInfrastructureTarget());
  let shared = 0;
  for (const { workflow } of built) for (const node of workflow.nodes) {
    for (const credential of Object.values(node.credentials ?? {})) {
      if (['pk7LZxI0lKarGnwy', '5t3dhy3tWIoPzmXc'].includes(credential.id)) {
        assert.equal(node.type, 'n8n-nodes-base.httpRequest');
        shared += 1;
      }
    }
  }
  assert.equal(shared, 64);
});

test('infrastructure exception rejects changed URL, node identity or source version', () => {
  for (const field of ['url', 'node', 'version']) {
    const changed = structuredClone(sources);
    const source = changed.find(s => s.workflow.nodes.some(n => n.credentials?.httpHeaderAuth?.id === 'pk7LZxI0lKarGnwy'));
    const node = source.workflow.nodes.find(n => n.credentials?.httpHeaderAuth?.id === 'pk7LZxI0lKarGnwy');
    if (field === 'url') node.parameters.url = 'https://unapproved.invalid/';
    if (field === 'node') node.id = randomUUID();
    if (field === 'version') source.workflow.versionId = randomUUID();
    assert.throws(() => buildGradingBundle(changed, sharedInfrastructureTarget()), /CREDENTIAL_BINDING_MISSING/);
  }
});

test('Redis and callback credentials stay new even when provider credentials are shared', () => {
  for (const oldId of ['nD12IAhtWT5GU4YV', 'SbMX3RH2NEySJUE5']) {
    const target = sharedInfrastructureTarget();
    const source = sources.find(s => s.workflow.nodes.some(n => Object.values(n.credentials ?? {}).some(c => c.id === oldId)));
    const node = source.workflow.nodes.find(n => Object.values(n.credentials ?? {}).some(c => c.id === oldId));
    const [kind, credential] = Object.entries(node.credentials).find(([, c]) => c.id === oldId);
    target.credentials[source.profile + ':' + kind + ':' + oldId] = structuredClone(credential);
    assert.throws(() => buildGradingBundle(sources, target), /CREDENTIAL_BINDING_MISSING/);
  }
});
function codeFor(built, id, name) {
  return built.find(w => w.sourceId === id).workflow.nodes.find(n => n.name === name).parameters.jsCode;
}
function execute(code, context) { return new AsyncFunction(...Object.keys(context), code)(...Object.values(context)); }

test('pinned graph contains all 48 grading workflows and one Portal writer', () => {
  assert.equal(sources.length, 49);
  assert.equal(sources.filter(s => s.profile === 'default').length, 48);
  assert.equal(sources.filter(s => s.profile === 'izone-ai').length, 1);
});
test('source hash mismatch stops before building', async () => {
  const changed = structuredClone(lock);
  changed.workflows[0].sha256 = '0'.repeat(64);
  await assert.rejects(loadPinnedWorkflows(changed), /SOURCE_HASH_MISMATCH/);
});
test('build preserves source, node topology and full pinned Registry prompt', () => {
  const built = bundle();
  assert.equal(built.length, 49);
  assert.equal(JSON.stringify(sources), original);
  for (const entry of built) {
    const before = sources.find(s => s.workflow.id === entry.sourceId).workflow;
    assert.deepEqual(entry.workflow.connections, before.connections);
    assert.deepEqual(entry.workflow.nodes.map(n => [n.id, n.name, n.type, n.typeVersion]), before.nodes.map(n => [n.id, n.name, n.type, n.typeVersion]));
  }
  const name = 'Chọn và ghép prompt từ registry đã duyệt';
  assert.equal(codeFor(built, 'isfTUNj1X1LJxKgg', name), sources.find(s => s.workflow.id === 'isfTUNj1X1LJxKgg').workflow.nodes.find(n => n.name === name).parameters.jsCode);
});
test('all children resolve within the K67 graph and all Code nodes compile', () => {
  const built = bundle();
  const ids = new Set(built.map(x => x.workflow.id));
  let edges = 0, codeCount = 0;
  for (const { workflow } of built) for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.executeWorkflow') {
      const ref = node.parameters.workflowId;
      assert.ok(ids.has(typeof ref === 'string' ? ref : ref.value));
      edges += 1;
    }
    if (node.type === 'n8n-nodes-base.code') {
      assert.doesNotThrow(() => new AsyncFunction(node.parameters.jsCode));
      codeCount += 1;
    }
  }
  assert.ok(edges >= 47);
  assert.ok(codeCount >= 49);
});
test('candidate is inactive without runtime state and saves all execution evidence', () => {
  for (const { workflow } of bundle()) {
    assert.equal(workflow.active, false);
    for (const field of ['pinData', 'staticData', 'shared', 'versionId', 'tags']) assert.equal(Object.hasOwn(workflow, field), false);
    assert.equal(workflow.settings.saveDataSuccessExecution, 'all');
    assert.equal(workflow.settings.saveDataErrorExecution, 'all');
    assert.equal(workflow.settings.saveManualExecutions, true);
    assert.match(workflow.settings.errorWorkflow, /^K67error/);
  }
});
test('missing, duplicate and old destination workflow IDs are rejected', () => {
  for (const variant of ['missing', 'duplicate', 'old']) {
    const target = destinations();
    const [first, second] = sources.map(s => s.workflow.id);
    if (variant === 'missing') delete target.workflowIds[first];
    if (variant === 'duplicate') target.workflowIds[first] = target.workflowIds[second];
    if (variant === 'old') target.workflowIds[first] = first;
    assert.throws(() => buildGradingBundle(sources, target), /DESTINATION_ID_INVALID/);
  }
});
test('dynamic or unpinned child is rejected instead of calling a shared workflow', () => {
  const changed = structuredClone(sources);
  const node = changed.flatMap(s => s.workflow.nodes).find(n => n.type === 'n8n-nodes-base.executeWorkflow');
  node.parameters.workflowId = '={{ $json.workflowId }}';
  assert.throws(() => buildGradingBundle(changed, destinations()), /CHILD_OUTSIDE_PINNED_GRAPH/);
});
test('missing credentials and reused webhook identity stop the build', () => {
  const target = destinations();
  delete target.credentials[Object.keys(target.credentials)[0]];
  assert.throws(() => buildGradingBundle(sources, target), /CREDENTIAL_BINDING_MISSING/);
  const reused = destinations();
  const oldHook = sources.flatMap(s => s.workflow.nodes).find(n => n.type === 'n8n-nodes-base.webhook');
  reused.webhooks[Object.keys(reused.webhooks)[0]].webhookId = oldHook.webhookId;
  assert.throws(() => buildGradingBundle(sources, reused), /WEBHOOK_TARGET_INVALID/);
});
test('claim calls only K67 and preserves job identity, refusing a multi-job response', async () => {
  const code = codeFor(bundle(), 'DHUgPXJdCfVZWj56', 'Nhận việc chấm');
  const requests = [];
  const job = { jobId: 'job-fixture-1', runKey: 'term-test-1:fixture:task-2', taskNumber: 2, jobType: 'dispatch' };
  const context = { $: () => ({ first: () => ({ json: { sync_secret: 'fixture-key-'.repeat(4) } }) }), $execution: { id: 'fixture-1' }, $helpers: { httpRequest: async request => { requests.push(request); return { jobs: [job] }; } } };
  const result = await execute(code, context);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, K67_BACKEND + '/claim');
  assert.deepEqual(requests[0].body, { workerId: 'term-mini-k67-writing-event:fixture-1', limit: 1 });
  assert.equal(result[0].json.jobId, job.jobId);
  assert.equal(result[0].json.runKey, job.runKey);
  context.$helpers.httpRequest = async () => ({ jobs: [job, { ...job, jobId: 'other' }] });
  await assert.rejects(execute(code, context), /MULTI_JOB_REJECTED/);
});
test('production claim uses the dedicated HTTPS server and preserves the same job identity', async () => {
  const target = { ...destinations(), apiBaseUrl: K67_PRODUCTION_API };
  const built = buildGradingBundle(sources, target);
  const calls = [];
  const job = { jobId: 'synthetic-port-job', runKey: 'synthetic-port-run', taskNumber: 2, jobType: 'dispatch' };
  const output = await execute(codeFor(built, 'DHUgPXJdCfVZWj56', 'Nhận việc chấm'), {
    $: () => ({ first: () => ({ json: { sync_secret: 'synthetic-key-'.repeat(4) } }) }),
    $execution: { id: 'synthetic-port-execution' },
    $helpers: { httpRequest: async request => { calls.push(request); return { jobs: [job] }; } }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, K67_PRODUCTION_API + '/api/term-tests/writing-grading/jobs/claim');
  assert.equal(output[0].json.jobId, job.jobId);
  assert.equal(output[0].json.runKey, job.runKey);
  for (const entry of built) assert.equal(JSON.stringify(entry.workflow).includes(K67_BACKEND), false);
});
test('a backend target outside the assigned K67 server is rejected before building', () => {
  for (const apiBaseUrl of ['http://ducizone.ddns.net:18869/term-mini-k67-api',
    'https://elsewhere.invalid/term-mini-k67-api', K67_PRODUCTION_API + '?upstream=other',
    'https://ducizone.ddns.net/mapping-api', null]) {
    assert.throws(() => buildGradingBundle(sources, { ...destinations(), apiBaseUrl }), /BACKEND_TARGET_INVALID/);
  }
});
test('collect refuses another run or task and reports failure only to K67', async () => {
  const code = codeFor(bundle(), 'DHUgPXJdCfVZWj56', 'Ghi kết quả vào bài thi');
  const job = { jobId: 'job-fixture-1', runKey: 'term-test-1:fixture:task-2', taskNumber: 2 };
  for (const bad of [{ runKey: 'other', taskNumber: 2 }, { runKey: job.runKey, taskNumber: 1 }]) {
    const calls = [];
    const context = { $: name => name === 'Đọc khóa đồng bộ' ? { first: () => ({ json: { sync_secret: 'fixture-key-'.repeat(4) } }) } : { item: { json: job } }, $execution: { id: 'fixture-2' }, $json: { cacheValue: JSON.stringify({ ...bad, result: { fixture: true } }) }, $helpers: { httpRequest: async request => { calls.push(request); return { ok: true }; } } };
    const output = await execute(code, context);
    assert.equal(output.json.completed, false);
    assert.equal(output.json.cacheKey, K67_CACHE + job.runKey);
    assert.deepEqual(calls.map(c => c.url), [K67_BACKEND + '/fail']);
    assert.equal(calls[0].body.jobId, job.jobId);
  }
});
test('Portal writer accepts only the K67 key and keeps exact destination identity', async () => {
  const code = codeFor(bundle(), 'NFgOTzvfzfjwqY9x', 'Xác thực và chuẩn bị dữ liệu');
  const body = { version: 1, attemptToken: '00000000-0000-4000-8000-000000000067', testSlug: 'term-test-1', classId: 670001, studentId: 670002, grades: { writing: 6.5 } };
  const vars = { K67_ERP_SYNC_SECRET: 'fixture-k67', TERM_TEST_ERP_SYNC_SECRET: 'fixture-old-term', WRITING_TEST_SYNC_SECRET: 'fixture-old-writing', WRITING_TEST_MAPPING_SYNC_SECRET: 'fixture-old-mapping' };
  for (const [header, value] of [['x-term-test-sync', vars.K67_ERP_SYNC_SECRET], ['x-term-test-sync', vars.TERM_TEST_ERP_SYNC_SECRET], ['x-writing-test-sync', vars.WRITING_TEST_SYNC_SECRET], ['x-writing-test-sync', vars.WRITING_TEST_MAPPING_SYNC_SECRET]]) {
    const run = () => execute(code, { $input: { first: () => ({ json: { headers: { [header]: value }, body } }) }, $vars: vars });
    if (value === vars.K67_ERP_SYNC_SECRET) {
      const output = (await run())[0].json;
      assert.equal(output.attemptToken, body.attemptToken);
      assert.equal(output.classId, body.classId);
      assert.equal(output.studentId, body.studentId);
      assert.deepEqual(output.expected, { writing: 6.5 });
    } else await assert.rejects(run(), /SYNC_UNAUTHORIZED/);
  }
});

test('all 41 checkpoint stages use K67 namespace while preserving job and stage identity', async () => {
  const built = bundle();
  let checked = 0;
  for (const entry of built) {
    const node = entry.workflow.nodes.find(n => n.name === 'Kiểm danh tính bước chấm');
    if (!node) continue;
    const before = sources.find(s => s.workflow.id === entry.sourceId).workflow.nodes.find(n => n.name === node.name);
    const job = { runKey: 'term-test-1:synthetic:checkpoint', de_bai: 'Synthetic question', noi_dung: 'Synthetic essay' };
    for (const field of ['stageKey', 'registryId', 'registryVersion']) {
      const match = before.parameters.jsCode.match(new RegExp('job\\.' + field + '!==("[^"\\n]+")'));
      assert.ok(match, 'Pinned stage contract must be explicit');
      job[field] = JSON.parse(match[1]);
    }
    const context = { $input: { all: () => [{ json: job }] } };
    const oldResult = (await execute(before.parameters.jsCode, context))[0].json;
    const nextResult = (await execute(node.parameters.jsCode, context))[0].json;
    assert.equal(nextResult.checkpointKey, oldResult.checkpointKey.replace('termtest:writing:parity:', 'termmini:k67:writing:parity:'));
    const { checkpointKey: oldKey, ...oldIdentity } = oldResult;
    const { checkpointKey: newKey, ...newIdentity } = nextResult;
    assert.deepEqual(newIdentity, oldIdentity);
    const checkpointNodes = entry.workflow.nodes.filter(n => ['Đọc bước đã hoàn tất', 'Lưu bước đã hoàn tất'].includes(n.name));
    assert.equal(checkpointNodes.length, 2);
    for (const redis of checkpointNodes) assert.match(redis.parameters.key, /checkpointKey/);
    checked += 1;
  }
  assert.equal(checked, 41);
});

// Đọc lại đúng ô Portal giả: ô chưa có điểm không được coi là điểm 0 đã ghi.
// Không gọi mạng; chạy chính Code node được bộ dựng K67 sinh ra.
test('Portal readback rejects empty and nonnumeric cells when expected grade is zero', async () => {
  const code = codeFor(bundle(), 'NFgOTzvfzfjwqY9x', 'Kiểm tra kết quả ghi');
  const prepared = { attemptToken: '00000000-0000-4000-8000-000000000067', testSlug: 'term-test-1', classId: 670001, studentId: 670002, phase: 1, expected: { listening: 0 }, portalTestNames: {} };
  for (const grade of [undefined, null, '', ' ', '\t\n', false, true, [], [0], {}]) {
    const portal = { class_tests: [{ id: 6701, name: 'Phase 1 Listening' }], student_test_grades: [{ student_id: prepared.studentId, class_test_id: 6701, grade }] };
    await assert.rejects(execute(code, { $: () => ({ first: () => ({ json: prepared }) }), $input: { first: () => ({ json: portal }) } }), /SYNC_VERIFY_FAILED_LISTENING/, 'Empty or malformed Portal cell must not acknowledge grade 0');
  }
});

test('Portal readback accepts real zero and numeric zero strings on the exact destination', async () => {
  const code = codeFor(bundle(), 'NFgOTzvfzfjwqY9x', 'Kiểm tra kết quả ghi');
  const prepared = { attemptToken: '00000000-0000-4000-8000-000000000067', testSlug: 'term-test-1', classId: 670001, studentId: 670002, phase: 1, expected: { listening: 0 }, portalTestNames: {} };
  for (const grade of [0, '0', '0.0', ' 0 ']) {
    const portal = { class_tests: [{ id: 6701, name: 'Phase 1 Listening' }], student_test_grades: [{ student_id: prepared.studentId, class_test_id: 6701, grade }] };
    const result = await execute(code, { $: () => ({ first: () => ({ json: prepared }) }), $input: { first: () => ({ json: portal }) } });
    assert.equal(result[0].json.ok, true);
    assert.equal(result[0].json.status, 'synced');
  }
});

test('credential from another shared node cannot be presented as a new K67 credential', () => {
  const target = destinations();
  const keys = Object.keys(target.credentials).filter(key => key.startsWith('default:httpHeaderAuth:'));
  assert.equal(keys.length, 2);
  target.credentials[keys[0]] = { id: keys[1].split(':')[2], name: 'Wrong shared credential' };
  assert.throws(() => buildGradingBundle(sources, target), /CREDENTIAL_BINDING_MISSING/);
});

test('every static Redis key belongs to K67, including provider key lookups', () => {
  let keys = 0;
  for (const { workflow } of bundle()) for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.redis' && !node.parameters.key.startsWith('={{')) {
      assert.match(node.parameters.key, /^termmini:k67:/);
      keys += 1;
    }
  }
  assert.equal(keys, 6);
});
