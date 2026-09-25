import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAssessmentSchemaPool } from '../../../src/assessment-schema-pool.js';
import { createErpGradeSync } from '../../../src/erp-sync.js';
import { createTermTestWritingGradingService } from '../../../src/term-test-writing-grading.js';

// Dữ liệu vào: URL PostgreSQL của container thử riêng và bài giả Term 2 K56.
// Việc chính: cho hai tiến trình tranh cùng job/callback, trong khi cổng điểm giả trả lời chậm.
// Kết quả: chỉ một lần gọi cổng điểm, một job hoàn tất và trạng thái đồng bộ đã lưu.
// Khi lỗi: in mã kiểm thử, không in bài, định danh hay cấu hình kết nối.
const databaseUrl = process.env.TERM_CANARY_DATABASE_URL;
if (!databaseUrl) throw new Error('CANARY_DATABASE_URL_MISSING');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const scopedPool = createAssessmentSchemaPool(pool, { family: 'k56' });
const result = {
  taskScore: 6,
  report: 'Báo cáo giả',
  criteria: ['TA', 'CC', 'LR', 'GRA'].map(code => ({
    code,
    bandScore: 6,
    feedback: 'Nhận xét giả',
    components: [{ code: `${code.toLowerCase()}_detail`, label: code,
      summary: 'Tóm tắt giả', feedback: 'Chi tiết giả' }]
  }))
};

function service(syncErpGrades = null) {
  return createTermTestWritingGradingService({ pool: scopedPool, syncErpGrades,
    logger: { warn() {}, info() {}, error() {} } });
}

async function worker() {
  // Mỗi tiến trình con có pool riêng; IPC chỉ mang mã job giả và trạng thái tổng hợp.
  const [mode, workerId, jobId, runKey] = process.argv.slice(2);
  try {
    let outcome;
    if (mode === 'claim') {
      const jobs = await service().claimJobs({ workerId, limit: 1,
        testSlug: 'term-test-2-k56' });
      outcome = { ok: true, jobs: jobs.map(job => ({ jobId: job.jobId,
        jobType: job.jobType, runKey: job.runKey })) };
    } else if (mode === 'result') {
      const syncErpGrades = createErpGradeSync({ pool: scopedPool,
        config: { demoIsolatedMode: false,
          erpSyncUrl: process.env.TERM_CANARY_PORTAL_URL,
          erpSyncSecret: 'canary-only', erpSyncTimeoutMs: 5000,
          k56PortalPilotEnabled: true },
        logger: { warn() {}, info() {}, error() {} } });
      const saved = await service(syncErpGrades).completeResult({
        jobId, workerId, runKey, result
      });
      outcome = { ok: true, status: saved.status,
        portalSyncStatus: saved.portalSyncStatus };
    } else {
      throw new Error('CANARY_WORKER_MODE_INVALID');
    }
    process.send?.(outcome);
  } catch (error) {
    process.send?.({ ok: false, code: String(error?.code || error?.message || 'UNKNOWN')
      .replace(/[^A-Z0-9_]/gi, '_').slice(0, 80) });
  } finally {
    await pool.end();
  }
}

function child(mode, workerId, jobId = '', runKey = '', extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const process = fork(fileURLToPath(import.meta.url),
      [mode, workerId, jobId, runKey], {
        env: { ...globalThis.process.env, ...extraEnv },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
    let message;
    process.on('message', value => { message = value; });
    process.on('error', reject);
    process.on('exit', code => code === 0 && message
      ? resolve(message) : reject(new Error('CANARY_WORKER_EXIT')));
  });
}

async function prepareDatabase() {
  // Chỉ tạo bảng trong database trống của container thử; không nhận URL production.
  const identity = await pool.query('SELECT current_database() AS name;');
  assert.equal(identity.rows[0].name, 'term_canary', 'CANARY_DATABASE_NAME_MISMATCH');
  await pool.query(`CREATE SCHEMA assessment_k56; CREATE SCHEMA mapping;
    CREATE TABLE assessment_k56.term_test_attempt (
      id uuid PRIMARY KEY, test_slug text NOT NULL, erp_course_class_id bigint,
      erp_student_contact_id bigint, class_name_snapshot text,
      student_name_snapshot text, combined_result jsonb,
      completed_at timestamptz, writing_submitted_at timestamptz
    );
    CREATE TABLE assessment_k56.term_test_class_access (
      test_slug text NOT NULL, erp_course_class_id bigint NOT NULL,
      enabled boolean NOT NULL
    );
    CREATE TABLE assessment_k56.test_definition (
      slug text PRIMARY KEY, is_active boolean NOT NULL
    );
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id bigint PRIMARY KEY
    );
    CREATE TABLE assessment_k56.term_test_portal_sync_state (
      attempt_id uuid NOT NULL, payload_fingerprint text NOT NULL,
      test_slug text NOT NULL, grade_fields text[] NOT NULL,
      status text NOT NULL, attempted_at timestamptz,
      updated_at timestamptz, completed_at timestamptz,
      error_code text, http_status integer, duration_ms integer,
      PRIMARY KEY (attempt_id, payload_fingerprint)
    );`);
  const migration = await readFile(new URL(
    '../../../../docs/migrations/2026-08-19-term-test-writing-grading.sql',
    import.meta.url), 'utf8');
  await pool.query(migration.replace(/\bassessment\./gu, 'assessment_k56.'));
  await pool.query(`INSERT INTO mapping.classroom_course_mapping VALUES (9000001);
    INSERT INTO assessment_k56.test_definition VALUES ('term-test-2-k56', true);
    INSERT INTO assessment_k56.term_test_class_access VALUES
      ('term-test-2-k56', 9000001, true);`);
}

async function main() {
  let stage = 'prepare';
  let server;
  try {
    await prepareDatabase();
    const attemptId = randomUUID();
    const combined = { listening: { total: 40, correct: 20, band: 5.5 },
      reading: { total: 40, correct: 20, band: 5.5 } };
    await scopedPool.query(`INSERT INTO assessment.term_test_attempt (
      id, test_slug, erp_course_class_id, erp_student_contact_id,
      class_name_snapshot, student_name_snapshot, combined_result,
      completed_at, writing_submitted_at
    ) VALUES ($1::uuid, 'term-test-2-k56', 9000001, 9000002,
      'CANARY-ONLY', 'Học viên giả', $2::jsonb, now(), now());`,
    [attemptId, JSON.stringify(combined)]);
    await service().ensureSubmission({ attemptToken: attemptId,
      testSlug: 'term-test-2-k56', task1: 'Bài giả', task2: '',
      taskDefinitions: [{ id: 'task1', prompt: 'Đề giả' }] });

    stage = 'dispatch_claim';
    const claims = await Promise.all([
      child('claim', 'canary-a'), child('claim', 'canary-b')
    ]);
    assert.ok(claims.every(item => item.ok), 'CANARY_DISPATCH_CLAIM_ERROR');
    const claimed = claims.flatMap(item => item.jobs);
    assert.equal(claimed.length, 1, 'CANARY_DISPATCH_DUPLICATE');
    assert.equal(claimed[0].jobType, 'dispatch');
    const winner = claims.findIndex(item => item.jobs.length === 1);
    await service().completeDispatch({ jobId: claimed[0].jobId,
      workerId: winner === 0 ? 'canary-a' : 'canary-b' });
    await scopedPool.query(`UPDATE assessment.term_test_writing_grading_job
      SET next_attempt_at = now() WHERE job_type = 'collect';`);

    stage = 'collect_claim';
    const collectClaims = await Promise.all([
      child('claim', 'canary-a'), child('claim', 'canary-b')
    ]);
    assert.ok(collectClaims.every(item => item.ok), 'CANARY_COLLECT_CLAIM_ERROR');
    const collect = collectClaims.flatMap(item => item.jobs);
    assert.equal(collect.length, 1, 'CANARY_COLLECT_DUPLICATE');
    assert.equal(collect[0].jobType, 'collect');
    const collectWinner = collectClaims.findIndex(item => item.jobs.length === 1);
    const workerId = collectWinner === 0 ? 'canary-a' : 'canary-b';

    stage = 'portal_callback';
    let portalCalls = 0;
    server = http.createServer(async (request, response) => {
      portalCalls += 1;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await new Promise(resolve => setTimeout(resolve, 750));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, status: 'synced',
        attemptToken: payload.attemptToken }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const portalUrl = `http://127.0.0.1:${server.address().port}/canary`;
    const callbacks = await Promise.all([
      child('result', workerId, collect[0].jobId, collect[0].runKey,
        { TERM_CANARY_PORTAL_URL: portalUrl }),
      child('result', workerId, collect[0].jobId, collect[0].runKey,
        { TERM_CANARY_PORTAL_URL: portalUrl })
    ]);
    assert.ok(callbacks.some(item => item.ok), 'CANARY_CALLBACK_NONE_ACCEPTED');
    assert.equal(portalCalls, 1, 'CANARY_PORTAL_DUPLICATE');
    const jobs = await scopedPool.query(`SELECT job_type, status
      FROM assessment.term_test_writing_grading_job ORDER BY job_type;`);
    assert.equal(jobs.rows.find(row => row.job_type === 'collect')?.status,
      'complete', 'CANARY_COLLECT_NOT_COMPLETE');
    const sync = await scopedPool.query(`SELECT status
      FROM assessment.term_test_portal_sync_state;`);
    assert.deepEqual(sync.rows.map(row => row.status), ['synced'],
      'CANARY_PORTAL_STATE_NOT_SYNCED');
    const final = await scopedPool.query(`SELECT status
      FROM assessment.term_test_writing_grading_final;`);
    assert.deepEqual(final.rows.map(row => row.status), ['ready'],
      'CANARY_WRITING_NOT_READY');
    stage = 'duplicate_replay';
    const replay = await child('result', workerId, collect[0].jobId,
      collect[0].runKey, { TERM_CANARY_PORTAL_URL: portalUrl });
    assert.equal(replay.ok, true, 'CANARY_REPLAY_FAILED');
    assert.equal(replay.status, 'duplicate', 'CANARY_REPLAY_NOT_DUPLICATE');
    assert.equal(portalCalls, 1, 'CANARY_REPLAY_PORTAL_DUPLICATE');
    const conflict = callbacks.find(item => !item.ok);
    if (conflict) {
      const failed = await service().failJob({ jobId: collect[0].jobId,
        workerId, errorCode: conflict.code });
      assert.equal(failed.status, 'already_complete',
        'CANARY_CONFLICT_CHANGED_COMPLETE_JOB');
    }
    console.log(JSON.stringify({ toolOutcome: 'success', businessOutcome: 'success',
      database: 'isolated_postgresql', processes: 2, dispatchClaims: claimed.length,
      collectClaims: collect.length, portalCalls, callbackAccepted:
        callbacks.filter(item => item.ok).length,
      callbackConflicts: callbacks.filter(item => !item.ok).map(item => item.code),
      replayStatus: 'duplicate', conflictFailStatus: conflict ? 'already_complete' : 'not_applicable',
      collectStatus: 'complete', portalStatus: 'synced', finalStatus: 'ready' }));
  } catch (error) {
    console.log(JSON.stringify({ toolOutcome: 'success', businessOutcome: 'failure',
      stage, code: String(error?.message || 'UNKNOWN').replace(/[^A-Z0-9_]/gi, '_').slice(0, 100) }));
    process.exitCode = 2;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
}

if (process.argv.length > 2) await worker();
else await main();
