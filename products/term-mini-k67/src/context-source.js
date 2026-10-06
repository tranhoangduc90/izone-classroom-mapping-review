import crypto from 'node:crypto';
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
export async function readContextSnapshot(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    const captured = (await client.query('SELECT transaction_timestamp() AS captured')).rows[0].captured;
    const payload = { apiVersion: 1, productId: 'PRODUCT-TERM-MINI-K67' };
    for (const [field, sql] of reads) payload[field] = (await client.query(sql)).rows;
    const snapshot = createContextSnapshot(payload, new Date(captured).getTime());
    if (Buffer.byteLength(JSON.stringify(snapshot)) > CONTEXT_MAX_BYTES) throw new Error('CONTEXT_TOO_LARGE');
    await client.query('COMMIT');
    return snapshot;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export function createContextSourceApp({ pool, secret }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('CONTEXT_SECRET_REQUIRED');
  const expected = Buffer.from(secret);
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, product: 'K67-context-v1' }));
  app.get('/v1/snapshot', async (req, res) => {
    const supplied = Buffer.from(req.get('x-k67-context-key') || '');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    res.set('Cache-Control', 'no-store');
    try { return res.json(await readContextSnapshot(pool)); }
    catch { return res.status(503).json({ ok: false, error: 'CONTEXT_SOURCE_UNAVAILABLE' }); }
  });
  return app;
}
