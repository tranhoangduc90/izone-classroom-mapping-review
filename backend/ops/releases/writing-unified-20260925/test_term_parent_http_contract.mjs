import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../../../src/app.js';
import { createTermTestWritingGradingService } from '../../../src/term-test-writing-grading.js';

// Dữ liệu vào: bản JSON đã làm sạch của workflow cha ứng viên và bài giả trong PGlite.
// Việc chính: chạy chính Code node nhận việc/xác nhận/lưu kết quả qua API Express thật.
// Kết quả: số job đúng nguồn, lớp, lượt, Task và số callback đã lưu trong database trong bộ nhớ.
// Khi lỗi: dừng với mã khác 0; không dùng secret, bài thật hoặc database production.
const candidatePath = process.argv[2];
if (!candidatePath) throw new Error('TERM_PARENT_CANDIDATE_PATH_REQUIRED');
const workflow = JSON.parse(await readFile(resolve(candidatePath), 'utf8'));
assert.equal(workflow.active, false, 'TERM_PARENT_CANDIDATE_MUST_BE_INACTIVE');
function nodeCode(name) {
  const matches = workflow.nodes.filter(node => node.name === name);
  assert.equal(matches.length, 1, `TERM_PARENT_NODE_CARDINALITY:${name}`);
  return matches[0].parameters.jsCode;
}

const database = new PGlite();
await database.exec(`
  CREATE SCHEMA assessment;
  CREATE TABLE assessment.term_test_attempt (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_slug TEXT NOT NULL,
    erp_course_class_id BIGINT,
    erp_student_contact_id BIGINT,
    class_name_snapshot TEXT,
    student_name_snapshot TEXT,
    listening_result JSONB,
    combined_result JSONB,
    completed_at TIMESTAMPTZ,
    writing_submitted_at TIMESTAMPTZ
  );
`);
const migration = await readFile(new URL(
  '../../../../docs/migrations/2026-08-19-term-test-writing-grading.sql',
  import.meta.url), 'utf8');
await database.exec(migration);

const syncCalls = [];
const service = createTermTestWritingGradingService({
  pool: database,
  syncErpGrades: async payload => {
    syncCalls.push(payload);
    return { status: 'synced', attemptToken: payload.attemptToken };
  }
});
const secret = 's'.repeat(32);
const app = createApp({
  config: {
    nodeEnv: 'test', port: 8788,
    databaseUrl: 'postgresql://unused-in-memory', dbPoolMax: 2,
    authMode: 'legacy', googleClientId: '',
    legacyReviewToken: 'test-token',
    allowedOrigins: new Set(['https://example.test']), trustProxyHops: 0,
    writingTestSyncSecret: secret
  },
  pool: database,
  termTestWritingGradingService: service
});

async function httpRequest(options) {
  // Chuyển URL production cố định trong Code node sang chính API Express trong bộ nhớ.
  // Yêu cầu đi qua parser, xác thực và validation HTTP thật nhưng không dùng mạng ngoài.
  const prefix = 'https://ducizone.ddns.net/mapping-api';
  assert.ok(options.url.startsWith(prefix), 'TERM_PARENT_HTTP_DESTINATION_DRIFT');
  const response = await request(app).post(options.url.slice(prefix.length))
    .set(options.headers).send(options.body);
  assert.equal(response.status, 200,
    `TERM_PARENT_HTTP_${response.status}:${response.body?.error || 'unknown'}`);
  return response.body;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runCode(name, { job = null, data = {}, executionId }) {
  const code = nodeCode(name);
  const lookup = nodeName => {
    if (nodeName === 'Đọc khóa đồng bộ') {
      return { first: () => ({ json: { sync_secret: secret } }) };
    }
    if (nodeName === 'Nhận việc chấm' && job) {
      return { item: { json: job } };
    }
    throw new Error(`TERM_PARENT_UNEXPECTED_NODE_REFERENCE:${nodeName}`);
  };
  const fn = new AsyncFunction('$', '$json', '$execution', '$helpers', code);
  return fn.call({ helpers: { httpRequest } }, lookup, data,
    { id: executionId }, { httpRequest });
}

function criteria(taskNumber) {
  const codes = taskNumber === 1 ? ['TA', 'CC', 'LR', 'GRA']
    : ['TR', 'CC', 'LR', 'GRA'];
  return codes.map(code => ({
    code, name: code, bandScore: 6, feedback: `Nhận xét giả ${code}`,
    components: [{ code: `${code.toLowerCase()}_detail`,
      label: `Khía cạnh ${code}`, summary: `Tóm tắt ${code}`,
      feedback: `Chi tiết giả ${code}` }]
  }));
}

const cases = [
  { slug: 'term-test-1', task: 2, source: 'k67_web' },
  { slug: 'term-test-1-k56', task: 2, source: 'k56_web' },
  { slug: 'term-test-2-k56', task: 1, source: 'k56_web' },
  { slug: 'mini-test-k56', task: 2, source: 'k56_web' },
];
const results = [];
for (const [index, fixture] of cases.entries()) {
  const attemptToken = `00000000-0000-4000-8000-${String(index + 301).padStart(12, '0')}`;
  const classId = 2301 + index;
  const combinedResult = fixture.source === 'k56_web'
    ? { listening: { total: fixture.slug === 'mini-test-k56' ? 10 : 40,
      correct: 6, band: 6 },
      reading: { total: fixture.slug === 'term-test-1-k56' ? 26
        : fixture.slug === 'mini-test-k56' ? 13 : 40,
      correct: 6, band: 6 } }
    : { listening: { band: 6 }, reading: { band: 6 } };
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, erp_course_class_id, erp_student_contact_id,
    class_name_snapshot, student_name_snapshot, combined_result,
    completed_at, writing_submitted_at
  ) VALUES ($1::uuid, $2, $3, $4, $5, 'Học viên giả', $6::jsonb, now(), now());`,
  [attemptToken, fixture.slug, classId, 9301 + index,
    `CODEX-${classId}`, JSON.stringify(combinedResult)]);
  const taskDefinition = { id: `task${fixture.task}`, prompt: 'Đề giả cho kiểm HTTP' };
  if (fixture.task === 1) taskDefinition.image = 'https://example.test/chart.png';
  await service.ensureSubmission({
    attemptToken,
    testSlug: fixture.slug,
    task1: fixture.task === 1 ? 'Bài giả Task 1' : '',
    task2: fixture.task === 2 ? 'Bài giả Task 2' : '',
    taskDefinitions: [taskDefinition]
  });

  const dispatchItems = await runCode('Nhận việc chấm', {
    executionId: `synthetic-dispatch-${index}`
  });
  assert.equal(dispatchItems.length, 1, 'TERM_PARENT_DISPATCH_COUNT');
  const dispatch = dispatchItems[0].json;
  assert.equal(dispatch.source, fixture.source);
  assert.equal(dispatch.classId, String(classId));
  assert.equal(dispatch.attemptId, attemptToken);
  assert.equal(dispatch.taskNumber, fixture.task);
  assert.equal(dispatch.operationId, dispatch.jobId);
  const guard = new Function('$json', nodeCode('Kiểm nguồn, lớp và lượt trước khi chấm'));
  const routed = guard(dispatch).json;
  assert.ok(['k67', 'k56_term', 'k56_mini'].includes(routed.routeFamily));
  const confirmed = await runCode('Xác nhận đã chấm xong', {
    job: dispatch, executionId: `synthetic-dispatch-${index}`
  });
  assert.equal(confirmed.json.ok, true);
  assert.equal(confirmed.json.jobId, dispatch.jobId);

  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at = now() WHERE job_type = 'collect' AND status <> 'complete';`);
  const collectItems = await runCode('Nhận việc chấm', {
    executionId: `synthetic-collect-${index}`
  });
  assert.equal(collectItems.length, 1, 'TERM_PARENT_COLLECT_COUNT');
  const collect = collectItems[0].json;
  assert.equal(collect.runKey, dispatch.runKey);
  const result = { taskScore: 6, criteria: criteria(fixture.task),
    report: 'Báo cáo giả để thử callback' };
  const saved = await runCode('Ghi kết quả vào bài thi', {
    job: collect, executionId: `synthetic-collect-${index}`,
    data: { cacheValue: JSON.stringify({
      runKey: collect.runKey, taskNumber: fixture.task, result
    }) }
  });
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.writingReady, true);
  assert.equal(saved.json.portalSyncStatus, 'synced');
  const readback = await database.query(`SELECT count(*)::integer AS count
    FROM assessment.term_test_writing_grading_job AS job
    JOIN assessment.term_test_writing_grading_run AS run ON run.id = job.run_id
    WHERE run.attempt_id = $1::uuid AND job.status = 'complete';`, [attemptToken]);
  assert.equal(readback.rows[0].count, 2);
  results.push({ source: fixture.source, testSlug: fixture.slug,
    taskNumber: fixture.task, routeFamily: routed.routeFamily,
    jobsComplete: readback.rows[0].count });
}

assert.equal(syncCalls.length, 4);
const miniSync = syncCalls.find(payload => payload.testSlug === 'mini-test-k56');
assert.ok(miniSync, 'MINI_PORTAL_PAYLOAD_MISSING');
assert.deepEqual(Object.keys(miniSync.grades).sort(), ['listening', 'reading']);
console.log(JSON.stringify({ toolOutcome: 'success', productionWrites: 0,
  cases: results, portalSyncCalls: syncCalls.length,
  miniWritingPortalWrites: Number(Object.hasOwn(miniSync.grades, 'writing')) }));
