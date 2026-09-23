import { createHash } from 'node:crypto';
import express from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { LearningError, createLearningService } from './learning-service.js';

const uuidSchema = z.string().uuid();
const publicAssignmentSchema = z.object({ publicToken: uuidSchema }).strict();
const startAttemptSchema = z.object({
  publicToken: uuidSchema,
  studentRef: uuidSchema,
  clientIdempotencyKey: uuidSchema,
  identityConfirmed: z.literal(true)
}).strict();
const draftSchema = z.object({
  attemptToken: uuidSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  responses: z.record(uuidSchema, z.union([
    z.string().max(12_000),
    z.array(z.string().max(2_000)).min(1).max(10),
    z.object({
      correct: z.number().int().min(0).max(10_000),
      total: z.number().int().min(1).max(10_000)
    }).strict()
  ]))
}).strict();
const checkpointSubmitSchema = z.object({
  attemptToken: uuidSchema,
  checkpointSubmissionId: uuidSchema,
  blockId: uuidSchema,
  checkpoint: z.number().int().min(1).max(20),
  draftRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  responses: draftSchema.shape.responses,
  idempotencyKey: z.string().trim().min(10).max(300)
}).strict();
const submitSchema = z.object({
  attemptToken: uuidSchema,
  submissionId: uuidSchema,
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  draftRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  responses: draftSchema.shape.responses
}).strict();
const resultSchema = z.object({ attemptToken: uuidSchema }).strict();
const studentJourneySchema = z.object({
  accessToken: z.string().trim().regex(/^[A-Za-z0-9_-]{32,200}$/)
}).strict();
const publishReflectionSchema = z.object({
  title: z.string().trim().min(3).max(200),
  courseCode: z.string().trim().max(80).optional().default(''),
  classId: z.string().regex(/^\d+$/),
  sessionNumber: z.number().int().min(1).max(100),
  opensAt: z.iso.datetime().nullable().optional(),
  closesAt: z.iso.datetime().nullable().optional(),
  items: z.array(z.object({
    libraryItemId: uuidSchema,
    checkpoint: z.number().int().min(1).max(3),
    required: z.boolean().default(true)
  }).strict()).min(2).max(20)
}).strict().superRefine((value, context) => {
  if (value.opensAt && value.closesAt && new Date(value.closesAt) <= new Date(value.opensAt)) {
    context.addIssue({ code: 'custom', path: ['closesAt'], message: 'Thời gian đóng phải sau thời gian mở.' });
  }
});
const publishQuizSchema = z.object({
  title: z.string().trim().min(3).max(200),
  courseCode: z.string().trim().max(80).optional().default(''),
  classId: z.string().regex(/^\d+$/),
  sessionNumber: z.number().int().min(1).max(100),
  opensAt: z.iso.datetime().nullable().optional(),
  closesAt: z.iso.datetime().nullable().optional(),
  definition: z.record(z.string(), z.unknown()),
  gradingKey: z.record(z.string(), z.unknown())
}).strict().superRefine((value, context) => {
  if (value.opensAt && value.closesAt && new Date(value.closesAt) <= new Date(value.opensAt)) {
    context.addIssue({ code: 'custom', path: ['closesAt'], message: 'Thời gian đóng phải sau thời gian mở.' });
  }
});
const dashboardQuerySchema = z.object({ assignment: uuidSchema }).strict();
const attendanceOverrideSchema = z.object({
  assignmentId: uuidSchema,
  studentRef: uuidSchema,
  status: z.enum(['teacher_confirmed', 'not_eligible', 'pending_teacher']),
  reason: z.string().trim().min(3).max(500),
  operationId: uuidSchema
}).strict();
const blockReleaseSchema = z.object({
  assignmentId: uuidSchema,
  blockId: uuidSchema,
  status: z.enum(['locked', 'open', 'closed']),
  operationId: uuidSchema
}).strict();
const reportDeliverySchema = z.object({
  reportId: uuidSchema,
  assignmentId: uuidSchema,
  studentRef: uuidSchema,
  operationId: uuidSchema
}).strict();
const teacherHumanNoteSchema = z.object({
  reportId: uuidSchema,
  assignmentId: uuidSchema,
  studentRef: uuidSchema,
  noteText: z.string().trim().min(1).max(500)
}).strict();
const studentProgressLinkSchema = z.object({
  assignmentId: uuidSchema,
  studentRef: uuidSchema,
  accessToken: z.string().trim().regex(/^[A-Za-z0-9_-]{32,200}$/),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  operationId: uuidSchema
}).strict();

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function parseOrReply(schema, value, res, errorCode) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: errorCode, message: 'Dữ liệu gửi lên không hợp lệ.' });
    return null;
  }
  return parsed.data;
}

function attemptRateKey(req) {
  const token = req.body?.attemptToken;
  return typeof token === 'string' && /^[0-9a-f-]{36}$/i.test(token)
    ? `attempt:${token}`
    : `ip:${ipKeyGenerator(req.ip)}`;
}

export function createLearningRouter({ pool, authenticate }) {
  const router = express.Router();
  const service = createLearningService({ pool });
  const coarseLimiter = rateLimit({
    windowMs: 60_000,
    limit: 12_000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(req.ip),
    message: { ok: false, error: 'RATE_LIMITED', message: 'Hệ thống đang nhận quá nhiều yêu cầu; vui lòng thử lại.' }
  });
  const startLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: req => {
      const publicToken = String(req.body?.publicToken || 'unknown');
      const studentRef = String(req.body?.studentRef || 'unknown');
      return `start:${publicToken}:${studentRef}`;
    },
    message: { ok: false, error: 'RATE_LIMITED', message: 'Bạn đã mở phiếu quá nhiều lần; hãy chờ một phút.' }
  });
  const draftLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: attemptRateKey,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Draft đang được gửi quá thường xuyên; nội dung vẫn còn trên màn hình.' }
  });
  const submitLimiter = rateLimit({
    windowMs: 60_000,
    limit: 6,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: attemptRateKey,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Phiếu đang được nộp lại quá nhiều lần; hãy chờ một chút.' }
  });
  const journeyLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: req => {
      const accessToken = String(req.body?.accessToken || '');
      if (!accessToken) return `journey-ip:${ipKeyGenerator(req.ip)}`;
      return `journey:${createHash('sha256').update(accessToken, 'utf8').digest('hex')}`;
    },
    message: { ok: false, error: 'RATE_LIMITED', message: 'Link đang được mở quá nhiều lần; hãy chờ một phút.' }
  });

  router.use(coarseLimiter);

  router.post('/assignments/open', asyncRoute(async (req, res) => {
    const input = parseOrReply(publicAssignmentSchema, req.body, res, 'INVALID_ASSIGNMENT_TOKEN');
    if (!input) return;
    const assignment = await service.getPublicAssignment(input.publicToken);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, assignment });
  }));

  router.post('/attempts/start', startLimiter, asyncRoute(async (req, res) => {
    const input = parseOrReply(startAttemptSchema, req.body, res, 'INVALID_ATTEMPT_START');
    if (!input) return;
    const attempt = await service.startAttempt(input);
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, attempt });
  }));

  router.patch('/attempts/draft', draftLimiter, asyncRoute(async (req, res) => {
    const input = parseOrReply(draftSchema, req.body, res, 'INVALID_DRAFT');
    if (!input) return;
    const draft = await service.saveDraft(input);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, draft });
  }));

  router.post('/attempts/submit', submitLimiter, asyncRoute(async (req, res) => {
    const input = parseOrReply(submitSchema, req.body, res, 'INVALID_SUBMISSION');
    if (!input) return;
    const submission = await service.submit(input);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, ...submission });
  }));

  router.post('/attempts/checkpoints/submit', submitLimiter, asyncRoute(async (req, res) => {
    const input = parseOrReply(checkpointSubmitSchema, req.body, res, 'INVALID_CHECKPOINT_SUBMISSION');
    if (!input) return;
    const checkpointSubmission = await service.submitCheckpoint(input);
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, checkpointSubmission });
  }));

  router.post('/attempts/result', submitLimiter, asyncRoute(async (req, res) => {
    const input = parseOrReply(resultSchema, req.body, res, 'INVALID_RESULT_REQUEST');
    if (!input) return;
    const result = await service.getResult(input);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, ...result });
  }));

  router.post('/student/course-journey', journeyLimiter, asyncRoute(async (req, res) => {
    const input = parseOrReply(studentJourneySchema, req.body, res, 'INVALID_PROGRESS_LINK');
    if (!input) return;
    const journey = await service.getStudentCourseJourney(input);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, journey });
  }));

  router.get('/teacher/options', authenticate, asyncRoute(async (req, res) => {
    const options = await service.listTeacherOptions({
      email: req.reviewer.email,
      canAccessAllClasses: req.reviewer.canAccessAllClasses
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, reviewer: req.reviewer, ...options });
  }));

  router.get('/teacher/question-library', authenticate, asyncRoute(async (_req, res) => {
    const items = await service.listQuestionLibrary();
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, items });
  }));

  router.post('/teacher/reflection-forms/publish', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(publishReflectionSchema, req.body, res, 'INVALID_REFLECTION_FORM');
    if (!input) return;
    const published = await service.publishReflectionForm({ ...input, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, published });
  }));

  router.post('/teacher/quiz-forms/publish', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(publishQuizSchema, req.body, res, 'INVALID_QUIZ_FORM');
    if (!input) return;
    const published = await service.publishQuizForm({ ...input, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, published });
  }));

  router.get('/teacher/dashboard', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(dashboardQuerySchema, req.query, res, 'INVALID_DASHBOARD_QUERY');
    if (!input) return;
    const dashboard = await service.getTeacherDashboard({ assignmentId: input.assignment, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, dashboard });
  }));

  router.get('/teacher/live-drafts', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(dashboardQuerySchema, req.query, res, 'INVALID_DASHBOARD_QUERY');
    if (!input) return;
    const live = await service.getTeacherLiveDrafts({ assignmentId: input.assignment, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, live });
  }));

  router.post('/teacher/attendance/override', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(attendanceOverrideSchema, req.body, res, 'INVALID_ATTENDANCE_OVERRIDE');
    if (!input) return;
    const attendance = await service.overrideAttendance({
      ...input,
      reviewer: req.reviewer,
      operationKey: `attendance-override:${input.operationId}`
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, attendance });
  }));

  router.post('/teacher/blocks/release', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(blockReleaseSchema, req.body, res, 'INVALID_BLOCK_RELEASE');
    if (!input) return;
    const blockRelease = await service.setBlockRelease({ ...input, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, blockRelease });
  }));

  router.post('/teacher/reports/delivery', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(reportDeliverySchema, req.body, res, 'INVALID_REPORT_DELIVERY');
    if (!input) return;
    const delivery = await service.markReportDelivered({ ...input, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, delivery });
  }));

  router.put('/teacher/reports/human-note', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(teacherHumanNoteSchema, req.body, res, 'INVALID_TEACHER_NOTE');
    if (!input) return;
    const note = await service.saveTeacherHumanNote({ ...input, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, note });
  }));

  router.post('/teacher/student-progress-links', authenticate, asyncRoute(async (req, res) => {
    const input = parseOrReply(studentProgressLinkSchema, req.body, res, 'INVALID_PROGRESS_LINK_REQUEST');
    if (!input) return;
    const link = await service.createStudentProgressLink({ ...input, reviewer: req.reviewer });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, link });
  }));

  router.use((error, _req, res, next) => {
    if (!(error instanceof LearningError)) return next(error);
    return res.status(error.httpStatus).json({ ok: false, error: error.code, message: error.message });
  });

  return router;
}
