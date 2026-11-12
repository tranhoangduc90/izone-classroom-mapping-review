import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { createContextSnapshot, CONTEXT_MAX_BYTES } from './context-contract.js';

// Pool chỉ có quyền năm view được lọc lớp. Một transaction đọc nhất quán toàn snapshot.
// Khóa sai không chạm DB; DB lỗi trả 503, không đưa dữ liệu hay lỗi SQL vào response.
const reads = [
  ['classes', 'SELECT * FROM k67_context_api_v1.classes ORDER BY erp_course_class_id'],
  ['students', 'SELECT * FROM k67_context_api_v1.students ORDER BY public_id'],
  ['memberships', 'SELECT * FROM k67_context_api_v1.memberships ORDER BY erp_course_class_id,erp_student_contact_id'],
  ['accounts', 'SELECT * FROM k67_context_api_v1.accounts ORDER BY email'],
  ['access', 'SELECT * FROM k67_context_api_v1.access ORDER BY reviewer_email,erp_course_class_id']
];
export async function readContextSnapshot(pool, trace) {
  trace?.stage('pool_wait');
  const client = await pool.connect();
  let rollbackError;
  try {
    trace?.stage('begin');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    trace?.stage('set_timeout');
    await client.query("SET LOCAL statement_timeout='5s'");
    trace?.stage('snapshot_clock');
    const captured = (await client.query('SELECT transaction_timestamp() AS captured')).rows[0].captured;
    const payload = { apiVersion: 1, productId: 'PRODUCT-TERM-MINI-K67' };
    for (const [field, sql] of reads) {
      trace?.stage(field);
      payload[field] = (await client.query(sql)).rows;
    }
    trace?.stage('encode');
    const snapshot = createContextSnapshot(payload, new Date(captured).getTime());
    if (Buffer.byteLength(JSON.stringify(snapshot)) > CONTEXT_MAX_BYTES) throw new Error('CONTEXT_TOO_LARGE');
    trace?.stage('commit');
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    trace?.fail(error);
    trace?.stage('rollback');
    try { await client.query('ROLLBACK'); } catch (failure) { rollbackError = failure; }
    throw error;
  } finally {
    client.release(rollbackError);
  }
}

function failureCode(error, stage) {
  const { code, message } = error ?? {};
  if (code === '57014') return /statement timeout/i.test(message) ? 'DB_STATEMENT_TIMEOUT' : 'DB_QUERY_CANCELED';
  if (stage === 'pool_wait' && /timeout exceeded when trying to connect|connection terminated due to connection timeout/i.test(message)) {
    return 'DB_POOL_TIMEOUT';
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)
      || (typeof code === 'string' && /^08[A-Z0-9]{3}$/.test(code))) return 'DB_CONNECTION_ERROR';
  if (stage === 'encode') return message === 'CONTEXT_TOO_LARGE' ? 'SNAPSHOT_TOO_LARGE' : 'CONTEXT_ENCODE_FAILED';
  if (stage === 'write_response') return 'CONTEXT_RESPONSE_FAILED';
  return 'DB_ERROR';
}

function observeResponse(res, route, log, now, build) {
  const requestId = crypto.randomUUID(), started = now();
  const stageMs = {};
  let stage = 'authorize', stageStarted = started, failure, recorded = false;
  const round = ms => Math.max(0, Math.round(ms));
  res.set('X-Request-Id', requestId);
  function record(clientClosed) {
    if (recorded) return;
    recorded = true;
    const ended = now();
    stageMs[stage] = round(ended - stageStarted);
    try {
      log({ event: 'k67_context_request', version: 1, at: new Date().toISOString(), build, route, requestId,
        status: clientClosed ? 499 : res.statusCode, clientClosed, durationMs: round(ended - started), stage,
        stageMs: { ...stageMs },
        errorCode: clientClosed ? 'CLIENT_DISCONNECTED' : failure?.code ?? null,
        ...(failure ? { failureStage: failure.stage, ...(clientClosed ? { failureCode: failure.code } : {}),
          ...(failure.sqlState ? { sqlState: failure.sqlState } : {}) } : {}) });
    } catch {
      // Lỗi ghi log không làm đổi kết quả của yêu cầu.
    }
  }
  res.once('finish', () => record(false));
  res.once('close', () => { if (!res.writableFinished) record(true); });
  return {
    stage(next) {
      const at = now();
      stageMs[stage] = round(at - stageStarted);
      stage = next;
      stageStarted = at;
    },
    reject() { failure = { code: 'UNAUTHORIZED', stage }; },
    fail(error) {
      const code = error?.code;
      const sqlState = typeof code === 'string' && /^[0-9][A-Z0-9]{4}$/.test(code) ? code : undefined;
      failure ??= { code: failureCode(error, stage), stage, sqlState };
    }
  };
}

export function createContextSourceApp({ pool, secret, log = row => console.info(JSON.stringify(row)),
  now = () => performance.now(), build = process.env.K67_CONTEXT_SOURCE_BUILD_SHA }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('CONTEXT_SECRET_REQUIRED');
  const expected = Buffer.from(secret);
  const buildRef = typeof build === 'string' && /^[0-9a-f]{7,64}$/.test(build) ? build : 'unknown';
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, product: 'K67-context-v1' }));
  function route(path, publicError, read) {
    app.get(path, async (req, res) => {
      const trace = observeResponse(res, path, log, now, buildRef);
      const supplied = Buffer.from(req.get('x-k67-context-key') || '');
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        trace.reject();
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      res.set('Cache-Control', 'no-store');
      try {
        const value = await read(trace);
        trace.stage('write_response');
        return res.json(value);
      } catch (error) {
        trace.fail(error);
        return res.status(503).json({ ok: false, error: publicError });
      }
    });
  }
  // Hợp đồng của tuyến ERP Homework hiện chạy trên VPS1.
  route('/v1/homework/erp-students', 'HOMEWORK_ERP_SOURCE_UNAVAILABLE', async trace => {
    trace.stage('query');
    const { rows } = await pool.query(`SELECT * FROM k67_context_api_v1.homework_erp_students
      ORDER BY erp_course_class_id,erp_student_contact_id`);
    trace.stage('encode');
    return { ok: true, capturedAt: new Date().toISOString(), students: rows };
  });
  route('/v1/homework/class-scope', 'HOMEWORK_CLASS_SCOPE_UNAVAILABLE', async trace => {
    trace.stage('query');
    const { rows } = await pool.query('SELECT class_id AS "classId",class_code AS "classCode",course_id AS "courseId" FROM k67_context_api_v1.homework_class_scope ORDER BY class_id');
    trace.stage('encode');
    const payload = { apiVersion: 1, erpCourseId: '5', classes: rows };
    return { ...payload, capturedAt: new Date().toISOString(),
      sourceRevision: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  });
  route('/v1/snapshot', 'CONTEXT_SOURCE_UNAVAILABLE', trace => readContextSnapshot(pool, trace));
  return app;
}
