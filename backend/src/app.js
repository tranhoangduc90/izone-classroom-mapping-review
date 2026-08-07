import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { createAuthMiddleware } from './auth.js';
import {
  completeReadingAttemptSql,
  fetchTermTestResultSql,
  findAttemptForReadingSql,
  findStudentForTermTestSql,
  insertListeningAttemptSql,
  listReviewsSql,
  listTermTestTeacherOptionsSql,
  listTermTestTeacherResultsSql,
  listTermTestRosterSql,
  writeDecisionSql
} from './sql.js';
import { buildCombinedResult, gradeSection, parseStoredTest } from './term-tests.js';

const reviewQuerySchema = z.object({
  class_id: z.string().regex(/^\d+$/).optional(),
  status: z.enum(['pending_review', 'approved', 'rejected', 'superseded', 'all']).default('all')
});

const decisionSchema = z.object({
  reviewId: z.string().uuid(),
  decision: z.enum(['approve', 'reject', 'choose_another', 'edit_mapping', 'reopen']),
  classroomUserId: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().max(1000).optional().default('')
}).superRefine((value, context) => {
  if (['choose_another', 'edit_mapping'].includes(value.decision) && !value.classroomUserId) {
    context.addIssue({ code: 'custom', path: ['classroomUserId'], message: 'Cần chọn tài khoản Classroom.' });
  }
});

const classCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,32}$/);
const testSlugSchema = z.string().trim().regex(/^term-test-[1-9][0-9]*$/);
const answersSchema = z.record(
  z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/),
  z.string().max(120)
).superRefine((answers, context) => {
  if (Object.keys(answers).length > 40) {
    context.addIssue({ code: 'custom', message: 'Mỗi phần chỉ có 40 câu.' });
  }
});
const listeningSubmissionSchema = z.object({
  classCode: classCodeSchema,
  studentRef: z.string().uuid(),
  clientSubmissionId: z.string().uuid(),
  answers: answersSchema
});
const readingSubmissionSchema = z.object({
  attemptToken: z.string().uuid(),
  answers: answersSchema
});
const resultRequestSchema = z.object({ attemptToken: z.string().uuid() });
const teacherResultsQuerySchema = z.object({
  class: classCodeSchema,
  test: testSlugSchema
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function addCors(config) {
  return function corsMiddleware(req, res, next) {
    const origin = req.get('origin');
    if (origin && !config.allowedOrigins.has(origin)) {
      return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED', message: 'Nguồn truy cập không được phép.' });
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-review-token');
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

// Tạo Express app bằng dependency injection để có thể kiểm thử mà không cần database thật.
export function createApp({ config, pool, verifyGoogleToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.use(addCors(config));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều yêu cầu; vui lòng thử lại sau.' }
  }));
  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/ready', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  const testReadLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều yêu cầu; vui lòng thử lại sau.' }
  });
  const testWriteLimiter = rateLimit({
    windowMs: 60_000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều lượt gửi; vui lòng chờ một phút.' }
  });

  app.get('/api/term-tests/roster', testReadLimiter, asyncRoute(async (req, res) => {
    const parsed = z.object({ class: classCodeSchema, test: testSlugSchema }).safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUERY', message: 'Tên lớp hoặc mã bài test không hợp lệ.' });
    }
    const result = await pool.query(listTermTestRosterSql, [parsed.data.class, parsed.data.test]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: 'TEST_NOT_FOUND', message: 'Bài test chưa được mở.' });
    if (Number(row.class_count) !== 1 || !row.class_id) {
      return res.status(404).json({ ok: false, error: 'CLASS_NOT_FOUND', message: 'Không tìm thấy duy nhất một lớp phù hợp.' });
    }
    return res.json({
      ok: true,
      test: { slug: row.test_slug, title: row.test_title, version: Number(row.definition_version) },
      class: { id: row.class_id, name: row.class_name },
      students: row.students || []
    });
  }));

  app.post('/api/term-tests/:testSlug/listening', testWriteLimiter, asyncRoute(async (req, res) => {
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = listeningSubmissionSchema.safeParse(req.body);
    if (!slug.success || !parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_SUBMISSION', message: 'Bài Listening không hợp lệ.' });
    }
    const studentResult = await pool.query(findStudentForTermTestSql, [
      parsed.data.classCode,
      slug.data,
      parsed.data.studentRef
    ]);
    if (studentResult.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'STUDENT_NOT_FOUND', message: 'Không tìm thấy học viên trong lớp này.' });
    }
    const row = studentResult.rows[0];
    const testDefinition = parseStoredTest(row);
    const listeningResult = gradeSection(
      testDefinition.listening_definition,
      parsed.data.answers,
      testDefinition.listening_band_adjustment
    );
    const insertResult = await pool.query(insertListeningAttemptSql, [
      parsed.data.clientSubmissionId,
      testDefinition.test_slug,
      testDefinition.definition_version,
      row.class_id,
      row.class_name,
      row.student_id,
      row.student_name,
      JSON.stringify(parsed.data.answers),
      JSON.stringify(listeningResult)
    ]);
    const attempt = insertResult.rows[0];
    if (!attempt || attempt.class_id !== String(row.class_id) || attempt.student_id !== String(row.student_id)) {
      return res.status(409).json({ ok: false, error: 'SUBMISSION_ID_CONFLICT', message: 'Mã gửi bài đã được dùng cho lượt làm khác.' });
    }
    return res.status(201).json({
      ok: true,
      attemptToken: attempt.attempt_token,
      studentName: row.student_name,
      next: 'reading'
    });
  }));

  app.post('/api/term-tests/:testSlug/reading', testWriteLimiter, asyncRoute(async (req, res) => {
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = readingSubmissionSchema.safeParse(req.body);
    if (!slug.success || !parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_SUBMISSION', message: 'Bài Reading không hợp lệ.' });
    }
    const attemptResult = await pool.query(findAttemptForReadingSql, [parsed.data.attemptToken, slug.data]);
    if (attemptResult.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND', message: 'Không tìm thấy lượt Listening tương ứng.' });
    }
    const attempt = attemptResult.rows[0];
    if (attempt.completed_at && attempt.combined_result) {
      return res.json({ ok: true, attemptToken: attempt.attempt_token, completed: true, next: 'result' });
    }
    const testDefinition = parseStoredTest({
      ...attempt,
      test_slug: attempt.slug,
      definition_version: attempt.version
    });
    const listeningResult = attempt.listening_result;
    const readingResult = gradeSection(testDefinition.reading_definition, parsed.data.answers, 0);
    const combinedResult = buildCombinedResult(testDefinition, listeningResult, readingResult);
    const completeResult = await pool.query(completeReadingAttemptSql, [
      parsed.data.attemptToken,
      JSON.stringify(parsed.data.answers),
      JSON.stringify(readingResult),
      JSON.stringify(combinedResult)
    ]);
    if (completeResult.rowCount !== 1) throw new Error('Không thể hoàn tất bài Reading.');
    return res.json({ ok: true, attemptToken: parsed.data.attemptToken, completed: true, next: 'result' });
  }));

  app.post('/api/term-tests/result', testReadLimiter, asyncRoute(async (req, res) => {
    const parsed = resultRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_RESULT_TOKEN', message: 'Mã kết quả không hợp lệ.' });
    }
    const result = await pool.query(fetchTermTestResultSql, [parsed.data.attemptToken]);
    if (result.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'RESULT_NOT_FOUND', message: 'Kết quả chưa sẵn sàng hoặc không tồn tại.' });
    }
    const row = result.rows[0];
    return res.json({
      ok: true,
      attemptToken: row.attempt_token,
      testSlug: row.test_slug,
      className: row.class_name,
      studentName: row.student_name,
      completedAt: row.completed_at,
      result: row.combined_result
    });
  }));

  const authenticate = createAuthMiddleware({ config, pool, verifyGoogleToken });
  app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ ok: true, reviewer: req.reviewer });
  });

  app.get('/api/term-tests/teacher/options', testReadLimiter, authenticate, asyncRoute(async (req, res) => {
    const result = await pool.query(listTermTestTeacherOptionsSql, [
      req.reviewer.email,
      req.reviewer.canAccessAllClasses
    ]);
    const response = result.rows[0]?.response || { classes: [], tests: [] };
    return res.json({ ok: true, reviewer: req.reviewer, ...response });
  }));

  app.get('/api/term-tests/teacher/results', testReadLimiter, authenticate, asyncRoute(async (req, res) => {
    const parsed = teacherResultsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUERY', message: 'Tên lớp hoặc mã bài test không hợp lệ.' });
    }
    const result = await pool.query(listTermTestTeacherResultsSql, [
      parsed.data.class,
      parsed.data.test,
      req.reviewer.email,
      req.reviewer.canAccessAllClasses
    ]);
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ ok: false, error: 'TEST_NOT_FOUND', message: 'Bài test chưa được mở.' });
    }
    if (Number(row.class_count) !== 1) {
      return res.status(404).json({ ok: false, error: 'CLASS_NOT_FOUND', message: 'Không tìm thấy duy nhất một lớp phù hợp.' });
    }
    if (Number(row.authorized_class_count) !== 1) {
      return res.status(403).json({ ok: false, error: 'ACCESS_DENIED', message: 'Tài khoản Google này chưa được cấp quyền cho lớp.' });
    }
    return res.json({
      ok: true,
      reviewer: req.reviewer,
      test: { slug: row.test_slug, title: row.test_title, version: Number(row.definition_version) },
      class: { id: row.class_id, name: row.class_name },
      students: row.students || []
    });
  }));

  app.get('/api/mapping/reviews', authenticate, asyncRoute(async (req, res) => {
    const parsed = reviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUERY', message: 'Bộ lọc không hợp lệ.' });
    }

    const result = await pool.query(listReviewsSql, [
      parsed.data.class_id || null,
      parsed.data.status,
      req.reviewer.email,
      req.reviewer.canAccessAllClasses
    ]);
    const response = result.rows[0]?.response || { ok: true, items: [] };
    response.reviewer = req.reviewer;
    return res.json(response);
  }));

  app.post('/api/mapping/reviews/decision', authenticate, asyncRoute(async (req, res) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_DECISION', message: 'Dữ liệu quyết định không hợp lệ.' });
    }

    const result = await pool.query(writeDecisionSql, [
      parsed.data.reviewId,
      parsed.data.decision,
      parsed.data.classroomUserId || null,
      parsed.data.note || null,
      req.reviewer.email,
      req.reviewer.canAccessAllClasses
    ]);
    const response = result.rows[0]?.response;
    if (!response) throw new Error('Database không trả kết quả quyết định.');
    return res.status(response.ok ? 200 : 409).json(response);
  }));

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy endpoint.' });
  });

  app.use((error, _req, res, _next) => {
    const requestId = crypto.randomUUID();
    // Chỉ log mã tra cứu và loại lỗi; không ghi token, payload hoặc dữ liệu học viên.
    console.error(`API error request_id=${requestId} type=${error?.name || 'Error'}`);
    res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Hệ thống gặp lỗi tạm thời.', requestId });
  });

  return app;
}
