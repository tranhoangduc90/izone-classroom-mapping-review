import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { verifyDatabaseBoundary } from '../src/db.js';

// Dữ liệu giả và HTTP nội bộ kiểm việc K67 không mở tuyến/quyền của sản phẩm khác.
// Test này không chứng nhận grant PostgreSQL hay ghi Portal; hai việc đó có suite riêng.
function environment(overrides = {}) {
  return {
    K67_ENV: 'test', K67_PORT: '8796',
    K67_DATABASE_URL: 'postgresql://k67_app:fixture@localhost/term_mini_k67_test_boundary',
    K67_AUTH_MODE: 'legacy', K67_LEGACY_REVIEW_TOKEN: 'k67-fixture-teacher-token',
    K67_PUBLIC_API_BASE_URL: 'http://localhost:8796/term-mini-k67-api',
    K67_ASSET_DIR: '/fixture/assets', K67_SESSION_SECRET: 'a'.repeat(32),
    K67_APP_VERSION: 'k67-fixture-v1', K67_BUILD_SHA: '123456789abcdef',
    K67_MINI_SYNC_SECRET: 'm'.repeat(32), K67_WRITING_SYNC_SECRET: 'w'.repeat(32),
    K67_TRUST_PROXY_HOPS: '0', ...overrides
  };
}
function fixture(query = async () => ({ rows: [], rowCount: 0 })) {
  const config = loadConfig(environment());
  const pool = { query };
  return { config, pool, app: createApp({ config, pool }) };
}
test('K67 nhận cấu hình riêng và bỏ qua giá trị cấu hình backend chung', () => {
  const config = loadConfig(environment({ PORT: '8788', DATABASE_URL: 'postgresql://shared/mapping_db', LEARNING_ENABLED: 'true' }));
  assert.equal(config.port, 8796);
  assert.equal(config.databaseName, 'term_mini_k67_test_boundary');
  assert.equal(config.teacherSessionCookieName, 'izone_k67_teacher_session');
  assert.equal(config.teacherSessionCookiePath, '/term-mini-k67-api');
  assert.equal(config.learningEnabled, undefined);
});
test('K67 từ chối DB chung, DB K56 và role khác trước khởi động', () => {
  for (const url of ['postgresql://k67_app@localhost/mapping_db', 'postgresql://k67_app@localhost/assessment_k56', 'postgresql://mapping_app@localhost/term_mini_k67', 'postgresql://k67_app@localhost/term_mini_k67?user=postgres', 'postgresql://k67_app@localhost/term_mini_k67#other']) {
    assert.throws(() => loadConfig(environment({ K67_DATABASE_URL: url })), /database riêng/);
  }
});
test('K67 từ chối đường API chung hoặc K56', () => {
  for (const suffix of ['/mapping-api', '/mapping-api-k56']) {
    assert.throws(() => loadConfig(environment({ K67_PUBLIC_API_BASE_URL: `https://example.test${suffix}` })), /đường API riêng/);
  }
});
test('Thiếu cấu hình không làm thông báo lỗi lộ URL DB hoặc khóa', () => {
  const env = environment({ K67_DATABASE_URL: 'not-a-url-password-private', K67_SESSION_SECRET: 'private' });
  assert.throws(() => loadConfig(env), error => {
    assert.match(error.message, /K67_DATABASE_URL/);
    assert.match(error.message, /K67_SESSION_SECRET/);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});
test('Production K67 yêu cầu endpoint HTTPS, đủ khóa và DB thật riêng', () => {
  assert.throws(() => loadConfig(environment({ K67_ENV: 'production' })), /DB fixture/);
  assert.throws(() => loadConfig(environment({ K67_ENV: 'production', K67_DATABASE_URL: 'postgresql://k67_app@db/term_mini_k67' })), /HTTPS/);
});
test('Danh tính DB thực tế sai làm kiểm khởi động thất bại', async () => {
  const config = loadConfig(environment());
  await assert.rejects(verifyDatabaseBoundary({ query: async () => ({ rows: [{ database_name: 'mapping_db', role_name: 'k67_app' }] }) }, config), /Danh tính DB/);
  await assert.rejects(verifyDatabaseBoundary({ query: async () => ({ rows: [{ database_name: config.databaseName, role_name: 'mapping_admin' }] }) }, config), /Danh tính DB/);
  await verifyDatabaseBoundary({ query: async () => ({ rows: [{ database_name: config.databaseName, role_name: 'k67_app' }] }) }, config);
});
test('Health/version trả đúng build; readiness chỉ kiểm pool K67', async () => {
  const queries = [];
  const { app } = fixture(async sql => { queries.push(sql); return { rows: [{ value: 1 }] }; });
  for (const route of ['/health', '/version', '/ready']) {
    const response = await request(app).get(route).expect(200);
    assert.deepEqual(response.body.build, { version: 'k67-fixture-v1', sha: '123456789abcdef' });
  }
  assert.deepEqual(queries, ['SELECT 1']);
});
test('Speaking, Progress Log, Mapping và Writing ngoài Term không có route trong K67', async () => {
  let calls = 0;
  const { app } = fixture(async () => { calls++; throw new Error('Không được gọi DB.'); });
  for (const route of ['/api/learning/classes', '/api/speaking-homework/classes', '/api/mapping/reviews', '/api/writing-tests/tasks']) {
    const response = await request(app).get(route).expect(404);
    assert.equal(response.body.error, 'NOT_FOUND');
  }
  await request(app).post('/api/writing-tests/submissions').send({}).expect(404);
  assert.equal(calls, 0);
});
test('Khóa worker thiếu hoặc sai không được nhận công việc K67', async () => {
  let calls = 0;
  const { app } = fixture(async () => { calls++; throw new Error('Không được gọi DB.'); });
  const route = '/api/term-tests/writing-grading/jobs/claim';
  for (const key of ['', 'k56-worker-key']) {
    const response = await request(app).post(route).set('x-writing-test-sync', key).send({ workerId: 'fixture-worker' }).expect(401);
    assert.equal(response.body.error, 'UNAUTHORIZED');
  }
  assert.equal(calls, 0);
});
test('Khóa Mini sai và giáo viên chưa đăng nhập không truy cập DB', async () => {
  let calls = 0;
  const { app } = fixture(async () => { calls++; throw new Error('Không được gọi DB.'); });
  await request(app).post('/api/mini-tests/results').set('x-mini-test-sync', 'wrong-key').send({}).expect(401);
  await request(app).get('/api/term-tests/teacher/options').expect(401);
  assert.equal(calls, 0);
});
test('CORS từ chối nguồn không được cấp; không mở cookie K67 cho nguồn đó', async () => {
  const { app } = fixture();
  const response = await request(app).get('/health').set('Origin', 'https://unauthorized.test').expect(403);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});
