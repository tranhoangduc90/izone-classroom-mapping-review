import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

function makeConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    port: 8788,
    databaseUrl: 'postgresql://unused-in-tests',
    dbPoolMax: 2,
    authMode: 'legacy',
    googleClientId: '',
    legacyReviewToken: 'a-valid-test-token',
    allowedOrigins: new Set(['https://tranhoangduc90.github.io']),
    trustProxyHops: 0,
    ...overrides
  };
}

function makePool(handler = async () => ({ rowCount: 0, rows: [] })) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    }
  };
}

test('từ chối mã chuyển tiếp không đúng', async () => {
  const pool = makePool();
  const app = createApp({ config: makeConfig(), pool });

  const response = await request(app)
    .get('/api/mapping/reviews')
    .set('x-review-token', 'wrong-token');

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'UNAUTHORIZED');
  assert.equal(pool.calls.length, 0);
});

test('đọc hàng chờ bằng chế độ chuyển tiếp và truyền quyền vào SQL', async () => {
  const pool = makePool(async () => ({
    rowCount: 1,
    rows: [{ response: { ok: true, items: [{ id: 'public-review-id' }] } }]
  }));
  const app = createApp({ config: makeConfig(), pool });

  const response = await request(app)
    .get('/api/mapping/reviews?status=all')
    .set('x-review-token', 'a-valid-test-token');

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.reviewer.email, 'legacy@mapping.local');
  assert.deepEqual(pool.calls[0].params, [null, 'all', 'legacy@mapping.local', true]);
});

test('từ chối quyết định thiếu tài khoản Classroom', async () => {
  const pool = makePool();
  const app = createApp({ config: makeConfig(), pool });

  const response = await request(app)
    .post('/api/mapping/reviews/decision')
    .set('x-review-token', 'a-valid-test-token')
    .send({
      reviewId: '00000000-0000-4000-8000-000000000001',
      decision: 'choose_another'
    });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'INVALID_DECISION');
  assert.equal(pool.calls.length, 0);
});

test('ghi quyết định hợp lệ bằng UUID công khai', async () => {
  const pool = makePool(async () => ({
    rowCount: 1,
    rows: [{ response: { ok: true, reviewId: '00000000-0000-4000-8000-000000000001', status: 'approved' } }]
  }));
  const app = createApp({ config: makeConfig(), pool });

  const response = await request(app)
    .post('/api/mapping/reviews/decision')
    .set('x-review-token', 'a-valid-test-token')
    .send({
      reviewId: '00000000-0000-4000-8000-000000000001',
      decision: 'edit_mapping',
      classroomUserId: 'google-user-123',
      note: 'Giảng viên đã kiểm tra.'
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'approved');
  assert.deepEqual(pool.calls[0].params, [
    '00000000-0000-4000-8000-000000000001',
    'edit_mapping',
    'google-user-123',
    'Giảng viên đã kiểm tra.',
    'legacy@mapping.local',
    true
  ]);
});

test('Google login chỉ cho tài khoản có trong allowlist và gắn Google subject', async () => {
  const pool = makePool(async (_sql, _params, callNumber) => {
    if (callNumber === 1) {
      return {
        rowCount: 1,
        rows: [{
          email: 'teacher@gmail.com',
          display_name: 'Giảng viên A',
          role: 'teacher',
          can_access_all_classes: false
        }]
      };
    }
    return { rowCount: 1, rows: [{ response: { ok: true, items: [] } }] };
  });
  const config = makeConfig({ authMode: 'google', googleClientId: 'client-id.apps.googleusercontent.com' });
  const app = createApp({
    config,
    pool,
    verifyGoogleToken: async token => {
      assert.equal(token, 'id-token');
      return {
        sub: 'stable-google-subject',
        email: 'Teacher@Gmail.com',
        email_verified: true,
        name: 'Tên từ Google'
      };
    }
  });

  const response = await request(app)
    .get('/api/mapping/reviews?status=pending_review')
    .set('Authorization', 'Bearer id-token');

  assert.equal(response.status, 200);
  assert.equal(response.body.reviewer.email, 'teacher@gmail.com');
  assert.deepEqual(pool.calls[0].params, ['teacher@gmail.com', 'stable-google-subject']);
  assert.deepEqual(pool.calls[1].params, [null, 'pending_review', 'teacher@gmail.com', false]);
});

test('lỗi database khi xác thực được báo là lỗi hệ thống, không giả thành sai tài khoản', async () => {
  const pool = makePool(async () => {
    throw new Error('database unavailable');
  });
  const config = makeConfig({ authMode: 'google', googleClientId: 'client-id.apps.googleusercontent.com' });
  const app = createApp({
    config,
    pool,
    verifyGoogleToken: async () => ({
      sub: 'stable-google-subject',
      email: 'teacher@gmail.com',
      email_verified: true
    })
  });

  const response = await request(app)
    .get('/api/mapping/reviews')
    .set('Authorization', 'Bearer id-token');

  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'INTERNAL_ERROR');
  assert.match(response.body.requestId, /^[0-9a-f-]{36}$/);
});

test('CORS chặn origin ngoài danh sách trước khi xác thực', async () => {
  const pool = makePool();
  const app = createApp({ config: makeConfig(), pool });

  const response = await request(app)
    .get('/api/mapping/reviews')
    .set('Origin', 'https://example.invalid')
    .set('x-review-token', 'a-valid-test-token');

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'ORIGIN_NOT_ALLOWED');
  assert.equal(pool.calls.length, 0);
});
