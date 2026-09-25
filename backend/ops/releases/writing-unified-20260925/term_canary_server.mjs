import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../../../src/app.js';
import { createAssessmentSchemaPool } from '../../../src/assessment-schema-pool.js';
import { createTermTestWritingGradingService } from '../../../src/term-test-writing-grading.js';

const PORT = 8791;
const REDIS_HOST = 'redis';
const REDIS_PORT = 6379;
const TTL_SECONDS = 7200;
export const PROFILES = Object.freeze({
  term: Object.freeze({ testSlug: 'term-test-2-k56', taskNumber: 1,
    prompt: 'The graph below shows the amounts of waste produced by three companies over a period of 15 years.',
    followUp: 'Summarise the information by selecting and reporting the main features, and make comparisons where relevant.',
    image: 'https://ducizone.ddns.net/writing-assets/v1/4a6b19c91981dbabf3bc559c7764a04ffb28ac4e1b61f9a954147c7712b337b1.png',
    promptSha256: '869873a419079aba3a6d145c8700eddfc609c3865b1935d49fa698b7614d7c51' }),
  term1: Object.freeze({ testSlug: 'term-test-1-k56', taskNumber: 2,
    prompt: 'Although more and more people read the news on the Internet, newspapers will remain the main source of news for the majority of people.',
    followUp: 'To what extent do you agree or disagree?',
    image: '',
    promptSha256: '23161a3ecea18085daa41b02336292839eb4b57536d9cf590efc2e29881007fb' }),
  mini: Object.freeze({ testSlug: 'mini-test-k56', taskNumber: 2 }),
});
const SYNTHETIC_ESSAY = 'This is a synthetic writing sample for an isolated grading test. '
  + 'It does not belong to a student. The response states a clear position, offers a reason, '
  + 'and develops an example in ordinary English. The next paragraph explains a possible '
  + 'counterargument before returning to the central idea. The wording is intentionally '
  + 'simple so that the test checks the route, prompt, model, and callback rather than the '
  + 'quality of a real examination script. No personal details, class roster, or actual '
  + 'assessment answer are included. The test should create one grading job, save the '
  + 'result under the same attempt, and send one score to the mock scorebook. If the '
  + 'grader cannot use the selected task definition, it should stop with an error instead '
  + 'of silently switching to another task or course. This final sentence makes the sample '
  + 'long enough to exercise the usual essay path without pretending to be learner work.';

// Dữ liệu vào: đề Term K56 công khai đã được chốt trong registry chuyên môn.
// Việc chính: so prompt nối đúng như backend lưu với hash đã ghim trước khi seed.
// Kết quả: chỉ bài giả có đề đúng mới đi vào hàng chờ canary.
// Khi lỗi: dừng trước khi tạo job; không thử ghép gần đúng sang đề khác.
export function assertCanaryPrompt(profile) {
  const prompt = [profile.prompt, profile.followUp].join('\n\n');
  assert.equal(createHash('sha256').update(prompt.normalize('NFC')
    .replace(/\s+/gu, ' ').trim()).digest('hex'),
    profile.promptSha256, 'CANARY_PROMPT_PIN_MISMATCH');
  return prompt;
}

function encodeRedis(args) {
  return Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap(value => {
    const bytes = Buffer.from(String(value), 'utf8');
    return [Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n')];
  })]);
}

// Dữ liệu vào: lệnh SET/DEL cho đúng hai khóa thử trên Redis chung.
// Việc chính: gửi RESP qua mạng nội bộ, không đưa giá trị cache hoặc khóa vào log.
// Kết quả: OK/đếm xóa; lỗi kết nối hoặc phản hồi lạ dừng phép thử.
// Khi lỗi: khóa có TTL hai giờ; không retry mù và không tác động khóa production.
export function redisCommand(args, { host = REDIS_HOST, port = REDIS_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(5000);
    socket.on('connect', () => socket.write(encodeRedis(args)));
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 1024) return finish(new Error('TERM_CANARY_REDIS_RESPONSE_TOO_LARGE'));
      const end = response.indexOf('\r\n');
      if (end < 0) return;
      const line = response.subarray(0, end).toString('utf8');
      if (line === '+OK') return finish(null, 'OK');
      if (/^:\d+$/u.test(line)) return finish(null, Number(line.slice(1)));
      if (line === '$-1') return finish(null, null);
      return finish(new Error('TERM_CANARY_REDIS_REPLY_INVALID'));
    });
    socket.on('error', () => finish(new Error('TERM_CANARY_REDIS_UNAVAILABLE')));
    socket.on('timeout', () => finish(new Error('TERM_CANARY_REDIS_TIMEOUT')));
  });
}

function localOnly(req, res, next) {
  const address = String(req.socket.remoteAddress ?? '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    return res.status(403).json({ ok: false, error: 'CANARY_LOCAL_ONLY' });
  }
  next();
}

function parseCache(value, profile) {
  assert.equal(typeof value, 'string', 'CANARY_CACHE_REQUIRED');
  assert.ok(value.length > 0 && value.length < 8_000_000, 'CANARY_CACHE_SIZE_INVALID');
  const parsed = JSON.parse(value);
  assert.equal(parsed.schemaVersion, 1, 'CANARY_CACHE_SCHEMA_INVALID');
  assert.equal(parsed.taskNumber, profile.taskNumber, 'CANARY_CACHE_TASK_INVALID');
  assert.ok(String(parsed.runKey).startsWith(`${profile.testSlug}:`),
    'CANARY_CACHE_RUN_KEY_INVALID');
  assert.equal(typeof parsed.result?.taskScore, 'number', 'CANARY_CACHE_SCORE_INVALID');
  assert.equal(parsed.result.criteria?.length, 4, 'CANARY_CACHE_CRITERIA_INVALID');
  return parsed;
}

// Dữ liệu vào: cache của đúng execution bài giả, Redis thử và PostgreSQL nhúng trống.
// Việc chính: tạo một job collect trong kho riêng rồi đặt cache vào Redis bằng SET NX/TTL.
// Kết quả: n8n có thể nhận đúng một job giả, đọc cache và callback vào API thật trong canary.
// Khi lỗi: không mở lại seed; dừng và khởi tạo container mới, khóa Redis tự hết hạn.
export async function createTermCanary({
  profileName = 'term',
  setRedis = (key, value) => redisCommand(['SET', key, value, 'EX', TTL_SECONDS, 'NX']),
  deleteRedis = key => redisCommand(['DEL', key]),
} = {}) {
  const profile = PROFILES[profileName];
  assert.ok(profile, 'CANARY_PROFILE_NOT_APPROVED');
  const database = new PGlite();
  for (const schema of ['assessment', 'assessment_k56']) {
    await database.exec(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.term_test_attempt (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), test_slug TEXT NOT NULL,
        erp_course_class_id BIGINT, erp_student_contact_id BIGINT,
        class_name_snapshot TEXT, student_name_snapshot TEXT,
        listening_result JSONB, combined_result JSONB,
        completed_at TIMESTAMPTZ, writing_submitted_at TIMESTAMPTZ);`);
  }
  const migration = await readFile(new URL(
    '../../../../docs/migrations/2026-08-19-term-test-writing-grading.sql',
    import.meta.url), 'utf8');
  await database.exec(migration);
  await database.exec(migration.replace(/\bassessment\./gu, 'assessment_k56.'));
  const pool = createAssessmentSchemaPool(database, { family: 'k56' });
  const secret = randomBytes(32).toString('hex');
  const syncKey = `codex:writing:term_canary:${randomUUID()}:sync_secret`;
  const syncSet = await setRedis(syncKey, secret);
  assert.equal(syncSet, 'OK', 'CANARY_SYNC_KEY_ALREADY_EXISTS');
  const ownedKeys = new Set([syncKey]);
  let portalMockCalls = 0;
  let seedState = 'empty';
  let attemptToken = null;
  const service = createTermTestWritingGradingService({
    pool,
    syncErpGrades: async payload => {
      // Mô phỏng cổng thật: bài không có điểm để ghi (Mini trong đợt Term) dừng trước request Portal.
      if (Object.keys(payload.grades || {}).length === 0) {
        return { status: 'disabled', attemptToken: payload.attemptToken };
      }
      portalMockCalls += 1;
      return { status: 'synced', attemptToken: payload.attemptToken };
    }
  });
  const config = {
    nodeEnv: 'test', port: PORT,
    databaseUrl: 'postgresql://unused-in-memory', dbPoolMax: 2,
    authMode: 'legacy', googleClientId: '', legacyReviewToken: '',
    allowedOrigins: new Set(), trustProxyHops: 0,
    writingTestSyncSecret: secret,
  };
  const app = express();
  app.post('/__canary/seed', localOnly, express.json({ limit: '8mb' }), async (req, res) => {
    if (seedState !== 'empty') return res.status(409).json({ ok: false, error: 'CANARY_SEED_ALREADY_USED' });
    seedState = 'seeding';
    try {
      const cacheValue = req.body?.cacheValue;
      const envelope = parseCache(cacheValue, profile);
      attemptToken = randomUUID();
      const combined = profileName === 'mini'
        ? { listening: { total: 10, correct: 5 },
          reading: { total: 13, correct: 6 } }
        : profileName === 'term1'
          ? { listening: { total: 40, correct: 20 },
            reading: { total: 26, correct: 13 } }
        : { listening: { total: 40, correct: 20, band: 5.5 },
          reading: { total: 40, correct: 20, band: 5.5 } };
      await pool.query(`INSERT INTO assessment.term_test_attempt (
        id, test_slug, erp_course_class_id, erp_student_contact_id,
        class_name_snapshot, student_name_snapshot, combined_result,
        completed_at, writing_submitted_at
      ) VALUES ($1::uuid, $2, 99000001, 99000001,
        'CODEX-CANARY', 'Học viên giả', $3::jsonb, now(), now());`,
      [attemptToken, profile.testSlug, JSON.stringify(combined)]);
      await service.ensureSubmission({ attemptToken, testSlug: profile.testSlug,
        task1: profile.taskNumber === 1 ? 'Bài giả cho phép thử callback' : '',
        task2: profile.taskNumber === 2 ? 'Đoạn văn giả cho phép thử callback' : '',
        taskDefinitions: [{ id: `task${profile.taskNumber}`,
          prompt: 'Đề giả, chỉ dùng nhánh collect' }] });
      const updated = await pool.query(`UPDATE assessment.term_test_writing_grading_run
        SET run_key = $1 WHERE attempt_id = $2::uuid AND task_number = $3 RETURNING id;`,
      [envelope.runKey, attemptToken, profile.taskNumber]);
      assert.equal(updated.rows.length, 1, 'CANARY_RUN_KEY_BINDING_FAILED');
      const [dispatch] = await service.claimJobs({ workerId: 'canary-seed', limit: 1,
        testSlug: profile.testSlug });
      assert.ok(dispatch && dispatch.jobType === 'dispatch', 'CANARY_DISPATCH_NOT_FOUND');
      await service.completeDispatch({ jobId: dispatch.jobId, workerId: 'canary-seed' });
      await pool.query(`UPDATE assessment.term_test_writing_grading_job
        SET next_attempt_at = now() WHERE job_type = 'collect';`);
      const cacheKey = `termtest:writing:direct:${envelope.runKey}`;
      assert.equal(await setRedis(cacheKey, cacheValue), 'OK', 'CANARY_CACHE_KEY_ALREADY_EXISTS');
      ownedKeys.add(cacheKey);
      seedState = 'ready';
      return res.json({ ok: true, state: seedState, pendingJobs: 1 });
    } catch {
      seedState = 'failed';
      return res.status(409).json({ ok: false, error: 'CANARY_SEED_FAILED' });
    }
  });
  app.post('/__canary/seed-dispatch', localOnly, async (_req, res) => {
    if (seedState !== 'empty') return res.status(409).json({ ok: false, error: 'CANARY_SEED_ALREADY_USED' });
    seedState = 'seeding';
    try {
      assert.ok(profileName === 'term' || profileName === 'term1', 'CANARY_DISPATCH_TERM_ONLY');
      assertCanaryPrompt(profile);
      attemptToken = randomUUID();
      const combined = profileName === 'term1'
        ? { listening: { total: 40, correct: 20 }, reading: { total: 26, correct: 13 } }
        : { listening: { total: 40, correct: 20, band: 5.5 },
          reading: { total: 40, correct: 20, band: 5.5 } };
      await pool.query(`INSERT INTO assessment.term_test_attempt (
        id, test_slug, erp_course_class_id, erp_student_contact_id,
        class_name_snapshot, student_name_snapshot, combined_result,
        completed_at, writing_submitted_at
      ) VALUES ($1::uuid, $2, 99000001, 99000001,
        'CODEX-CANARY', 'Học viên giả', $3::jsonb, now(), now());`,
      [attemptToken, profile.testSlug, JSON.stringify(combined)]);
      await service.ensureSubmission({ attemptToken, testSlug: profile.testSlug,
        task1: profile.taskNumber === 1 ? SYNTHETIC_ESSAY : '',
        task2: profile.taskNumber === 2 ? SYNTHETIC_ESSAY : '',
        taskDefinitions: [{ id: `task${profile.taskNumber}`, prompt: profile.prompt,
          followUp: profile.followUp, image: profile.image }] });
      seedState = 'ready';
      return res.json({ ok: true, state: seedState, pendingJobs: 1,
        jobType: 'dispatch' });
    } catch {
      seedState = 'failed';
      return res.status(409).json({ ok: false, error: 'CANARY_DISPATCH_SEED_FAILED' });
    }
  });
  app.get('/__canary/audit', localOnly, async (_req, res) => {
    const jobs = await pool.query(`SELECT job_type, status, count(*)::int AS total
      FROM assessment.term_test_writing_grading_job
      GROUP BY job_type, status ORDER BY job_type, status;`);
    const runs = await pool.query(`SELECT status, task_number
      FROM assessment.term_test_writing_grading_run;`);
    return res.json({ ok: true, database: 'embedded_pglite', profileName, seedState, syncKey,
      jobs: jobs.rows, runStates: runs.rows, portalMockCalls,
      attemptCount: attemptToken ? 1 : 0, ownedRedisKeys: [...ownedKeys] });
  });
  // Chỉ mở bốn endpoint chấm cho n8n; các API khác trong ứng dụng gốc bị chặn.
  const allowed = new Set([
    'POST /api/term-tests/writing-grading/jobs/claim',
    'POST /api/term-tests/writing-grading/jobs/dispatch-complete',
    'POST /api/term-tests/writing-grading/jobs/result',
    'POST /api/term-tests/writing-grading/jobs/fail',
    'GET /health',
  ]);
  app.use((req, res, next) => {
    if (!allowed.has(`${req.method} ${req.path}`)) {
      return res.status(404).json({ ok: false, error: 'CANARY_ROUTE_CLOSED' });
    }
    next();
  });
  app.use(createApp({ config, pool, termTestWritingGradingService: service }));
  return { app, syncKey, audit: () => ({ seedState, portalMockCalls }),
    async close() {
      for (const key of ownedKeys) await deleteRedis(key);
      await database.close();
    } };
}

if (process.argv[1] && process.argv[1].endsWith('/term_canary_server.mjs')) {
  const canary = await createTermCanary({ profileName: process.env.TERM_CANARY_PROFILE || 'term' });
  const server = canary.app.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(JSON.stringify({ outcome: 'ready', port: PORT,
      database: 'embedded_pglite', publicPort: false }) + '\n');
  });
  process.once('SIGTERM', () => {
    server.close(() => {
      canary.close().then(() => process.exit(0)).catch(() => process.exit(2));
    });
  });
}
