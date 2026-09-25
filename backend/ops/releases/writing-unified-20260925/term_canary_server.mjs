import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
const TEST_SLUG = 'term-test-2-k56';

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

function parseCache(value) {
  assert.equal(typeof value, 'string', 'CANARY_CACHE_REQUIRED');
  assert.ok(value.length > 0 && value.length < 8_000_000, 'CANARY_CACHE_SIZE_INVALID');
  const parsed = JSON.parse(value);
  assert.equal(parsed.schemaVersion, 1, 'CANARY_CACHE_SCHEMA_INVALID');
  assert.equal(parsed.taskNumber, 1, 'CANARY_CACHE_TASK_INVALID');
  assert.match(String(parsed.runKey), /^term-test-2-k56:/u, 'CANARY_CACHE_RUN_KEY_INVALID');
  assert.equal(typeof parsed.result?.taskScore, 'number', 'CANARY_CACHE_SCORE_INVALID');
  assert.equal(parsed.result.criteria?.length, 4, 'CANARY_CACHE_CRITERIA_INVALID');
  return parsed;
}

// Dữ liệu vào: cache của đúng execution bài giả, Redis thử và PostgreSQL nhúng trống.
// Việc chính: tạo một job collect trong kho riêng rồi đặt cache vào Redis bằng SET NX/TTL.
// Kết quả: n8n có thể nhận đúng một job giả, đọc cache và callback vào API thật trong canary.
// Khi lỗi: không mở lại seed; dừng và khởi tạo container mới, khóa Redis tự hết hạn.
export async function createTermCanary({
  setRedis = (key, value) => redisCommand(['SET', key, value, 'EX', TTL_SECONDS, 'NX']),
  deleteRedis = key => redisCommand(['DEL', key]),
} = {}) {
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
      const envelope = parseCache(cacheValue);
      attemptToken = randomUUID();
      const combined = { listening: { total: 40, correct: 20, band: 5.5 },
        reading: { total: 40, correct: 20, band: 5.5 } };
      await pool.query(`INSERT INTO assessment.term_test_attempt (
        id, test_slug, erp_course_class_id, erp_student_contact_id,
        class_name_snapshot, student_name_snapshot, combined_result,
        completed_at, writing_submitted_at
      ) VALUES ($1::uuid, $2, 99000001, 99000001,
        'CODEX-CANARY', 'Học viên giả', $3::jsonb, now(), now());`,
      [attemptToken, TEST_SLUG, JSON.stringify(combined)]);
      await service.ensureSubmission({ attemptToken, testSlug: TEST_SLUG,
        task1: 'Bài giả cho phép thử callback', task2: '',
        taskDefinitions: [{ id: 'task1', prompt: 'Đề giả, chỉ dùng nhánh collect' }] });
      const updated = await pool.query(`UPDATE assessment.term_test_writing_grading_run
        SET run_key = $1 WHERE attempt_id = $2::uuid AND task_number = 1 RETURNING id;`,
      [envelope.runKey, attemptToken]);
      assert.equal(updated.rows.length, 1, 'CANARY_RUN_KEY_BINDING_FAILED');
      const [dispatch] = await service.claimJobs({ workerId: 'canary-seed', limit: 1,
        testSlug: TEST_SLUG });
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
  app.get('/__canary/audit', localOnly, async (_req, res) => {
    const jobs = await pool.query(`SELECT job_type, status, count(*)::int AS total
      FROM assessment.term_test_writing_grading_job
      GROUP BY job_type, status ORDER BY job_type, status;`);
    const runs = await pool.query(`SELECT status, task_number
      FROM assessment.term_test_writing_grading_run;`);
    return res.json({ ok: true, database: 'embedded_pglite', seedState, syncKey,
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
  const canary = await createTermCanary();
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
