import { z } from 'zod';

const schema = z.object({
  attemptToken: z.string().uuid(),
  taskNumber: z.union([z.literal(1), z.literal(2)]),
  action: z.enum(['read', 'start', 'save']),
  outline: z.string().max(12000).optional(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
}).refine(value => value.action !== 'save' || (typeof value.outline === 'string' && value.revision), { message: 'Thiếu dàn ý hoặc phiên bản lưu.' });

// Dữ liệu vào: mã lượt thi, Task và dàn ý riêng; không nhận mốc bắt đầu do trình duyệt tự đặt.
// Máy chủ tạo mốc đầu tiên một lần, giữ nguyên khi mở lại, chặn lưu cũ/đã nộp/hết giờ.
// Dàn ý không được đưa vào essay hoặc bộ chấm; lỗi trả mã rõ ràng để giao diện giữ bản cục bộ.
export function registerTermTestPlanning(app, { pool, limiter }) {
  app.post('/api/term-tests/writing/planning', limiter, async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_WRITING_PLANNING', message: 'Dữ liệu dàn ý không hợp lệ.' });
    const input = parsed.data;
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const found = await client.query(`SELECT id, test_slug, writing_started_at, writing_deadline_at,
        writing_submitted_at, now() AS server_now
        FROM assessment.term_test_attempt
        WHERE id = $1::uuid AND superseded_at IS NULL AND completed_at IS NOT NULL
          AND test_slug IN ('term-test-1', 'term-test-2')
        FOR UPDATE`, [input.attemptToken]);
      const attempt = found.rows[0];
      if (!attempt || (attempt.test_slug === 'term-test-1' && input.taskNumber !== 2)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'WRITING_PLANNING_NOT_FOUND', message: 'Không tìm thấy Task trong lượt thi này.' });
      }
      const locked = !attempt.writing_started_at || Boolean(attempt.writing_submitted_at)
        || Date.parse(attempt.server_now) >= Date.parse(attempt.writing_deadline_at);
      if (input.action !== 'read' && locked) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'WRITING_PLANNING_LOCKED', message: 'Writing chưa bắt đầu, đã hết giờ hoặc đã nộp; không thể sửa dàn ý.' });
      }
      if (input.action === 'start') {
        await client.query(`INSERT INTO assessment.term_test_writing_planning (attempt_id, task_number, started_at, planning_deadline_at)
          VALUES ($1::uuid, $2, now(), least($3::timestamptz, now() + make_interval(mins => $4::int)))
          ON CONFLICT (attempt_id, task_number) DO NOTHING`, [input.attemptToken, input.taskNumber, attempt.writing_deadline_at, input.taskNumber === 1 ? 5 : 10]);
      }
      let accepted = true;
      if (input.action === 'save') {
        const saved = await client.query(`UPDATE assessment.term_test_writing_planning
          SET outline_text = $3, revision = $4, updated_at = now()
          WHERE attempt_id = $1::uuid AND task_number = $2 AND revision < $4
          RETURNING revision`, [input.attemptToken, input.taskNumber, input.outline, input.revision]);
        accepted = saved.rowCount === 1;
      }
      const result = await client.query(`SELECT task_number, started_at, planning_deadline_at, outline_text, revision
        FROM assessment.term_test_writing_planning WHERE attempt_id = $1::uuid AND task_number = $2`, [input.attemptToken, input.taskNumber]);
      await client.query('COMMIT');
      const row = result.rows[0];
      // Gửi lại sau khi mất phản hồi phải xác nhận bản đã lưu, không tạo xung đột giả.
      if (input.action === 'save' && row && Number(row.revision) === input.revision && row.outline_text === input.outline) accepted = true;
      return res.json({ ok: true, accepted, serverNow: attempt.server_now, locked, planning: row ? {
        taskNumber: row.task_number, startedAt: row.started_at, deadlineAt: row.planning_deadline_at,
        outline: row.outline_text, revision: Number(row.revision)
      } : null });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      next(error);
    } finally {
      client?.release();
    }
  });
}
