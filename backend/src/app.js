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
  findLatestTermTestAttemptForStudentSql,
  findStudentForTermTestSql,
  insertProtectedListeningAttemptSql,
  insertTermTestExamSessionSql,
  insertListeningAttemptSql,
  findStudentForMiniTestSql,
  listReviewsSql,
  listTermTestTeacherOptionsSql,
  listTermTestTeacherResultsSql,
  fetchTermTestTeacherWritingDetailSql,
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
import { createWritingTestService, WritingTestError } from './writing-tests.js';
import {
  buildTermTestWritingImageToken,
  decodeTermTestWritingImageDataUrl,
  TermTestWritingGradingError,
  verifyTermTestWritingImageToken
} from './term-test-writing-grading.js';

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
const writingGradingWorkerSchema = z.string().trim().regex(/^[A-Za-z0-9_.:-]{3,100}$/);
const writingGradingClaimSchema = z.object({
  workerId: writingGradingWorkerSchema,
  limit: z.number().int().min(1).max(10).optional().default(4)
});
const writingGradingImageParamsSchema = z.object({ jobId: z.string().uuid() });
const writingGradingImageQuerySchema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/i) });
const writingGradingDispatchCompleteSchema = z.object({
  jobId: z.string().uuid(),
  workerId: writingGradingWorkerSchema,
  sourceRecordId: z.string().trim().max(100).optional()
});
const writingGradingComponentSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
  label: z.string().trim().max(200).optional().default(''),
  summary: z.string().max(30_000).optional().default(''),
  feedback: z.string().max(80_000).optional().default('')
});
const writingGradingCriterionSchema = z.object({
  code: z.enum(['TA', 'TR', 'CC', 'LR', 'GRA']),
  name: z.string().trim().max(200).optional().default(''),
  bandScore: z.number().min(0).max(9).refine(value => Math.round(value * 2) === value * 2),
  feedback: z.string().max(120_000).optional().default(''),
  components: z.array(writingGradingComponentSchema).max(20).optional().default([])
});
const writingGradingResultSchema = z.object({
  jobId: z.string().uuid(),
  workerId: writingGradingWorkerSchema,
  runKey: z.string().trim().min(20).max(250),
  sourceRecordId: z.string().trim().max(100).optional(),
  result: z.object({
    taskScore: z.number().min(0).max(9).refine(value => Math.round(value * 2) === value * 2).optional(),
    criteria: z.array(writingGradingCriterionSchema).length(4),
    report: z.string().max(180_000).optional().default('')
  })
});
const writingGradingFailSchema = z.object({
  jobId: z.string().uuid(),
  workerId: writingGradingWorkerSchema,
  errorCode: z.string().trim().regex(/^[A-Z0-9_:-]{3,100}$/)
});
const teacherResultsQuerySchema = z.object({
  class: classCodeSchema,
  test: testSlugSchema
});
const teacherWritingDetailQuerySchema = teacherResultsQuerySchema.extend({
  student: z.string().uuid(),
  task: z.coerce.number().int().min(1).max(2)
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
const writingScoreSchema = z.object({
  version: z.literal(1),
  idempotencyKey: z.string().trim().min(16).max(200),
  sourceRecordId: z.string().trim().min(1).max(100),
  classroomCourseId: z.string().trim().min(1).max(100),
  classroomCourseworkId: z.string().trim().min(1).max(100),
  googleUserId: z.string().trim().min(1).max(255),
  className: z.string().trim().min(1).max(100).optional(),
  score: z.number().min(0).max(9).refine(value => Math.round(value * 2) === value * 2),
  scoredAt: z.iso.datetime()
});
const writingPortalResultSchema = z.object({
  version: z.literal(1),
  resultId: z.string().uuid(),
  expectedGrade: z.number().min(0).max(9).refine(value => Math.round(value * 2) === value * 2),
  success: z.boolean(),
  conflict: z.boolean().optional().default(false),
  larkRecordId: z.string().trim().max(100).optional(),
  errorCode: z.string().trim().max(120).optional()
});
const writingConfigItemSchema = z.object({
  testKey: z.enum([
    'course-56-term-1',
    'course-56-term-2',
    'course-56-term-2-weighted',
    'course-67-phase-1',
    'course-67-phase-2'
  ]),
  displayName: z.string().trim().min(1).max(160),
  portalTestName: z.string().trim().min(1).max(160),
  aggregationMode: z.enum(['direct', 'weighted_tasks']),
  waitMinutes: z.number().int().min(15).max(2880),
  definitionEnabled: z.boolean(),
  classroomCourseId: z.string().trim().min(1).max(100),
  classroomCourseworkId: z.string().trim().min(1).max(100),
  component: z.enum(['direct', 'task1', 'task2']),
  sourceTitle: z.string().trim().max(300).optional().default(''),
  sourceEnabled: z.boolean(),
  classId: z.string().regex(/^\d+$/).optional(),
  className: z.string().trim().max(100).optional().default(''),
  scopeEnabled: z.boolean().optional().default(false),
  larkConfigRecordId: z.string().trim().min(1).max(100)
});
const writingConfigSchema = z.object({
  version: z.literal(1),
  items: z.array(writingConfigItemSchema).min(1).max(100)
}).superRefine((value, context) => {
  const grouped = new Map();
  for (const item of value.items) {
    if (!grouped.has(item.testKey)) grouped.set(item.testKey, []);
    grouped.get(item.testKey).push(item);
  }
  for (const [testKey, items] of grouped) {
    const enabled = items.filter(item => item.sourceEnabled);
    if (!enabled.length) continue;
    const modes = new Set(items.map(item => item.aggregationMode));
    const targets = new Set(items.map(item => item.portalTestName));
    if (modes.size !== 1 || targets.size !== 1) {
      context.addIssue({ code: 'custom', path: ['items'], message: `Các dòng ${testKey} không đồng nhất.` });
      continue;
    }
    if (items[0].aggregationMode === 'weighted_tasks') {
      const components = new Set(enabled.map(item => item.component));
      if (!components.has('task1') || !components.has('task2')) {
        context.addIssue({ code: 'custom', path: ['items'], message: `Phải bật đủ Task 1 và Task 2 cho ${testKey}.` });
      }
    } else if (!enabled.some(item => item.component === 'direct')) {
      context.addIssue({ code: 'custom', path: ['items'], message: `Thiếu nguồn điểm trực tiếp cho ${testKey}.` });
    }
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

function serializeTermTestWriting(row, grading = null) {
  return {
    task1: String(row?.writing_task_1 || ''),
    task2: String(row?.writing_task_2 || ''),
    started: Boolean(row?.writing_started_at),
    submitted: Boolean(row?.writing_submitted_at),
    deadlineAt: row?.writing_deadline_at || null,
    serverNow: row?.server_now || null,
    timedOut: Boolean(row?.writing_timed_out),
    updatedAt: row?.writing_updated_at || null,
    submittedAt: row?.writing_submitted_at || null,
    grading
  };
}

async function trySyncErpGrades(syncErpGrades, attempt, combinedResult, writingScore = null) {
  const testSlug = String(attempt?.test_slug || attempt?.slug || combinedResult?.testSlug || '');
  if (!/^term-test-[1-9][0-9]*$/.test(testSlug)) return 'not_applicable';
  if (String(attempt?.class_name || '').trim().toUpperCase() === 'CODEXDEMO806') return 'not_applicable';
  try {
    const payload = buildErpGradePayload(attempt, combinedResult, { writing: writingScore });
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
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-review-token, x-mini-test-sync, x-writing-test-sync');
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
  termTestWritingGradingService = null,
  termTestAssetService = null
}) {
  const app = express();
  const writingTests = writingTestService ?? createWritingTestService({ pool });
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
  app.use(express.json({ limit: '768kb', strict: true }));

  const build = Object.freeze({
    version: config.appVersion || '1.0.0',
    sha: config.buildSha || 'unknown'
  });
  app.get('/health', (_req, res) => res.json({ ok: true, build }));

  async function ensureTermTestWritingGrading(row) {
    if (!termTestWritingGradingService || !row?.writing_submitted_at) return null;
    if (!termTestAssetService) {
      throw new TermTestWritingGradingError(
        'WRITING_GRADING_ASSETS_UNAVAILABLE',
        'Chưa thể đọc đề Writing để bắt đầu chấm.',
        503
      );
    }
    const testSlug = String(row.test_slug || 'term-test-2');
    const content = await termTestAssetService.getContent(testSlug);
    return termTestWritingGradingService.ensureSubmission({
      attemptToken: row.attempt_token,
      testSlug,
      task1: row.writing_task_1,
      task2: row.writing_task_2,
      taskDefinitions: content?.writing?.tasks || []
    });
  }
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
      const latestAttempt = await pool.query(findLatestTermTestAttemptForStudentSql, [
        slug.data,
        student.definition_version,
        student.class_id,
        student.student_id
      ]);
      const attempt = latestAttempt.rows[0] || null;
      if (attempt) {
        return res.json({
          ok: true,
          examSessionToken: attempt.exam_session_token || null,
          studentName: attempt.student_name,
          listeningStartedAt: attempt.listening_started_at || null,
          listeningDeadlineAt: attempt.listening_deadline_at || null,
          listeningSubmitted: true,
          attemptToken: attempt.attempt_token
        });
      }
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
    const grading = parsed.data.action === 'submit'
      ? await ensureTermTestWritingGrading(saved.rows[0])
      : null;
    return res.json({
      ok: true,
      attemptToken: saved.rows[0].attempt_token,
      writing: serializeTermTestWriting(saved.rows[0], grading)
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
    const grading = await ensureTermTestWritingGrading(row);
    const portalSyncStatus = await trySyncErpGrades(
      syncErpGrades,
      row,
      termTestResult,
      grading?.ready ? grading.writingScore : null
    );
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
      writing: serializeTermTestWriting(row, grading),
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

  function authenticateWritingSync(req, res) {
    if (!config.writingTestSyncSecret) {
      res.status(503).json({ ok: false, error: 'WRITING_SYNC_DISABLED', message: 'Chức năng đồng bộ Writing chưa được cấu hình.' });
      return false;
    }
    if (!hasValidSharedSecret(req.get('x-writing-test-sync'), config.writingTestSyncSecret)) {
      res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Khóa đồng bộ không hợp lệ.' });
      return false;
    }
    return true;
  }

  function requireTermTestWritingGrading(res) {
    if (termTestWritingGradingService) return true;
    res.status(503).json({
      ok: false,
      error: 'TERM_TEST_WRITING_GRADING_DISABLED',
      message: 'Chức năng chấm Writing bài thi máy chưa được bật.'
    });
    return false;
  }

  app.post('/api/term-tests/writing-grading/jobs/claim', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res) || !requireTermTestWritingGrading(res)) return;
    const parsed = writingGradingClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_GRADING_CLAIM', message: 'Yêu cầu nhận việc chấm không hợp lệ.' });
    }
    const jobs = await termTestWritingGradingService.claimJobs(parsed.data);
    if (config.termTestPublicApiBaseUrl && config.writingTestSyncSecret) {
      for (const job of jobs) {
        if (!String(job.imageUrl || '').startsWith('data:image/')) continue;
        const token = buildTermTestWritingImageToken(config.writingTestSyncSecret, job.jobId);
        job.imageUrl = `${config.termTestPublicApiBaseUrl}/api/term-tests/writing-grading/assets/${encodeURIComponent(job.jobId)}?token=${token}`;
      }
    }
    return res.json({ ok: true, jobs });
  }));

  app.get('/api/term-tests/writing-grading/assets/:jobId', testReadLimiter, asyncRoute(async (req, res) => {
    if (!config.writingTestSyncSecret || !requireTermTestWritingGrading(res)) return;
    const params = writingGradingImageParamsSchema.safeParse(req.params);
    const query = writingGradingImageQuerySchema.safeParse(req.query);
    if (!params.success || !query.success || !verifyTermTestWritingImageToken(
      config.writingTestSyncSecret,
      params.success ? params.data.jobId : '',
      query.success ? query.data.token : ''
    )) {
      return res.status(403).json({ ok: false, error: 'WRITING_GRADING_IMAGE_FORBIDDEN', message: 'Liên kết ảnh đề không hợp lệ.' });
    }
    const dataUrl = await termTestWritingGradingService.getJobImage(params.data.jobId);
    if (!dataUrl) {
      return res.status(404).json({ ok: false, error: 'WRITING_GRADING_IMAGE_NOT_FOUND', message: 'Không tìm thấy ảnh đề.' });
    }
    const image = decodeTermTestWritingImageDataUrl(dataUrl);
    res.set('Cache-Control', 'private, no-store');
    return res.type(image.mimeType).send(image.body);
  }));

  app.post('/api/term-tests/writing-grading/jobs/dispatch-complete', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res) || !requireTermTestWritingGrading(res)) return;
    const parsed = writingGradingDispatchCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_GRADING_DISPATCH', message: 'Kết quả gửi bài chấm không hợp lệ.' });
    }
    const result = await termTestWritingGradingService.completeDispatch(parsed.data);
    return res.json({ ok: true, ...result });
  }));

  app.post('/api/term-tests/writing-grading/jobs/result', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res) || !requireTermTestWritingGrading(res)) return;
    const parsed = writingGradingResultSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_GRADING_RESULT', message: 'Bài chấm Writing không đủ dữ liệu bắt buộc.' });
    }
    const result = await termTestWritingGradingService.completeResult(parsed.data);
    return res.json({ ok: true, ...result });
  }));

  app.post('/api/term-tests/writing-grading/jobs/fail', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res) || !requireTermTestWritingGrading(res)) return;
    const parsed = writingGradingFailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_GRADING_FAILURE', message: 'Thông tin lỗi chấm Writing không hợp lệ.' });
    }
    const result = await termTestWritingGradingService.failJob(parsed.data);
    return res.json({ ok: true, ...result });
  }));

  app.post('/api/writing-tests/scores', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res)) return;
    const parsed = writingScoreSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_WRITING_SCORE', message: 'Gói điểm Writing không hợp lệ.' });
    }
    const result = await writingTests.receiveScore(parsed.data);
    return res.status(result.ok ? 201 : 409).json(result);
  }));

  app.post('/api/writing-tests/process-due', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res)) return;
    const result = await writingTests.processDue();
    return res.json(result);
  }));

  app.get('/api/writing-tests/records', testReadLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res)) return;
    const records = await writingTests.listRecords();
    return res.json({ ok: true, records });
  }));

  app.post('/api/writing-tests/portal-result', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res)) return;
    const parsed = writingPortalResultSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_WRITING_PORTAL_RESULT', message: 'Kết quả ghi Portal không hợp lệ.' });
    }
    const record = await writingTests.markPortalResult(parsed.data);
    return res.json({ ok: true, record });
  }));

  app.post('/api/writing-tests/config', testWriteLimiter, asyncRoute(async (req, res) => {
    if (!authenticateWritingSync(req, res)) return;
    const parsed = writingConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_WRITING_CONFIG', message: 'Cấu hình Writing không hợp lệ.' });
    }
    const saved = await writingTests.syncConfig(parsed.data.items);
    return res.json({ ok: true, saved });
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

  app.get('/api/term-tests/teacher/writing-detail', testReadLimiter, authenticate, asyncRoute(async (req, res) => {
    const parsed = teacherWritingDetailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUERY', message: 'Yêu cầu xem bài chấm Writing không hợp lệ.' });
    }
    const result = await pool.query(fetchTermTestTeacherWritingDetailSql, [
      parsed.data.class,
      parsed.data.test,
      req.reviewer.email,
      req.reviewer.canAccessAllClasses,
      parsed.data.student,
      parsed.data.task
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
    if (!row.writing_detail) {
      return res.status(404).json({ ok: false, error: 'WRITING_DETAIL_NOT_READY', message: 'Bài chấm Writing chi tiết chưa sẵn sàng.' });
    }
    return res.json({
      ok: true,
      studentName: row.student_name,
      writing: row.writing_detail
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
    if (error instanceof WritingTestError || error instanceof TermTestWritingGradingError) {
      return res.status(error.httpStatus).json({ ok: false, error: error.code, message: error.message });
    }
    const requestId = crypto.randomUUID();
    // Chỉ log mã tra cứu và loại lỗi; không ghi token, payload hoặc dữ liệu học viên.
    console.error(`API error request_id=${requestId} type=${error?.name || 'Error'}`);
    res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Hệ thống gặp lỗi tạm thời.', requestId });
  });

  return app;
}
