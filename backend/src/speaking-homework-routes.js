import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { createSpeakingHomeworkService, SpeakingHomeworkError } from './speaking-homework.js';
import { createSpeakingDocsJobs } from './speaking-docs-jobs.js';
import { createSpeakingAlerts } from './speaking-alerts.js';

const identity = z.object({
  accessToken: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/),
  studentRef: z.string().uuid()
}).strict();
const assignmentOpen = z.object({ documentId: z.string().regex(/^[A-Za-z0-9_-]{5,120}$/),
  assignmentCode: z.string().trim().min(3).max(100),
  classCode: z.string().trim().regex(/^[A-Za-z0-9_-]{2,32}$/).optional() }).strict();
const sessionStart = assignmentOpen.omit({ classCode: true }).extend({
  studentRef: z.string().uuid(), identityConfirmed: z.literal(true)
}).strict();
const part = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const checkRequest = identity.extend({ part, url: z.string().trim().url().max(500) }).strict();
const finishRequest = identity.extend({ voiceConfirmedParts: z.array(part).max(2).default([]) }).strict();
const checkResult = z.object({
  checkJobId: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  questionCount: z.number().int().min(0).max(1000),
  qualityPassed: z.boolean(),
  typingWarning: z.object({ summary: z.string().trim().min(1).max(500),
    evidence: z.array(z.string().max(300)).max(5) }).strict().nullable().optional(),
  evidence: z.record(z.string(), z.unknown()).optional()
}).strict();
const checkFailure = z.object({ checkJobId: z.string().uuid(),
  errorCode: z.string().regex(/^[A-Z0-9_]{3,80}$/) }).strict();
const checkRejection = z.object({ checkJobId: z.string().uuid(),
  checkCode: z.enum(['SHARE_UNAVAILABLE', 'SHARE_CONTENT_INVALID']) }).strict();
const outboxComplete = z.object({ jobId: z.string().uuid(),
  externalReceipt: z.string().trim().min(1).max(500) }).strict();
const outboxClaim = z.object({ kind: z.enum(['write_doc', 'grade_speaking', 'doctor_analyze']).optional() }).strict();
const outboxFailure = z.object({ jobId: z.string().uuid(),
  errorCode: z.string().regex(/^[A-Z0-9_]{3,80}$/) }).strict();
const docsRequest = z.object({ jobId: z.string().uuid(),
  document: z.record(z.string(), z.unknown()) }).strict();
const classroomAlertScope = z.object({ courseId: z.string().regex(/^\d+$/),
  courseWorkId: z.string().regex(/^\d+$/) }).strict();
const classroomAlertScan = classroomAlertScope.extend({ snapshotComplete: z.literal(true),
  submissions: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    userId: z.string().trim().min(1).max(200),
    state: z.enum(['NEW', 'CREATED', 'TURNED_IN', 'RETURNED', 'RECLAIMED_BY_STUDENT']),
    alternateLink: z.string().max(1000).optional().default('')
  }).strict()).max(100) }).strict().superRefine((input, context) => {
  if (new Set(input.submissions.map(item => item.id)).size !== input.submissions.length) {
    context.addIssue({ code: 'custom', message: 'Danh sách Classroom trùng bài nộp.' });
  }
});
const classroomAlertAck = z.object({ batchId: z.string().uuid() }).strict();
const doctorEvent = z.object({
  sourceKey: z.string().trim().min(16).max(200),
  kind: z.enum(['recommendation', 'practice']),
  classId: z.string().regex(/^\d+$/),
  studentRef: z.string().uuid(),
  exerciseId: z.string().uuid(),
  occurredAt: z.iso.datetime()
}).strict();
const practiceRequest = identity.extend({
  slot: z.number().int().min(1).max(2), exerciseId: z.string().uuid(),
  url: z.string().trim().url().max(500)
}).strict();
const practiceResult = checkResult.extend({ matchedExerciseId: z.string().uuid() }).strict();
const voiceConfirmation = identity.extend({ linkId: z.string().uuid() }).strict();

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}
function parseOrReply(schema, body, res) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'Dữ liệu gửi lên không hợp lệ.' });
    return null;
  }
  return parsed.data;
}
function workerAuth(secret) {
  return (req, res, next) => {
    const supplied = Buffer.from(String(req.get('x-speaking-worker-secret') || ''), 'utf8');
    const expected = Buffer.from(String(secret || ''), 'utf8');
    if (!supplied.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Không có quyền xử lý bài.' });
    }
    return next();
  };
}

// API chỉ mở khi có database pool và secret riêng. Hai đường nội bộ dành cho worker n8n.
export function createSpeakingHomeworkRouter({ pool, workerSecret, accessSecret, authenticate }) {
  const router = express.Router();
  const service = createSpeakingHomeworkService({ pool, accessSecret });
  const docsJobs = createSpeakingDocsJobs({ pool });
  const alerts = createSpeakingAlerts({ pool });
  router.use(rateLimit({ windowMs: 60_000, limit: 120,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMITED', message: 'Có quá nhiều yêu cầu; vui lòng chờ.' } }));

  router.post('/assignment/open', asyncRoute(async (req, res) => {
    const input = parseOrReply(assignmentOpen, req.body, res);
    if (!input) return;
    res.json({ ok: true, assignment: await service.openAssignment(input) });
  }));
  router.post('/session/start', asyncRoute(async (req, res) => {
    const input = parseOrReply(sessionStart, req.body, res);
    if (!input) return;
    res.json({ ok: true, session: await service.startSession(input) });
  }));
  router.post('/open', asyncRoute(async (req, res) => {
    const input = parseOrReply(identity, req.body, res);
    if (!input) return;
    res.json({ ok: true, ...(await service.open(input)) });
  }));
  router.post('/checks/request', asyncRoute(async (req, res) => {
    const input = parseOrReply(checkRequest, req.body, res);
    if (!input) return;
    res.status(202).json({ ok: true, check: await service.requestCheck({
      accessToken: input.accessToken, studentRef: input.studentRef,
      part: input.part, rawUrl: input.url
    }) });
  }));
  router.post('/finish', asyncRoute(async (req, res) => {
    const input = parseOrReply(finishRequest, req.body, res);
    if (!input) return;
    res.json({ ok: true, receipt: await service.finish(input) });
  }));
  router.post('/doctor/list', asyncRoute(async (req, res) => {
    const input = parseOrReply(identity, req.body, res);
    if (!input) return;
    res.json({ ok: true, ...(await service.listDoctor(input)) });
  }));
  router.post('/doctor/practice/request', asyncRoute(async (req, res) => {
    const input = parseOrReply(practiceRequest, req.body, res);
    if (!input) return;
    res.status(202).json({ ok: true, check: await service.requestPracticeCheck({
      accessToken: input.accessToken, studentRef: input.studentRef,
      slot: input.slot, exerciseId: input.exerciseId, rawUrl: input.url
    }) });
  }));
  router.post('/doctor/practice/confirm-voice', asyncRoute(async (req, res) => {
    const input = parseOrReply(voiceConfirmation, req.body, res);
    if (!input) return;
    res.json({ ok: true, practice: await service.confirmPracticeVoice(input) });
  }));
  router.get('/teacher/receipts/:receiptId', authenticate, asyncRoute(async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.receiptId);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_RECEIPT' });
    res.json({ ok: true, receipt: await service.getTeacherReceipt({
      receiptId: parsed.data, email: req.reviewer.email,
      canAccessAllClasses: req.reviewer.canAccessAllClasses
    }) });
  }));

  router.use('/internal', workerAuth(workerSecret));
  router.post('/internal/checks/claim', asyncRoute(async (_req, res) => {
    res.json({ ok: true, job: await service.claimCheckJob() });
  }));
  router.post('/internal/checks/complete', asyncRoute(async (req, res) => {
    const input = parseOrReply(checkResult, req.body, res);
    if (!input) return;
    res.json({ ok: true, check: await service.completeCheck(input) });
  }));
  router.post('/internal/checks/fail', asyncRoute(async (req, res) => {
    const input = parseOrReply(checkFailure, req.body, res);
    if (!input) return;
    await service.failCheckJob(input);
    res.json({ ok: true });
  }));
  router.post('/internal/checks/reject', asyncRoute(async (req, res) => {
    const input = parseOrReply(checkRejection, req.body, res);
    if (!input) return;
    res.json({ ok: true, check: await service.rejectCheckJob(input) });
  }));
  router.post('/internal/practice-checks/claim', asyncRoute(async (_req, res) => {
    res.json({ ok: true, job: await service.claimPracticeCheckJob() });
  }));
  router.post('/internal/practice-checks/complete', asyncRoute(async (req, res) => {
    const input = parseOrReply(practiceResult, req.body, res);
    if (!input) return;
    res.json({ ok: true, check: await service.completePracticeCheck(input) });
  }));
  router.post('/internal/outbox/claim', asyncRoute(async (req, res) => {
    const input = parseOrReply(outboxClaim, req.body || {}, res);
    if (!input) return;
    res.json({ ok: true, job: await service.claimOutboxJob(input.kind || '') });
  }));
  router.post('/internal/outbox/complete', asyncRoute(async (req, res) => {
    const input = parseOrReply(outboxComplete, req.body, res);
    if (!input) return;
    res.json({ ok: true, job: await service.completeOutboxJob(input) });
  }));
  router.post('/internal/outbox/fail', asyncRoute(async (req, res) => {
    const input = parseOrReply(outboxFailure, req.body, res);
    if (!input) return;
    await service.failOutboxJob(input);
    res.json({ ok: true });
  }));
  router.post('/internal/docs/plan', asyncRoute(async (req, res) => {
    const input = parseOrReply(docsRequest, req.body, res);
    if (!input) return;
    res.json({ ok: true, plan: await docsJobs.plan(input) });
  }));
  router.post('/internal/docs/verify', asyncRoute(async (req, res) => {
    const input = parseOrReply(docsRequest, req.body, res);
    if (!input) return;
    res.json({ ok: true, write: await docsJobs.verifyAndComplete(input) });
  }));
  router.post('/internal/alerts/scan', asyncRoute(async (req, res) => {
    const input = parseOrReply(classroomAlertScan, req.body, res);
    if (!input) return;
    res.json({ ok: true, scan: await alerts.scan(input) });
  }));
  router.post('/internal/alerts/claim', asyncRoute(async (req, res) => {
    const input = parseOrReply(classroomAlertScope, req.body, res);
    if (!input) return;
    res.json({ ok: true, batch: await alerts.claim(input) });
  }));
  router.post('/internal/alerts/ack', asyncRoute(async (req, res) => {
    const input = parseOrReply(classroomAlertAck, req.body, res);
    if (!input) return;
    res.json({ ok: true, alert: await alerts.acknowledge(input) });
  }));
  router.post('/internal/doctor/events', asyncRoute(async (req, res) => {
    const input = parseOrReply(doctorEvent, req.body, res);
    if (!input) return;
    res.json({ ok: true, event: await service.recordDoctorEvent(input) });
  }));
  router.use((error, _req, res, next) => {
    if (!(error instanceof SpeakingHomeworkError)) return next(error);
    return res.status(error.httpStatus).json({ ok: false, error: error.code, message: error.message });
  });
  return router;
}
