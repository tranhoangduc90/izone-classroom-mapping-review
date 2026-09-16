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

test('xác nhận của giảng viên dùng attendance event, không giả làm submission', async () => {
  const overridePayload = {
    ...payload,
    schemaVersion: 'LearningPortalAttendanceOverrideJobV1',
    attendanceEventId: '55555555-5555-4555-8555-555555555555'
  };
  delete overridePayload.submissionId;
  const overrideIdentity = {
    ...identity,
    operationKey: `portal-attendance-override:${overridePayload.attendanceEventId}:v1`,
    idempotencyKey: `portal-attendance-override:${overridePayload.attendanceEventId}:enqueue:v1`
  };
  const overrideJob = { ...job, ...overrideIdentity, payload: overridePayload };
  let sent;
  const sync = createLearningAttendanceSync({
    config,
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return {
        ok: true, status: 200,
        async json() {
          return { ok: true, status: 'synced', ...overrideIdentity,
            classId: overridePayload.classId, studentId: overridePayload.studentId,
            sessionNumber: overridePayload.sessionNumber };
        }
      };
    }
  });
  assert.equal((await sync(overrideJob)).status, 'complete');
  assert.equal(sent.attendanceEventId, overridePayload.attendanceEventId);
  assert.equal(sent.submissionId, undefined);
  await assert.rejects(() => sync({ ...overrideJob, entityKey: 'student:wrong' }), LearningJobIdentityError);
});

test('mọi lớp định danh Portal sai đều dừng trước khi đánh dấu hoàn tất', async t => {
  const mutations = [
    ['studentRef trong payload', current => ({ ...current, payload: { ...current.payload, studentRef: '66666666-6666-4666-8666-666666666666' } })],
    ['assignmentId trong payload', current => ({ ...current, payload: { ...current.payload, assignmentId: '66666666-6666-4666-8666-666666666666' } })],
    ['submissionId trong payload', current => ({ ...current, payload: { ...current.payload, submissionId: '66666666-6666-4666-8666-666666666666' } })],
    ['sessionNumber trong payload', current => ({ ...current, payload: { ...current.payload, sessionNumber: 3 } })],
    ['idempotencyKey của job', current => ({ ...current, idempotencyKey: `${current.idempotencyKey}:wrong` })]
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      let calls = 0;
      const sync = createLearningAttendanceSync({ config, fetchImpl: async () => { calls += 1; return response('synced'); } });
      await assert.rejects(() => sync(mutate(job)), LearningJobIdentityError);
      assert.equal(calls, 0, 'Không được gọi Portal khi job đã sai identity.');
    });
  }
  for (const [name, override] of [
    ['classId', { classId: '9999' }], ['studentId', { studentId: '9999' }],
    ['sessionNumber', { sessionNumber: 3 }], ['entityKey', { entityKey: 'student:wrong' }],
    ['unitKey', { unitKey: 'session:wrong' }], ['operationKey', { operationKey: 'operation:wrong' }],
    ['idempotencyKey', { idempotencyKey: 'retry:wrong' }]
  ]) {
    await t.test(`phản hồi sai ${name}`, async () => {
      const sync = createLearningAttendanceSync({ config, fetchImpl: async () => response('synced', override) });
      await assert.rejects(() => sync(job), LearningJobIdentityError);
    });
  }
});

test('Portal lỗi HTTP, timeout, dữ liệu lỗi và payload không hợp lệ được phân loại rõ', async t => {
  for (const status of [429, 500, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      const sync = createLearningAttendanceSync({ config, fetchImpl: async () => ({ ok: false, status }) });
      await assert.rejects(() => sync(job), error => error.code === `PORTAL_ATTENDANCE_HTTP_${status}`);
    });
  }
  const timeout = createLearningAttendanceSync({ config, fetchImpl: async () => {
    const error = new Error('timeout'); error.name = 'TimeoutError'; throw error;
  } });
  await assert.rejects(() => timeout(job), error => error.code === 'PORTAL_ATTENDANCE_TIMEOUT');
  const invalidJson = createLearningAttendanceSync({ config, fetchImpl: async () => ({
    ok: true, status: 200, async json() { throw new SyntaxError('invalid JSON'); }
  }) });
  await assert.rejects(() => invalidJson(job), error => error.code === 'PORTAL_ATTENDANCE_INVALID_RESPONSE');
  let calls = 0;
  const invalidPayload = createLearningAttendanceSync({ config, fetchImpl: async () => { calls += 1; return response('synced'); } });
  await assert.rejects(() => invalidPayload({ ...job, payload: { ...payload, attendanceStatus: 'ABSENT' } }), LearningJobIdentityError);
  assert.equal(calls, 0);
});
