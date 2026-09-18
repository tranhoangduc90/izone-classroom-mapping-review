import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.RETAKE_SOURCE_ROOT || '/app';
const { createApp } = await import(pathToFileURL(path.join(sourceRoot, 'src/app.js')).href);
const { default: request } = await import(pathToFileURL(path.join(sourceRoot, 'node_modules/supertest/index.js')).href);
const { PGlite } = await import(pathToFileURL(path.join(sourceRoot, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const { renewUnstartedGrantedTermTestExamSessionSql } = await import(pathToFileURL(path.join(sourceRoot, 'src/sql.js')).href);

const secret = 'test-only-secret-that-is-longer-than-thirty-two-characters';
const studentRef = '00000000-0000-4000-8000-000000000001';
const sessionToken = '00000000-0000-4000-8000-000000000099';

function grant(version, overrides = {}) {
  const payload = Buffer.from(JSON.stringify({
    v: version,
    purpose: 'listening-retake',
    sessionToken,
    testSlug: 'term-test-1',
    classCode: 'TESTCLASS',
    studentRef,
    ...(version === 1 ? { expiresAt: Math.floor(Date.now() / 1000) + 3600 } : {}),
    ...overrides
  }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret)
    .update(`izone-listening-retake-v${version}:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function appWithPool(pool) {
  return createApp({
    config: {
      nodeEnv: 'test',
      trustProxyHops: 0,
      allowedOrigins: new Set(['https://tranhoangduc90.github.io']),
      authMode: 'legacy',
      legacyReviewToken: 'test-review-token',
      termTestSessionSecret: secret,
      deploymentProfileName: 'k67'
    },
    pool,
    termTestAssetService: { supports: slug => slug === 'term-test-1' }
  });
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

function preparedSession() {
  return {
    exam_session_token: sessionToken,
    listening_started_at: null,
    listening_deadline_at: null,
    listening_draft: {},
    listening_draft_revision: 0,
    listening_submitted_at: null,
    attempt_token: null,
    server_now: new Date().toISOString()
  };
}

async function prepare(app, retakeGrant) {
  return request(app)
    .post('/api/term-tests/term-test-1/session/prepare')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .send({ classCode: 'TESTCLASS', studentRef, retakeGrant });
}

test('vé v2 không hạn mở lại đúng phiên chưa bắt đầu đã cũ', async () => {
  const calls = [];
  const app = appWithPool({
    async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 1) return { rowCount: 1, rows: [student()] };
      if (calls.length === 2) return { rowCount: 0, rows: [] };
      if (calls.length === 3) return { rowCount: 1, rows: [preparedSession()] };
      throw new Error('Không được tạo thêm phiên hoặc nối kết quả cũ.');
    }
  });
  const response = await prepare(app, grant(2));
  assert.equal(response.status, 201);
  assert.equal(response.body.examSessionToken, sessionToken);
  assert.equal(response.body.attemptToken, null);
  assert.equal(calls.length, 3);
  assert.match(calls[2].sql, /listening_started_at IS NULL/);
  assert.match(calls[2].sql, /attempt_id IS NULL/);
});

test('vé v1 cũ còn hạn vẫn dùng được', async () => {
  let calls = 0;
  const app = appWithPool({
    async query() {
      calls += 1;
      return calls === 1
        ? { rowCount: 1, rows: [student()] }
        : { rowCount: 1, rows: [preparedSession()] };
    }
  });
  const response = await prepare(app, grant(1));
  assert.equal(response.status, 201);
  assert.equal(calls, 2);
});

test('vé sai chữ ký hoặc thiếu thông tin bị chặn trước khi truy vấn', async () => {
  let calls = 0;
  const app = appWithPool({ async query() { calls += 1; throw new Error('Không được truy vấn.'); } });
  const signed = grant(2);
  const badSignature = await prepare(app, `${signed.slice(0, -1)}x`);
  const forgedExpiry = await prepare(app, grant(2, { expiresAt: 9999999999 }));
  const wrongStudent = await prepare(app, grant(2, { studentRef: '00000000-0000-4000-8000-000000000002' }));
  const expiredLegacy = await prepare(app, grant(1, { expiresAt: Math.floor(Date.now() / 1000) - 1 }));
  for (const response of [badSignature, forgedExpiry, wrongStudent, expiredLegacy]) {
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'INVALID_RETAKE_GRANT');
  }
  assert.equal(calls, 0);
});

test('phiên đã bắt đầu không được gia hạn đồng hồ bằng vé cũ', async () => {
  const calls = [];
  const app = appWithPool({
    async query(sql) {
      calls.push(sql);
      if (calls.length === 1) return { rowCount: 1, rows: [student()] };
      return { rowCount: 0, rows: [] };
    }
  });
  const response = await prepare(app, grant(2));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'RETAKE_SESSION_UNAVAILABLE');
  assert.match(calls[2], /listening_started_at IS NULL/);
});

test('SQL chỉ hồi sinh đúng phiên chưa bắt đầu và không đặt lại phiên đã chạy', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA assessment;
      CREATE TABLE assessment.term_test_exam_session (
        id uuid PRIMARY KEY,
        test_slug text NOT NULL,
        definition_version integer NOT NULL,
        erp_course_class_id bigint NOT NULL,
        erp_student_contact_id bigint NOT NULL,
        prepared_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        superseded_at timestamptz,
        listening_started_at timestamptz,
        listening_deadline_at timestamptz,
        listening_draft jsonb NOT NULL DEFAULT '{}',
        listening_draft_revision integer NOT NULL DEFAULT 0,
        listening_submitted_at timestamptz,
        attempt_id uuid
      );
    `);
    await db.query(`
      INSERT INTO assessment.term_test_exam_session
        (id, test_slug, definition_version, erp_course_class_id, erp_student_contact_id,
         prepared_at, updated_at, superseded_at)
      VALUES ($1::uuid, 'term-test-1', 1, 2200, 9001,
              now() - interval '7 days', now() - interval '7 days', now() - interval '1 day')
    `, [sessionToken]);
    const params = [sessionToken, 'term-test-1', 1, '2200', '9001'];
    const renewed = await db.query(renewUnstartedGrantedTermTestExamSessionSql, params);
    assert.equal(renewed.rows.length, 1);
    assert.equal(renewed.rows[0].exam_session_token, sessionToken);
    const state = await db.query('SELECT superseded_at, prepared_at > now() - interval \'1 minute\' AS fresh FROM assessment.term_test_exam_session WHERE id=$1::uuid', [sessionToken]);
    assert.equal(state.rows[0].superseded_at, null);
    assert.equal(state.rows[0].fresh, true);

    await db.query('UPDATE assessment.term_test_exam_session SET listening_started_at=now(), prepared_at=now()-interval \'9 hours\', superseded_at=now() WHERE id=$1::uuid', [sessionToken]);
    const blocked = await db.query(renewUnstartedGrantedTermTestExamSessionSql, params);
    assert.equal(blocked.rows.length, 0);
  } finally {
    await db.close();
  }
});
