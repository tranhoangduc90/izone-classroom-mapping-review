import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { createLearningRouter } from '../src/learning-routes.js';

function appWithPool(pool) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  const authenticate = (req, _res, next) => {
    req.reviewer = { email: 'teacher@example.test', canAccessAllClasses: true };
    next();
  };
  app.use('/api/learning', createLearningRouter({ pool, authenticate }));
  return app;
}

function failIfQueriedPool() {
  return {
    query() { throw new Error('Không được query khi request chưa qua validation.'); },
    async connect() { throw new Error('Không được mở transaction khi request chưa qua validation.'); }
  };
}

test('token assignment sai bị từ chối trước khi chạm database', async () => {
  const response = await request(appWithPool(failIfQueriedPool()))
    .post('/api/learning/assignments/open')
    .send({ publicToken: 'khong-phai-uuid' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_ASSIGNMENT_TOKEN');
});

test('payload draft không nhận field lạ hoặc response quá dài', async () => {
  const response = await request(appWithPool(failIfQueriedPool()))
    .patch('/api/learning/attempts/draft')
    .send({
      attemptToken: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      definitionHash: 'a'.repeat(64),
      responses: { '22222222-2222-4222-8222-222222222222': 'x'.repeat(12_001) },
      unexpected: true
    });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_DRAFT');
});

test('override điểm danh bắt buộc có lý do đủ dài', async () => {
  const response = await request(appWithPool(failIfQueriedPool()))
    .post('/api/learning/teacher/attendance/override')
    .send({
      assignmentId: '11111111-1111-4111-8111-111111111111',
      studentRef: '22222222-2222-4222-8222-222222222222',
      status: 'teacher_confirmed',
      reason: 'x',
      operationId: '33333333-3333-4333-8333-333333333333'
    });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_ATTENDANCE_OVERRIDE');
});

test('link hành trình sai định dạng bị từ chối trước khi chạm database', async () => {
  const response = await request(appWithPool(failIfQueriedPool()))
    .post('/api/learning/student/course-journey')
    .send({ accessToken: 'token-ngan' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_PROGRESS_LINK');
});

test('tạo link hành trình bắt buộc identity và token đủ mạnh', async () => {
  const response = await request(appWithPool(failIfQueriedPool()))
    .post('/api/learning/teacher/student-progress-links')
    .send({
      assignmentId: '11111111-1111-4111-8111-111111111111',
      studentRef: '22222222-2222-4222-8222-222222222222',
      accessToken: 'token-ngan',
      expiresInDays: 30,
      operationId: '33333333-3333-4333-8333-333333333333'
    });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_PROGRESS_LINK_REQUEST');
});

test('nhận xét Speaking trống hoặc quá dài bị chặn trước database', async () => {
  for (const noteText of ['', 'x'.repeat(501)]) {
    const response = await request(appWithPool(failIfQueriedPool()))
      .put('/api/learning/teacher/session-feedback')
      .send({ assignmentId: '11111111-1111-4111-8111-111111111111',
        studentRef: '22222222-2222-4222-8222-222222222222',
        noteText, expectedRevision: 0,
        operationId: '33333333-3333-4333-8333-333333333333' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'INVALID_SESSION_FEEDBACK');
  }
});

test('API từ chối payload sai ở mọi bước trước khi chạm database', async t => {
  const app = appWithPool(failIfQueriedPool());
  const uuid = '11111111-1111-4111-8111-111111111111';
  const hash = 'a'.repeat(64);
  const cases = [
    ['mở phiếu thừa field', 'post', '/assignments/open', { publicToken: uuid, studentId: 123 }, 'INVALID_ASSIGNMENT_TOKEN'],
    ['bắt đầu khi chưa xác nhận tên', 'post', '/attempts/start', { publicToken: uuid, studentRef: uuid, clientIdempotencyKey: uuid, identityConfirmed: false }, 'INVALID_ATTEMPT_START'],
    ['bắt đầu với mã retry không phải UUID', 'post', '/attempts/start', { publicToken: uuid, studentRef: uuid, clientIdempotencyKey: 'retry', identityConfirmed: true }, 'INVALID_ATTEMPT_START'],
    ['draft revision âm', 'patch', '/attempts/draft', { attemptToken: uuid, revision: -1, definitionHash: hash, responses: {} }, 'INVALID_DRAFT'],
    ['draft hash không chuẩn', 'patch', '/attempts/draft', { attemptToken: uuid, revision: 1, definitionHash: 'wrong', responses: {} }, 'INVALID_DRAFT'],
    ['draft câu trả lời sai ID', 'patch', '/attempts/draft', { attemptToken: uuid, revision: 1, definitionHash: hash, responses: { bad: 'text' } }, 'INVALID_DRAFT'],
    ['ô điền khuyết vượt 2000 ký tự', 'patch', '/attempts/draft', { attemptToken: uuid, revision: 1, definitionHash: hash, responses: { [uuid]: ['x'.repeat(2_001)] } }, 'INVALID_DRAFT'],
    ['draft điểm tự khai vượt tổng', 'patch', '/attempts/draft', { attemptToken: uuid, revision: 1, definitionHash: hash, responses: { [uuid]: { correct: 3, total: 0 } } }, 'INVALID_DRAFT'],
    ['nộp thiếu mã bài', 'post', '/attempts/submit', { attemptToken: uuid, definitionHash: hash, draftRevision: 1, responses: {} }, 'INVALID_SUBMISSION'],
    ['nộp với revision thập phân', 'post', '/attempts/submit', { attemptToken: uuid, submissionId: uuid, definitionHash: hash, draftRevision: 1.5, responses: {} }, 'INVALID_SUBMISSION'],
    ['checkpoint sai giới hạn', 'post', '/attempts/checkpoints/submit', { attemptToken: uuid, checkpointSubmissionId: uuid, blockId: uuid, checkpoint: 21, draftRevision: 0, definitionHash: hash, responses: {}, idempotencyKey: 'long-enough-key' }, 'INVALID_CHECKPOINT_SUBMISSION'],
    ['override không có operation ID', 'post', '/teacher/attendance/override', { assignmentId: uuid, studentRef: uuid, status: 'teacher_confirmed', reason: 'Có mặt', operationId: 'bad' }, 'INVALID_ATTENDANCE_OVERRIDE'],
    ['override trạng thái lạ', 'post', '/teacher/attendance/override', { assignmentId: uuid, studentRef: uuid, status: 'PRESENT', reason: 'Có mặt', operationId: uuid }, 'INVALID_ATTENDANCE_OVERRIDE'],
    ['mở phần trạng thái lạ', 'post', '/teacher/blocks/release', { assignmentId: uuid, blockId: uuid, status: 'deleted', operationId: uuid }, 'INVALID_BLOCK_RELEASE']
  ];
  for (const [name, method, path, body, expected] of cases) {
    await t.test(name, async () => {
      const response = await request(app)[method](`/api/learning${path}`).send(body);
      assert.equal(response.status, 400);
      assert.equal(response.body.error, expected);
    });
  }
});

test('nhiều học viên cùng IP không chia chung quota start/draft; một attempt vẫn bị giới hạn', async () => {
  const app = appWithPool(failIfQueriedPool());
  const hash = 'a'.repeat(64);
  for (let index = 1; index <= 21; index += 1) {
    const studentRef = `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const response = await request(app).post('/api/learning/attempts/start').send({
      publicToken: '11111111-1111-4111-8111-111111111111', studentRef,
      clientIdempotencyKey: '22222222-2222-4222-8222-222222222222', identityConfirmed: false
    });
    assert.equal(response.status, 400, `Học viên thứ ${index} bị chặn theo IP dùng chung.`);
  }
  for (let index = 1; index <= 31; index += 1) {
    const response = await request(app).patch('/api/learning/attempts/draft').send({
      attemptToken: '33333333-3333-4333-8333-333333333333', revision: -1,
      definitionHash: hash, responses: {}
    });
    assert.equal(response.status, index <= 30 ? 400 : 429);
  }
  const otherAttempt = await request(app).patch('/api/learning/attempts/draft').send({
    attemptToken: '44444444-4444-4444-8444-444444444444', revision: -1,
    definitionHash: hash, responses: {}
  });
  assert.equal(otherAttempt.status, 400);
});
