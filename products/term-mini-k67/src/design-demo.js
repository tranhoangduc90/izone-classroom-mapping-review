// Demo riêng trong sản phẩm K67: chỉ đọc đề/bài chấm và chấm thử L/R trong bộ nhớ.
// Mọi route đều kiểm phiên và quyền lớp; không nhận token bài thi và không ghi bảng assessment.
import { z } from 'zod';
import { demoSourceSql } from './design-demo-sql.js';
import { parseStoredTest, gradeSection, buildCombinedResult } from './term-tests.js';

const querySchema = z.object({ class: z.literal('IC2200'), test: z.literal('term-test-2'), attempt: z.uuid().optional() });
const answers = z.record(z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/), z.string().max(120));
const gradeSchema = z.object({ definitionVersion: z.literal(1), listening: answers, reading: answers });

export function mountDesignDemo(app, { pool, auth, requireContext, limiter, assets }) {
  const base = '/api/term-tests/teacher/design-demo';
  app.use(base, (_req, res, next) => { res.set('Cache-Control', 'no-store, private'); next(); }, limiter, auth.authenticate, requireContext);
  const route = (path, handler, method = 'get') => app[method](base + path, async (req, res, next) => {
    try {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_DEMO_SCOPE' });
      const q = parsed.data;
      const { rows } = await pool.query(demoSourceSql, [q.class, q.test, req.reviewer.email, auth.readAuthorization(req), q.attempt || null]);
      const row = rows[0];
      if (!row || row.class_count !== 1) return res.status(404).json({ ok: false, error: 'DEMO_NOT_FOUND' });
      if (row.authorized_class_count !== 1) return res.status(403).json({ ok: false, error: 'ACCESS_DENIED' });
      // Pilot này ghim bộ đề phiên bản 1; không dùng đề hiện tại để hiển thị bài phiên bản khác.
      if (Number(row.definition_version) !== 1 || (row.snapshot && row.snapshot.definitionVersion !== 1)) return res.status(409).json({ ok: false, error: 'DEFINITION_VERSION_MISMATCH' });
      await handler(req, res, row);
    } catch (error) { next(error); }
  });
  route('/attempts', async (_req, res, row) => res.json({ ok: true, attempts: row.attempts }));
  route('/content', async (_req, res) => {
    if (!assets) return res.status(503).json({ ok: false, error: 'ASSETS_UNAVAILABLE' });
    res.json({ ok: true, definitionVersion: 1, content: await assets.getContent('term-test-2'), timing: assets.getTiming('term-test-2') });
  });
  route('/snapshot', async (_req, res, row) => {
    if (!row.snapshot) return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND' });
    const s = row.snapshot;
    if (s.grading?.ready && s.grading.tasks.length !== 2) return res.status(409).json({ ok: false, error: 'GRADING_LINEAGE_MISMATCH' });
    res.json({ ok: true, snapshot: s });
  });
  route('/audio', async (req, res) => {
    if (!assets?.streamDemoAudio) return res.status(503).json({ ok: false, error: 'ASSETS_UNAVAILABLE' });
    await assets.streamDemoAudio('term-test-2', req, res);
  });
  route('/grade', async (req, res, row) => {
    const parsed = gradeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_TRIAL_ANSWERS' });
    const test = parseStoredTest(row), body = parsed.data;
    const listening = gradeSection(test.listening_definition, body.listening, test.listening_band_adjustment);
    const reading = gradeSection(test.reading_definition, body.reading);
    res.json({ ok: true, trial: true, result: buildCombinedResult(test, listening, reading) });
  }, 'post');
}
