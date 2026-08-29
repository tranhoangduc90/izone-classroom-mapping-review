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
