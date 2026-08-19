import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { createAuthMiddleware } from './auth.js';
import {
  completeReadingAttemptSql,
  fetchTermTestResultSql,
  findTermTestExamSessionAssetSql,
  findTermTestListeningSubmissionSql,
  findAttemptForReadingSql,
  findStudentForTermTestSql,
  insertProtectedListeningAttemptSql,
  insertTermTestExamSessionSql,
  insertListeningAttemptSql,
  findStudentForMiniTestSql,
  listReviewsSql,
  listTermTestTeacherOptionsSql,
  listTermTestTeacherResultsSql,
  listTermTestRosterSql,
  resumeTermTestExamSessionSql,
  resumeTermTestAttemptContentSql,
  saveReadingDraftSql,
  saveTermTestWritingSql,
  saveTermTestListeningDraftSql,
  startReadingAttemptSql,
  startTermTestListeningSessionSql,
  upsertMiniTestResultSql,
  writeDecisionSql
} from './sql.js';
import { buildCombinedResult, buildListeningResult, gradeSection, parseStoredTest } from './term-tests.js';
import { buildErpGradePayload } from './erp-sync.js';
import { buildMiniTestResult } from './mini-tests.js';

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
const testSlugSchema = z.string().trim().regex(/^(?:term-test-[1-9][0-9]*|mini-test-[a-z0-9-]+)$/);
const answersSchema = z.record(
  z.string().regex(/^(?:[1-9]|[1-3][0-9]|40)$/),
  z.string().max(120)
).superRefine((answers, context) => {
  if (Object.keys(answers).length > 40) {
    context.addIssue({ code: 'custom', message: 'Mỗi phần chỉ nhận tối đa 40 câu.' });
  }
});
const listeningSubmissionSchema = z.object({
  classCode: classCodeSchema,
  studentRef: z.string().uuid(),
  clientSubmissionId: z.string().uuid(),
  examSessionToken: z.string().uuid().optional(),
  answers: answersSchema
});
const readingSubmissionSchema = z.object({
  attemptToken: z.string().uuid(),
  answers: answersSchema
});
const resultRequestSchema = z.object({ attemptToken: z.string().uuid() });
const examSessionPrepareSchema = z.object({
  classCode: classCodeSchema,
  studentRef: z.string().uuid(),
  examSessionToken: z.string().uuid().optional(),
  legacyElapsedSeconds: z.number().int().min(0).max(1844).optional().default(0)
});
const examSessionStartSchema = z.object({ examSessionToken: z.string().uuid() });
const attemptResumeSchema = z.object({
  classCode: classCodeSchema,
  studentRef: z.string().uuid(),
  attemptToken: z.string().uuid()
});
const listeningDraftSchema = z.object({
  examSessionToken: z.string().uuid(),
  answers: answersSchema
});
const readingStartSchema = z.object({ attemptToken: z.string().uuid() });
const readingDraftSchema = z.object({
  attemptToken: z.string().uuid(),
  answers: answersSchema
});
const writingSubmissionSchema = z.object({
  attemptToken: z.string().uuid(),
  action: z.enum(['start', 'draft', 'submit']),
  task1: z.string().max(12_000),
  task2: z.string().max(12_000)
});
const teacherResultsQuerySchema = z.object({
  class: classCodeSchema,
  test: testSlugSchema
});
const miniTestTypeStatSchema = z.object({
  type: z.string().trim().min(1).max(160),
  correct: z.number().int().min(0).max(33),
  total: z.number().int().min(1).max(33)
}).refine(value => value.correct <= value.total, { message: 'Số câu đúng không thể lớn hơn tổng câu.' });
const miniTestSubmissionSchema = z.object({
  version: z.literal(1),
  sourceSubmissionKey: z.string().regex(/^[0-9a-f]{64}$/),
  testSlug: z.literal('mini-test-lesson-5'),
  classCode: classCodeSchema,
  studentName: z.string().trim().min(1).max(160),
  sourceSubmittedAt: z.string().trim().max(100).optional().default(''),
  scores: z.object({
    listeningCorrect: z.number().int().min(0).max(20),
    readingCorrect: z.number().int().min(0).max(13)
  }),
  typeStats: z.array(miniTestTypeStatSchema).min(1).max(20)
}).superRefine((value, context) => {
  const total = value.typeStats.reduce((sum, item) => sum + item.total, 0);
  const correct = value.typeStats.reduce((sum, item) => sum + item.correct, 0);
  if (total !== 33 || correct !== value.scores.listeningCorrect + value.scores.readingCorrect) {
    context.addIssue({ code: 'custom', path: ['typeStats'], message: 'Thống kê dạng bài không khớp điểm tổng.' });
  }
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function hasValidSharedSecret(supplied, expected) {
  const left = Buffer.from(String(supplied || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function serializeTermTestWriting(row) {
  return {
    task1: String(row?.writing_task_1 || ''),
    task2: String(row?.writing_task_2 || ''),
    started: Boolean(row?.writing_started_at),
    submitted: Boolean(row?.writing_submitted_at),
    deadlineAt: row?.writing_deadline_at || null,
    serverNow: row?.server_now || null,
    timedOut: Boolean(row?.writing_timed_out),
    updatedAt: row?.writing_updated_at || null,
    submittedAt: row?.writing_submitted_at || null
  };
}

async function trySyncErpGrades(syncErpGrades, attempt, combinedResult) {
  const testSlug = String(attempt?.test_slug || attempt?.slug || combinedResult?.testSlug || '');
  if (!/^term-test-[1-9][0-9]*$/.test(testSlug)) return 'not_applicable';
  try {
    const payload = buildErpGradePayload(attempt, combinedResult);
    await syncErpGrades(payload);
    return 'synced';
  } catch (error) {
    // Không chặn học viên xem kết quả; lần mở kết quả tiếp theo sẽ tự thử lại.
    console.error(`ERP grade sync failed type=${error?.name || 'Error'}`);
    return 'pending';
  }
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
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-review-token, x-mini-test-sync');
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

// Tạo Express app bằng dependency injection để có thể kiểm thử mà không cần database thật.
export function createApp({
  config,
  pool,
  verifyGoogleToken,
  syncErpGrades = async () => ({ status: 'disabled' }),
  writingTestService,
  termTestAssetService = null
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.use(addCors(config));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 900,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều yêu cầu; vui lòng thử lại sau.' }
  }));
  app.use(express.json({ limit: '32kb', strict: true }));

  const build = Object.freeze({
    version: config.appVersion || '1.0.0',
    sha: config.buildSha || 'unknown'
  });
  app.get('/health', (_req, res) => res.json({ ok: true, build }));
  app.get('/version', (_req, res) => res.json({ ok: true, build }));
  app.get('/ready', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, build });
  }));

  const testReadLimiter = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều yêu cầu; vui lòng thử lại sau.' }
  });
  const testWriteLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều lượt gửi; vui lòng chờ một phút.' }
  });
  const testDraftLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Bài Writing đang được lưu quá thường xuyên; vui lòng chờ một chút.' }
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

  function requireTermTestAssets(res) {
    if (termTestAssetService) return true;
    res.status(503).json({
      ok: false,
      error: 'EXAM_ASSETS_UNAVAILABLE',
      message: 'Máy chủ chưa sẵn sàng cấp đề và audio thi.'
    });
    return false;
  }

  app.post('/api/term-tests/:testSlug/session/prepare', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!requireTermTestAssets(res)) return;
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = examSessionPrepareSchema.safeParse(req.body);
    if (!slug.success || !parsed.success || slug.data !== 'term-test-2') {
      return res.status(400).json({ ok: false, error: 'INVALID_EXAM_SESSION', message: 'Yêu cầu chuẩn bị bài thi không hợp lệ.' });
    }
    const studentResult = await pool.query(findStudentForTermTestSql, [
      parsed.data.classCode,
      slug.data,
      parsed.data.studentRef
    ]);
    if (studentResult.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'STUDENT_NOT_FOUND', message: 'Không tìm thấy học viên trong lớp này.' });
    }
    const student = studentResult.rows[0];
    let session = null;
    if (parsed.data.examSessionToken) {
      const resumed = await pool.query(resumeTermTestExamSessionSql, [
        parsed.data.examSessionToken,
        slug.data,
        student.class_id,
        student.student_id
      ]);
      session = resumed.rows[0] || null;
    }
    if (!session) {
      const inserted = await pool.query(insertTermTestExamSessionSql, [
        slug.data,
        student.definition_version,
        student.class_id,
        student.class_name,
        student.student_id,
        student.student_name,
        parsed.data.legacyElapsedSeconds
      ]);
      session = inserted.rows[0];
    }
    return res.status(201).json({
      ok: true,
      examSessionToken: session.exam_session_token,
      studentName: student.student_name,
      listeningStartedAt: session.listening_started_at || null,
      listeningDeadlineAt: session.listening_deadline_at || null,
      listeningSubmitted: Boolean(session.listening_submitted_at),
      attemptToken: session.attempt_token || null,
      encryptedAudioUrl: `/api/term-tests/${slug.data}/session/${session.exam_session_token}/audio`,
      previewAudioUrl: `/api/term-tests/${slug.data}/session/${session.exam_session_token}/preview`
    });
  }));

  async function findAssetSession(req, res) {
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const token = z.string().uuid().safeParse(req.params.examSessionToken);
    if (!slug.success || !token.success || slug.data !== 'term-test-2') {
      res.status(400).json({ ok: false, error: 'INVALID_EXAM_SESSION', message: 'Phiên tải tài nguyên không hợp lệ.' });
      return null;
    }
    const result = await pool.query(findTermTestExamSessionAssetSql, [token.data, slug.data]);
    if (result.rowCount !== 1) {
      res.status(404).json({ ok: false, error: 'EXAM_SESSION_NOT_FOUND', message: 'Phiên chuẩn bị thi đã hết hạn hoặc không tồn tại.' });
      return null;
    }
    return { slug: slug.data, token: token.data, row: result.rows[0] };
  }

  app.get('/api/term-tests/:testSlug/session/:examSessionToken/audio', testReadLimiter, asyncRoute(async (req, res) => {
    if (!requireTermTestAssets(res)) return;
    const session = await findAssetSession(req, res);
    if (!session) return;
    await termTestAssetService.streamEncryptedAudio(session.slug, session.token, res);
  }));

  app.get('/api/term-tests/:testSlug/session/:examSessionToken/preview', testReadLimiter, asyncRoute(async (req, res) => {
    if (!requireTermTestAssets(res)) return;
    const session = await findAssetSession(req, res);
    if (!session) return;
    const preview = await termTestAssetService.getPreview(session.slug);
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(preview.length),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(preview);
  }));

  app.post('/api/term-tests/:testSlug/session/resume-attempt', testReadLimiter, asyncRoute(async (req, res) => {
    if (!requireTermTestAssets(res)) return;
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = attemptResumeSchema.safeParse(req.body);
    if (!slug.success || !parsed.success || slug.data !== 'term-test-2') {
      return res.status(400).json({ ok: false, error: 'INVALID_ATTEMPT_RESUME', message: 'Yêu cầu mở lại lượt thi không hợp lệ.' });
    }
    const studentResult = await pool.query(findStudentForTermTestSql, [
      parsed.data.classCode,
      slug.data,
      parsed.data.studentRef
    ]);
    if (studentResult.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'STUDENT_NOT_FOUND', message: 'Không tìm thấy học viên trong lớp này.' });
    }
    const student = studentResult.rows[0];
    const resumed = await pool.query(resumeTermTestAttemptContentSql, [
      parsed.data.attemptToken,
      slug.data,
      student.class_id,
      student.student_id
    ]);
    if (resumed.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND', message: 'Không tìm thấy lượt thi đã lưu của học viên này.' });
    }
    const attempt = resumed.rows[0];
    const content = await termTestAssetService.getContent(slug.data);
    return res.json({
      ok: true,
      attemptToken: attempt.attempt_token,
      examSessionToken: attempt.exam_session_token || null,
      studentName: attempt.student_name,
      listeningStartedAt: attempt.listening_started_at || null,
      listeningDeadlineAt: attempt.listening_deadline_at || null,
      listeningSubmitted: true,
      readingStartedAt: attempt.reading_started_at || null,
      readingDeadlineAt: attempt.reading_deadline_at || null,
      completedAt: attempt.completed_at || null,
      writingStartedAt: attempt.writing_started_at || null,
      writingDeadlineAt: attempt.writing_deadline_at || null,
      writingSubmittedAt: attempt.writing_submitted_at || null,
      serverNow: attempt.server_now,
      timing: termTestAssetService.getTiming(slug.data),
      content
    });
  }));

  app.post('/api/term-tests/:testSlug/session/start', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!requireTermTestAssets(res)) return;
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = examSessionStartSchema.safeParse(req.body);
    if (!slug.success || !parsed.success || slug.data !== 'term-test-2') {
      return res.status(400).json({ ok: false, error: 'INVALID_EXAM_SESSION', message: 'Yêu cầu bắt đầu bài thi không hợp lệ.' });
    }
    const timing = termTestAssetService.getTiming(slug.data);
    const started = await pool.query(startTermTestListeningSessionSql, [
      parsed.data.examSessionToken,
      slug.data,
      timing.listeningTotalSeconds
    ]);
    if (started.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'EXAM_SESSION_NOT_FOUND', message: 'Phiên chuẩn bị thi đã hết hạn hoặc không tồn tại.' });
    }
    const session = started.rows[0];
    const content = await termTestAssetService.getContent(slug.data);
    const audioKey = termTestAssetService.getSessionAudioKey(slug.data, parsed.data.examSessionToken);
    return res.json({
      ok: true,
      examSessionToken: session.exam_session_token,
      studentName: session.student_name,
      listeningStartedAt: session.listening_started_at,
      listeningDeadlineAt: session.listening_deadline_at,
      serverNow: session.server_now,
      listeningSubmitted: Boolean(session.listening_submitted_at),
      attemptToken: session.attempt_token || null,
      audioKey: audioKey.toString('base64'),
      audioEnvelope: { magic: 'IZTT1', ivBytes: 12, tagBytes: 16 },
      timing,
      content
    });
  }));

  app.post('/api/term-tests/:testSlug/listening/draft', testDraftLimiter, asyncRoute(async (req, res) => {
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = listeningDraftSchema.safeParse(req.body);
    if (!slug.success || !parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_LISTENING_DRAFT', message: 'Bản lưu Listening không hợp lệ.' });
    }
    const saved = await pool.query(saveTermTestListeningDraftSql, [
      parsed.data.examSessionToken,
      slug.data,
      JSON.stringify(parsed.data.answers)
    ]);
    if (saved.rowCount !== 1) {
      return res.status(409).json({ ok: false, error: 'LISTENING_LOCKED', message: 'Listening đã hết giờ hoặc đã được thu bài.' });
    }
    return res.json({
      ok: true,
      deadlineAt: saved.rows[0].listening_deadline_at,
      savedAt: saved.rows[0].listening_draft_updated_at,
      serverNow: saved.rows[0].server_now
    });
  }));

  app.post('/api/term-tests/:testSlug/listening', testWriteLimiter, asyncRoute(async (req, res) => {
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = listeningSubmissionSchema.safeParse(req.body);
    if (!slug.success || !parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_SUBMISSION', message: 'Bài Listening không hợp lệ.' });
    }
    if (parsed.data.examSessionToken) {
      await pool.query(saveTermTestListeningDraftSql, [
        parsed.data.examSessionToken,
        slug.data,
        JSON.stringify(parsed.data.answers)
      ]);
      const sessionResult = await pool.query(findTermTestListeningSubmissionSql, [
        parsed.data.examSessionToken,
        slug.data
      ]);
      if (sessionResult.rowCount !== 1) {
        return res.status(404).json({ ok: false, error: 'EXAM_SESSION_NOT_FOUND', message: 'Không tìm thấy phiên Listening đã bắt đầu.' });
      }
      const session = sessionResult.rows[0];
      const testDefinition = parseStoredTest({
        ...session,
        test_slug: session.slug,
        definition_version: session.version
      });
      const effectiveAnswers = session.listening_timed_out
        ? (session.listening_draft || {})
        : parsed.data.answers;
      const listeningResult = gradeSection(
        testDefinition.listening_definition,
        effectiveAnswers,
        testDefinition.listening_band_adjustment
      );
      const inserted = await pool.query(insertProtectedListeningAttemptSql, [
        parsed.data.clientSubmissionId,
        parsed.data.examSessionToken,
        slug.data,
        JSON.stringify(effectiveAnswers),
        JSON.stringify(listeningResult)
      ]);
      const attempt = inserted.rows[0];
      if (!attempt || attempt.exam_session_token !== parsed.data.examSessionToken) {
        return res.status(409).json({ ok: false, error: 'SUBMISSION_ID_CONFLICT', message: 'Mã gửi bài đã được dùng cho lượt làm khác.' });
      }
      const result = attempt.combined_result || buildListeningResult(testDefinition, attempt.listening_result);
      const portalSyncStatus = await trySyncErpGrades(syncErpGrades, attempt, result);
      return res.status(201).json({
        ok: true,
        attemptToken: attempt.attempt_token,
        studentName: attempt.student_name,
        completed: Boolean(attempt.completed_at),
        resultAvailable: true,
        portalSyncStatus,
        result,
        timedOut: Boolean(session.listening_timed_out),
        next: attempt.completed_at ? 'result' : 'reading'
      });
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
    // Luôn dùng kết quả đã lưu; lần gửi lại cùng mã không được phép thay đổi điểm Portal.
    const result = attempt.combined_result || buildListeningResult(testDefinition, attempt.listening_result);
    const portalSyncStatus = await trySyncErpGrades(syncErpGrades, attempt, result);
    return res.status(201).json({
      ok: true,
      attemptToken: attempt.attempt_token,
      studentName: row.student_name,
      completed: Boolean(attempt.completed_at),
      resultAvailable: true,
      portalSyncStatus,
      result,
      next: attempt.completed_at ? 'result' : 'reading'
    });
  }));

  app.post('/api/term-tests/:testSlug/reading/start', testWriteLimiter, asyncRoute(async (req, res) => {
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = readingStartSchema.safeParse(req.body);
    if (!slug.success || !parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_READING_START', message: 'Yêu cầu bắt đầu Reading không hợp lệ.' });
    }
    const started = await pool.query(startReadingAttemptSql, [parsed.data.attemptToken, slug.data]);
    if (started.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND', message: 'Không tìm thấy lượt Listening để bắt đầu Reading.' });
    }
    const row = started.rows[0];
    return res.json({
      ok: true,
      attemptToken: row.attempt_token,
      readingStartedAt: row.reading_started_at,
      readingDeadlineAt: row.reading_deadline_at,
      serverNow: row.server_now
    });
  }));

  app.post('/api/term-tests/:testSlug/reading/draft', testDraftLimiter, asyncRoute(async (req, res) => {
    const slug = testSlugSchema.safeParse(req.params.testSlug);
    const parsed = readingDraftSchema.safeParse(req.body);
    if (!slug.success || !parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_READING_DRAFT', message: 'Bản lưu Reading không hợp lệ.' });
    }
    const saved = await pool.query(saveReadingDraftSql, [
      parsed.data.attemptToken,
      JSON.stringify(parsed.data.answers)
    ]);
    if (saved.rowCount !== 1) {
      return res.status(409).json({ ok: false, error: 'READING_LOCKED', message: 'Reading đã hết giờ hoặc đã được thu bài.' });
    }
    return res.json({
      ok: true,
      deadlineAt: saved.rows[0].reading_deadline_at,
      savedAt: saved.rows[0].reading_draft_updated_at,
      serverNow: saved.rows[0].server_now
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
      const portalSyncStatus = await trySyncErpGrades(syncErpGrades, attempt, attempt.combined_result);
      return res.json({
        ok: true,
        attemptToken: attempt.attempt_token,
        completed: true,
        portalSyncStatus,
        next: 'result'
      });
    }
    const testDefinition = parseStoredTest({
      ...attempt,
      test_slug: attempt.slug,
      definition_version: attempt.version
    });
    const listeningResult = attempt.listening_result;
    const effectiveAnswers = attempt.reading_timed_out
      ? (attempt.reading_draft || {})
      : parsed.data.answers;
    const readingResult = gradeSection(testDefinition.reading_definition, effectiveAnswers, 0);
    const combinedResult = buildCombinedResult(testDefinition, listeningResult, readingResult);
    const completeResult = await pool.query(completeReadingAttemptSql, [
      parsed.data.attemptToken,
      JSON.stringify(effectiveAnswers),
      JSON.stringify(readingResult),
      JSON.stringify(combinedResult)
    ]);
    if (completeResult.rowCount !== 1) throw new Error('Không thể hoàn tất bài Reading.');
    const storedCombinedResult = completeResult.rows[0].combined_result;
    const portalSyncStatus = await trySyncErpGrades(syncErpGrades, attempt, storedCombinedResult);
    return res.json({
      ok: true,
      attemptToken: parsed.data.attemptToken,
      completed: true,
      portalSyncStatus,
      timedOut: Boolean(attempt.reading_timed_out),
      next: 'result'
    });
  }));

  app.post('/api/term-tests/writing', testDraftLimiter, asyncRoute(async (req, res) => {
    const parsed = writingSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_WRITING', message: 'Bài Writing không hợp lệ.' });
    }
    const saved = await pool.query(saveTermTestWritingSql, [
      parsed.data.attemptToken,
      parsed.data.task1,
      parsed.data.task2,
      parsed.data.action
    ]);
    if (saved.rowCount !== 1) {
      return res.status(404).json({
        ok: false,
        error: 'WRITING_ATTEMPT_NOT_FOUND',
        message: 'Chưa tìm thấy lượt Reading đã hoàn thành để lưu Writing.'
      });
    }
    return res.json({
      ok: true,
      attemptToken: saved.rows[0].attempt_token,
      writing: serializeTermTestWriting(saved.rows[0])
    });
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
    const termTestResult = row.combined_result || buildListeningResult(row, row.listening_result);
    const portalSyncStatus = await trySyncErpGrades(syncErpGrades, row, termTestResult);
    return res.json({
      ok: true,
      attemptToken: row.attempt_token,
      testSlug: row.test_slug,
      className: row.class_name,
      studentName: row.student_name,
      completed: Boolean(row.completed_at),
      completedAt: row.completed_at,
      exam: {
        examSessionToken: row.exam_session_token || null,
        readingStartedAt: row.reading_started_at || null,
        readingDeadlineAt: row.reading_deadline_at || null,
        serverNow: row.server_now || null
      },
      writing: serializeTermTestWriting(row),
      portalSyncStatus,
      result: termTestResult
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

  app.post('/api/mini-tests/results', testReadLimiter, asyncRoute(async (req, res) => {
    if (!config.miniTestSyncSecret) {
      return res.status(503).json({ ok: false, error: 'MINI_TEST_SYNC_DISABLED', message: 'Chức năng lưu Mini Test chưa được cấu hình.' });
    }
    if (!hasValidSharedSecret(req.get('x-mini-test-sync'), config.miniTestSyncSecret)) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Khóa đồng bộ không hợp lệ.' });
    }
    const parsed = miniTestSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_MINI_TEST_RESULT', message: 'Kết quả Mini Test không hợp lệ.' });
    }

    const studentResult = await pool.query(findStudentForMiniTestSql, [
      parsed.data.classCode,
      parsed.data.studentName
    ]);
    if (studentResult.rowCount !== 1) {
      return res.status(404).json({ ok: false, error: 'STUDENT_NOT_FOUND', message: 'Không tìm thấy duy nhất một học viên phù hợp trong lớp.' });
    }
    const student = studentResult.rows[0];
    const result = buildMiniTestResult({
      testSlug: parsed.data.testSlug,
      listeningCorrect: parsed.data.scores.listeningCorrect,
      readingCorrect: parsed.data.scores.readingCorrect,
      typeStats: parsed.data.typeStats
    });
    const saved = await pool.query(upsertMiniTestResultSql, [
      parsed.data.sourceSubmissionKey,
      parsed.data.testSlug,
      student.class_id,
      student.class_name,
      student.student_id,
      student.student_name,
      parsed.data.sourceSubmittedAt,
      parsed.data.scores.listeningCorrect,
      parsed.data.scores.readingCorrect,
      JSON.stringify(result)
    ]);
    if (saved.rowCount !== 1) throw new Error('Không thể lưu kết quả Mini Test.');
    return res.status(201).json({
      ok: true,
      status: 'stored',
      sourceSubmissionKey: parsed.data.sourceSubmissionKey
    });
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
