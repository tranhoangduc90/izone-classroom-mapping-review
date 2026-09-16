import assert from 'node:assert/strict';
import test from 'node:test';
import { createLearningAttendanceSync } from '../src/learning-attendance-sync.js';
import { LearningJobIdentityError } from '../src/learning-outbox.js';

const payload = {
  schemaVersion: 'LearningPortalAttendanceJobV1',
  submissionId: '11111111-1111-4111-8111-111111111111',
  assignmentId: '22222222-2222-4222-8222-222222222222',
  classId: '1294',
  studentId: '17810',
  studentRef: '33333333-3333-4333-8333-333333333333',
  sessionNumber: 2,
  attendanceStatus: 'PRESENT'
};
const identity = {
  entityKey: `student:${payload.studentRef}`,
  unitKey: `portal-attendance:${payload.assignmentId}:session:2`,
  operationKey: `portal-attendance:${payload.submissionId}:v1`,
  idempotencyKey: `portal-attendance:${payload.submissionId}:enqueue:v1`
};
const job = { id: '44444444-4444-4444-8444-444444444444', ...identity, payload };
const config = {
  learningAttendanceSyncUrl: 'https://example.test/attendance',
  learningAttendanceSyncSecret: 'x'.repeat(32),
  learningAttendanceSyncTimeoutMs: 1000
};

function response(status, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, status, ...identity, classId: '1294', studentId: '17810', sessionNumber: 2, ...overrides };
    }
  };
}

test('đồng bộ thành công gửi đúng identity và trả complete', async () => {
  let request;
  const sync = createLearningAttendanceSync({
    config,
    fetchImpl: async (_url, options) => {
      request = options;
      return response('synced');
    }
  });
  const output = await sync(job);
  assert.equal(output.status, 'complete');
  assert.equal(output.portalStatus, 'synced');
  assert.equal(request.headers['x-learning-attendance-sync'], config.learningAttendanceSyncSecret);
  assert.deepEqual(JSON.parse(request.body), { ...payload, ...identity, commit: true });
});

test('Portal đã điểm danh vẫn hoàn tất idempotent, còn xung đột cần GV xem', async () => {
  const already = createLearningAttendanceSync({ config, fetchImpl: async () => response('already_present') });
  assert.equal((await already(job)).status, 'complete');
  const conflict = createLearningAttendanceSync({ config, fetchImpl: async () => response('conflict') });
  assert.equal((await conflict(job)).status, 'review_required');
});

test('khác học viên hoặc operation bị chặn fail-closed', async () => {
  const sync = createLearningAttendanceSync({
    config,
    fetchImpl: async () => response('synced', { studentId: '99999' })
  });
  await assert.rejects(() => sync(job), LearningJobIdentityError);
  const mismatchedJob = { ...job, unitKey: `${job.unitKey}:wrong` };
  await assert.rejects(() => sync(mismatchedJob), LearningJobIdentityError);
});

test('lỗi mạng và phản hồi sai contract được đưa về mã retry an toàn', async () => {
  const network = createLearningAttendanceSync({
    config,
    fetchImpl: async () => { throw new Error('offline'); }
  });
  await assert.rejects(() => network(job), error => error.code === 'PORTAL_ATTENDANCE_NETWORK_ERROR');
  const invalid = createLearningAttendanceSync({
    config,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { ok: true }; } })
  });
  await assert.rejects(() => invalid(job), error => error.code === 'PORTAL_ATTENDANCE_INVALID_RESPONSE');
});
