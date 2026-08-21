import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { calculateWritingOverall } from '../src/writing-tests.js';

function makeConfig() {
  return {
    allowedOrigins: new Set(['https://tranhoangduc90.github.io']),
    trustProxyHops: 0,
    authMode: 'legacy',
    legacyReviewToken: 'a-valid-test-token',
    writingTestSyncSecret: 'w'.repeat(32)
  };
}

const scorePayload = {
  version: 1,
  idempotencyKey: 'writing-event-0000000001',
  sourceRecordId: 'rec-source-task-1',
  classroomCourseId: 'classroom-course-1',
  classroomCourseworkId: 'coursework-task-1',
  googleUserId: 'google-user-1',
  score: 6,
  scoredAt: '2026-08-10T03:00:00.000Z'
};

test('tính điểm Writing theo trọng số Task 1 + 2 x Task 2 và làm tròn lên 0,5', () => {
  assert.equal(calculateWritingOverall(6, 7), 7);
  assert.equal(calculateWritingOverall(6.5, 6.5), 6.5);
  assert.equal(calculateWritingOverall(5.5, 6), 6);
  assert.equal(calculateWritingOverall(6, 0), 2);
});

test('endpoint Writing từ chối khóa sai trước khi gọi dịch vụ', async () => {
  let called = false;
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    writingTestService: { receiveScore: async () => { called = true; } }
  });
  const response = await request(app)
    .post('/api/writing-tests/scores')
    .set('x-writing-test-sync', 'wrong')
    .send(scorePayload);
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test('endpoint Writing chuyển đúng gói điểm đã kiểm tra sang dịch vụ', async () => {
  let received;
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    writingTestService: {
      receiveScore: async payload => {
        received = payload;
        return { ok: true, status: 'stored', record: { status: 'waiting' } };
      }
    }
  });
  const response = await request(app)
    .post('/api/writing-tests/scores')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send(scorePayload);
  assert.equal(response.status, 201);
  assert.equal(response.body.record.status, 'waiting');
  assert.equal(received.googleUserId, 'google-user-1');
});

test('endpoint Writing từ chối điểm không theo bước 0,5', async () => {
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    writingTestService: { receiveScore: async () => ({ ok: true }) }
  });
  const response = await request(app)
    .post('/api/writing-tests/scores')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send({ ...scorePayload, score: 6.3 });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_WRITING_SCORE');
});

test('không cho bật Phase 2 khi cấu hình mới có một Task', async () => {
  let called = false;
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    writingTestService: { syncConfig: async () => { called = true; return []; } }
  });
  const item = {
    testKey: 'course-67-phase-2',
    displayName: 'Khóa 67 - Phase 2 Writing',
    portalTestName: 'Phase 2 Writing',
    aggregationMode: 'weighted_tasks',
    waitMinutes: 720,
    definitionEnabled: true,
    classroomCourseId: 'shared-writing-course',
    classroomCourseworkId: 'phase-2-task-1',
    component: 'task1',
    sourceTitle: 'Task 1',
    sourceEnabled: true,
    classId: '1187',
    className: 'IC2200',
    scopeEnabled: true,
    larkConfigRecordId: 'rec-config-task-1'
  };
  const response = await request(app)
    .post('/api/writing-tests/config')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send({ version: 1, items: [item] });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_WRITING_CONFIG');
  assert.equal(called, false);
});

test('cho phép bật Phase 2 khi cấu hình có đủ hai Task', async () => {
  let savedItems;
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    writingTestService: { syncConfig: async items => { savedItems = items; return items; } }
  });
  const common = {
    testKey: 'course-67-phase-2',
    displayName: 'Khóa 67 - Phase 2 Writing',
    portalTestName: 'Phase 2 Writing',
    aggregationMode: 'weighted_tasks',
    waitMinutes: 720,
    definitionEnabled: true,
    classroomCourseId: 'shared-writing-course',
    sourceEnabled: true,
    classId: '1187',
    className: 'IC2200',
    scopeEnabled: true
  };
  const response = await request(app)
    .post('/api/writing-tests/config')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send({ version: 1, items: [
      { ...common, classroomCourseworkId: 'phase-2-task-1', component: 'task1', sourceTitle: 'Task 1', larkConfigRecordId: 'rec-config-task-1' },
      { ...common, classroomCourseworkId: 'phase-2-task-2', component: 'task2', sourceTitle: 'Task 2', larkConfigRecordId: 'rec-config-task-2' }
    ] });
  assert.equal(response.status, 200);
  assert.equal(savedItems.length, 2);
});

test('Term Test 2 khóa 67 nhận đúng hai Task và ghi cột Phase 2 Writing', async () => {
  let savedItems;
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    writingTestService: { syncConfig: async items => { savedItems = items; return items; } }
  });
  const common = {
    testKey: 'course-67-phase-2',
    displayName: 'Khóa 67 - Phase 2 Writing',
    portalTestName: 'Phase 2 Writing',
    aggregationMode: 'weighted_tasks',
    waitMinutes: 720,
    definitionEnabled: true,
    classroomCourseId: 'classroom-course-ic2146',
    sourceEnabled: true,
    className: 'IC2146',
    scopeEnabled: true
  };
  const response = await request(app)
    .post('/api/writing-tests/config')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send({ version: 1, items: [
      {
        ...common,
        classroomCourseworkId: 'term-2-writing-task-1',
        component: 'task1',
        sourceTitle: 'Term Test 2 - Writing Task 1',
        larkConfigRecordId: 'rec-term-2-task-1'
      },
      {
        ...common,
        classroomCourseworkId: 'term-2-writing-task-2',
        component: 'task2',
        sourceTitle: 'Term Test 2 - Writing Task 2',
        larkConfigRecordId: 'rec-term-2-task-2'
      }
    ] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(savedItems.length, 2);
  assert.ok(savedItems.every(item => item.portalTestName === 'Phase 2 Writing'));
});

test('API việc chấm Term Test Writing giữ kín bằng shared secret và giới hạn số việc', async () => {
  let received = null;
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    termTestWritingGradingService: {
      claimJobs: async payload => {
        received = payload;
        return [];
      }
    }
  });
  const unauthorized = await request(app)
    .post('/api/term-tests/writing-grading/jobs/claim')
    .set('x-writing-test-sync', 'wrong')
    .send({ workerId: 'test-worker', limit: 2 });
  assert.equal(unauthorized.status, 401);
  assert.equal(received, null);

  const accepted = await request(app)
    .post('/api/term-tests/writing-grading/jobs/claim')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send({ workerId: 'test-worker', limit: 2 });
  assert.equal(accepted.status, 200);
  assert.deepEqual(received, { workerId: 'test-worker', limit: 2 });

  const tooMany = await request(app)
    .post('/api/term-tests/writing-grading/jobs/claim')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send({ workerId: 'test-worker', limit: 11 });
  assert.equal(tooMany.status, 400);
});

test('API từ chối điểm Writing không theo bước 0,5 trước khi ghi database', async () => {
  let called = false;
  const app = createApp({
    config: makeConfig(),
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    termTestWritingGradingService: {
      completeResult: async () => {
        called = true;
        return { status: 'accepted' };
      }
    }
  });
  const response = await request(app)
    .post('/api/term-tests/writing-grading/jobs/result')
    .set('x-writing-test-sync', 'w'.repeat(32))
    .send({
      jobId: '00000000-0000-4000-8000-000000000401',
      workerId: 'test-worker',
      runKey: 'term-test-2:00000000-0000-4000-8000-000000000402:task1:v1',
      result: {
        criteria: [
          { code: 'TA', bandScore: 6.3 },
          { code: 'CC', bandScore: 7 },
          { code: 'LR', bandScore: 7 },
          { code: 'GRA', bandScore: 7 }
        ]
      }
    });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_GRADING_RESULT');
  assert.equal(called, false);
});
