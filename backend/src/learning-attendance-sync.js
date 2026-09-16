import { z } from 'zod';
import { LearningJobIdentityError } from './learning-outbox.js';

const uuid = z.string().uuid();
const submissionPayloadSchema = z.object({
  schemaVersion: z.literal('LearningPortalAttendanceJobV1'),
  submissionId: uuid,
  assignmentId: uuid,
  classId: z.string().regex(/^\d+$/),
  studentId: z.string().regex(/^\d+$/),
  studentRef: uuid,
  sessionNumber: z.number().int().min(1).max(100),
  attendanceStatus: z.literal('PRESENT')
}).strict();
const overridePayloadSchema = z.object({
  schemaVersion: z.literal('LearningPortalAttendanceOverrideJobV1'),
  attendanceEventId: uuid,
  assignmentId: uuid,
  classId: z.string().regex(/^\d+$/),
  studentId: z.string().regex(/^\d+$/),
  studentRef: uuid,
  sessionNumber: z.number().int().min(1).max(100),
  attendanceStatus: z.literal('PRESENT')
}).strict();
const payloadSchema = z.union([submissionPayloadSchema, overridePayloadSchema]);

const responseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['synced', 'already_present', 'conflict']),
  entityKey: z.string().min(1),
  unitKey: z.string().min(1),
  operationKey: z.string().min(1),
  idempotencyKey: z.string().min(1),
  classId: z.string().regex(/^\d+$/),
  studentId: z.string().regex(/^\d+$/),
  sessionNumber: z.number().int().min(1).max(100)
}).strict();

function identityFor(payload) {
  if (payload.schemaVersion === 'LearningPortalAttendanceOverrideJobV1') {
    return {
      entityKey: `student:${payload.studentRef}`,
      unitKey: `portal-attendance:${payload.assignmentId}:session:${payload.sessionNumber}`,
      operationKey: `portal-attendance-override:${payload.attendanceEventId}:v1`,
      idempotencyKey: `portal-attendance-override:${payload.attendanceEventId}:enqueue:v1`
    };
  }
  return {
    entityKey: `student:${payload.studentRef}`,
    unitKey: `portal-attendance:${payload.assignmentId}:session:${payload.sessionNumber}`,
    operationKey: `portal-attendance:${payload.submissionId}:v1`,
    idempotencyKey: `portal-attendance:${payload.submissionId}:enqueue:v1`
  };
}

function assertExactIdentity(job, payload, response) {
  const expected = identityFor(payload);
  const matchesJob = Object.entries(expected).every(([key, value]) => job[key] === value);
  const matchesResponse = Object.entries(expected).every(([key, value]) => response[key] === value)
    && response.classId === payload.classId
    && response.studentId === payload.studentId
    && response.sessionNumber === payload.sessionNumber;
  if (!matchesJob || !matchesResponse) {
    throw new LearningJobIdentityError('Portal trả về identity không khớp bài nộp.');
  }
  return expected;
}

export function createLearningAttendanceSync({ config, fetchImpl = fetch }) {
  if (!config.learningAttendanceSyncUrl || !config.learningAttendanceSyncSecret) return null;

  return async function syncLearningAttendance(job) {
    let payload;
    try {
      payload = payloadSchema.parse(job.payload);
    } catch (error) {
      throw new LearningJobIdentityError(`Payload điểm danh không hợp lệ: ${error.name || 'validation'}`);
    }

    const expected = identityFor(payload);
    if (Object.entries(expected).some(([key, value]) => job[key] !== value)) {
      throw new LearningJobIdentityError('Identity của job điểm danh không khớp payload.');
    }

    let response;
    try {
      response = await fetchImpl(config.learningAttendanceSyncUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-learning-attendance-sync': config.learningAttendanceSyncSecret
        },
        body: JSON.stringify({
          ...payload,
          ...expected,
          commit: true
        }),
        signal: AbortSignal.timeout(config.learningAttendanceSyncTimeoutMs)
      });
    } catch (error) {
      const wrapped = new Error('Không gọi được luồng ghi điểm danh Portal.');
      wrapped.code = error?.name === 'TimeoutError' ? 'PORTAL_ATTENDANCE_TIMEOUT' : 'PORTAL_ATTENDANCE_NETWORK_ERROR';
      throw wrapped;
    }

    if (!response.ok) {
      const error = new Error('Luồng ghi điểm danh Portal trả lỗi HTTP.');
      error.code = `PORTAL_ATTENDANCE_HTTP_${response.status}`;
      throw error;
    }

    let output;
    try {
      output = responseSchema.parse(await response.json());
    } catch {
      const error = new Error('Phản hồi điểm danh Portal không đúng contract.');
      error.code = 'PORTAL_ATTENDANCE_INVALID_RESPONSE';
      throw error;
    }
    assertExactIdentity(job, payload, output);
    return {
      ...expected,
      status: output.status === 'conflict' ? 'review_required' : 'complete',
      portalStatus: output.status
    };
  };
}
