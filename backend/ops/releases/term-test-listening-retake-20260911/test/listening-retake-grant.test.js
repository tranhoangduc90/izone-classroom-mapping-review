import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.RETAKE_SOURCE_ROOT || '/app';
const { createApp } = await import(pathToFileURL(path.join(sourceRoot, 'src/app.js')).href);
const { default: request } = await import(pathToFileURL(path.join(sourceRoot, 'node_modules/supertest/index.js')).href);

const origin = 'https://tranhoangduc90.github.io';
const secret = 'test-only-secret-that-is-longer-than-thirty-two-characters';
const studentRef = '00000000-0000-4000-8000-000000000001';
const sessionToken = '00000000-0000-4000-8000-000000000099';

function grant(overrides = {}) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    purpose: 'listening-retake',
    sessionToken,
    testSlug: 'term-test-1',
    classCode: 'TESTCLASS',
    studentRef,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides
  }), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`izone-listening-retake-v1:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function config() {
  return {
    nodeEnv: 'test',
    trustProxyHops: 0,
    allowedOrigins: new Set([origin]),
    authMode: 'legacy',
    legacyReviewToken: 'test-review-token',
    termTestSessionSecret: secret
  };
}

function student() {
  return {
    test_slug: 'term-test-1',
    definition_version: 1,
    class_id: '2200',
    class_name: 'TESTCLASS',
    student_id: '9001',
    student_name: 'Học viên thử nghiệm'
  };
}

test('vé hợp lệ tạo đúng phiên Listening mới và không nối kết quả Term Test cũ', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 1) return { rowCount: 1, rows: [student()] };
      if (calls.length === 2 || calls.length === 3) return { rowCount: 0, rows: [] };
      if (calls.length === 4) {
        return {
          rowCount: 1,
          rows: [{
            exam_session_token: sessionToken,
            listening_started_at: null,
            listening_deadline_at: null,
            listening_draft: {},
            listening_draft_revision: 0,
            listening_submitted_at: null,
            attempt_token: null,
            server_now: new Date().toISOString()
          }]
        };
      }
      throw new Error('Không được truy vấn thêm hoặc tìm kết quả Term Test cũ.');
    }
  };
  const app = createApp({ config: config(), pool, termTestAssetService: { supports: slug => slug === 'term-test-1' } });
  const response = await request(app)
    .post('/api/term-tests/term-test-1/session/prepare')
    .set('Origin', origin)
    .send({ classCode: 'TESTCLASS', studentRef, retakeGrant: grant() });

  assert.equal(response.status, 201);
  assert.equal(response.body.examSessionToken, sessionToken);
  assert.equal(response.body.attemptToken, null);
  assert.equal(calls.length, 4);
  assert.equal(calls.some(call => call.sql.includes('FROM assessment.term_test_attempt AS attempt')), false);
});

test('vé sai chữ ký bị chặn trước khi đọc hồ sơ học viên', async () => {
  let queries = 0;
  const app = createApp({
    config: config(),
    pool: { async query() { queries += 1; return { rowCount: 0, rows: [] }; } },
    termTestAssetService: { supports: () => true }
  });
  const token = grant();
  const response = await request(app)
    .post('/api/term-tests/term-test-1/session/prepare')
    .set('Origin', origin)
    .send({ classCode: 'TESTCLASS', studentRef, retakeGrant: `${token.slice(0, -1)}x` });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'INVALID_RETAKE_GRANT');
  assert.equal(queries, 0);
});

test('vé không đúng học viên hoặc đã hết hạn bị chặn', async () => {
  const app = createApp({
    config: config(),
    pool: { async query() { throw new Error('Không được đọc database.'); } },
    termTestAssetService: { supports: () => true }
  });
  const wrongStudent = await request(app)
    .post('/api/term-tests/term-test-1/session/prepare')
    .set('Origin', origin)
    .send({ classCode: 'TESTCLASS', studentRef, retakeGrant: grant({ studentRef: '00000000-0000-4000-8000-000000000002' }) });
  const expired = await request(app)
    .post('/api/term-tests/term-test-1/session/prepare')
    .set('Origin', origin)
    .send({ classCode: 'TESTCLASS', studentRef, retakeGrant: grant({ expiresAt: Math.floor(Date.now() / 1000) - 1 }) });

  assert.equal(wrongStudent.status, 403);
  assert.equal(expired.status, 403);
});
