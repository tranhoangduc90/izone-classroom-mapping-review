import { loadAnswerExplanations, explanationSlugs } from './answer-explanations.js';
import { listTermTestTeacherResultsSql } from './sql.js';
import { z } from 'zod';

export const explanationDefinitionSql = `SELECT slug AS test_slug, version AS definition_version,
  listening_definition, reading_definition FROM assessment.test_definition WHERE slug=$1 AND version=$2;`;

// Nhận lớp, đề, mã học viên và thời điểm kết quả đang xem qua phiên giảng viên hợp lệ.
// Dùng cùng truy vấn/phân quyền và cùng lượt L/R với bảng kết quả, gồm dữ liệu Mini cũ.
// Chỉ đọc lời giải; không trả token lượt thi, không chấm lại hoặc ghi điểm.
export function mountTeacherAnswerExplanations(app, {
  pool, config, limiter, authenticate, requireContext, readAuthorization, querySchema
}) {
  const schema = querySchema.extend({ completedAt: z.string().datetime({ offset: true }).optional() });
  app.get('/api/term-tests/teacher/explanations', limiter, authenticate, requireContext, async (req, res, next) => {
    res.set('Cache-Control', 'no-store, private');
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_QUERY', message: 'Yêu cầu xem lời giải không hợp lệ.' });
    if (!explanationSlugs.has(parsed.data.test)) return res.status(404).json({ ok: false, error: 'EXPLANATIONS_UNAVAILABLE', message: 'Đề này chưa có lời giải.' });
    try {
      const { rows } = await pool.query(listTermTestTeacherResultsSql, [
        parsed.data.class, parsed.data.test, req.reviewer.email, readAuthorization(req)
      ]);
      const row = rows[0];
      if (!row || Number(row.class_count) !== 1) return res.status(404).json({ ok: false, error: 'CLASS_NOT_FOUND', message: 'Không tìm thấy duy nhất một lớp phù hợp.' });
      if (Number(row.authorized_class_count) !== 1) return res.status(403).json({ ok: false, error: 'ACCESS_DENIED', message: 'Tài khoản này chưa được cấp quyền cho lớp.' });
      const student = row.students?.find(s => s.ref === parsed.data.student);
      if (!student || student.status !== 'completed' || !student.result) return res.status(404).json({ ok: false, error: 'EXPLANATIONS_NOT_READY', message: 'Học viên chưa có kết quả hoàn chỉnh để xem lời giải.' });
      if (parsed.data.completedAt && Date.parse(parsed.data.completedAt) !== Date.parse(student.completedAt)) {
        return res.status(409).json({ ok: false, error: 'RESULT_CHANGED', message: 'Kết quả đã thay đổi. Hãy làm mới dữ liệu rồi mở lại lời giải.' });
      }
      const definition = (await pool.query(explanationDefinitionSql, [row.test_slug, row.definition_version])).rows[0];
      if (!definition) return res.status(404).json({ ok: false, error: 'EXPLANATIONS_UNAVAILABLE', message: 'Không tìm thấy phiên bản đề của kết quả này.' });
      const answers = Object.fromEntries(['listening', 'reading'].map(skill => [skill,
        Object.fromEntries((student.result[skill]?.details || []).map(d => [d.number, d.studentAnswer || '']))
      ]));
      const review = await loadAnswerExplanations(config.termTestAssetDir, {
        ...definition, combined_result: student.result,
        listening_answers: answers.listening, reading_answers: answers.reading
      });
      if (!review) return res.status(404).json({ ok: false, error: 'EXPLANATIONS_UNAVAILABLE', message: 'Lời giải chưa sẵn sàng.' });
      review.identity = { className: row.class_name, testSlug: row.test_slug, studentRef: student.ref, completedAt: student.completedAt };
      return res.json({ ok: true, review });
    } catch (error) {
      if (/^EXPLANATION_/.test(error.message)) return res.status(409).json({ ok: false, error: error.message, message: 'Lời giải chưa khớp phiên bản đề. Hãy báo quản trị viên để kiểm tra.' });
      return next(error);
    }
  });
}
