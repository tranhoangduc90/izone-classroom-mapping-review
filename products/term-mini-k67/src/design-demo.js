// Demo riêng trong sản phẩm K67: chỉ đọc đề/bài chấm và chấm thử L/R trong bộ nhớ.
// Demo mở trực tiếp, giới hạn IC2200 và ba bài K67; không nhận token bài thi và không ghi bảng assessment.
import { z } from 'zod';
import { demoSourceSql } from './design-demo-sql.js';
import { parseStoredTest, gradeSection, buildCombinedResult } from './term-tests.js';

const querySchema = z.object({ class: z.literal('IC2200'), test: z.enum(['term-test-1','term-test-2','mini-test-lesson-5']), attempt: z.uuid().optional() });
const answers = z.record(z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/), z.string().max(120));
const gradeSchema = z.object({ definitionVersion: z.number().int().positive(), listening: answers, reading: answers });

export function mountDesignDemo(app, { pool, requireContext, limiter, assets }) {
  const base = '/api/term-tests/teacher/design-demo';
  app.use(base, (_req, res, next) => { res.set('Cache-Control', 'no-store, private'); next(); }, limiter);
  app.use(base, requireContext);
  const route = (path, handler, method = 'get') => app[method](base + path, async (req, res, next) => {
    try {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_DEMO_SCOPE' });
      const q = parsed.data;
      const { rows } = await pool.query(demoSourceSql, [q.class, q.test, q.attempt || null]);
      const row = rows[0];
      if (!row || row.class_count !== 1) return res.status(404).json({ ok: false, error: 'DEMO_NOT_FOUND' });
      if (row.authorized_class_count !== 1) return res.status(403).json({ ok: false, error: 'ACCESS_DENIED' });
      // Bài đã lưu phải khớp phiên bản đề đang phục vụ; khác phiên bản thì báo rõ.
      if (row.snapshot && Number(row.snapshot.definitionVersion) !== Number(row.definition_version)) return res.status(409).json({ ok: false, error: 'DEFINITION_VERSION_MISMATCH' });
      await handler(req, res, row);
    } catch (error) { next(error); }
  });
  route('/attempts', async (_req, res, row) => res.json({ ok: true, attempts: row.attempts }));
  route('/content', async (req, res, row) => {
    if (!assets) return res.status(503).json({ ok: false, error: 'ASSETS_UNAVAILABLE' });
    res.json({ ok: true, definitionVersion: Number(row.definition_version), content: await assets.getContent(req.query.test), timing: assets.getTiming(req.query.test) });
  });
  route('/snapshot', async (req, res, row) => {
    if (!row.snapshot) return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND' });
    const s = row.snapshot;
    const expected=req.query.test==='term-test-2'?[1,2]:req.query.test==='term-test-1'?[2]:[];
    if (s.grading?.ready && ((!Array.isArray(s.grading.tasks) || s.grading.tasks.length !== expected.length) || !expected.every(n=>s.grading.tasks.some(t=>Number(t.taskNumber)===n)))) return res.status(409).json({ ok: false, error: 'GRADING_LINEAGE_MISMATCH' });
    res.json({ ok: true, snapshot: s });
  });
  route('/audio', async (req, res) => {
    if (!assets?.streamDemoAudio) return res.status(503).json({ ok: false, error: 'ASSETS_UNAVAILABLE' });
    await assets.streamDemoAudio(req.query.test, req, res);
  });
  route('/grade', async (req, res, row) => {
    const parsed = gradeSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.definitionVersion!==Number(row.definition_version)) return res.status(400).json({ ok: false, error: 'INVALID_TRIAL_ANSWERS' });
    const test = parseStoredTest(row), body = parsed.data;
    const listening = gradeSection(test.listening_definition, body.listening, test.listening_band_adjustment);
    const reading = gradeSection(test.reading_definition, body.reading);
    res.json({ ok: true, trial: true, result: buildCombinedResult(test, listening, reading) });
  }, 'post');
}
