import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { createContextSnapshot } from '../src/context-contract.js';
import { applyContextSnapshot, fetchContextSnapshot } from '../src/context-sync.js';
import { createContextSourceApp } from '../src/context-source.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { insertTermTestExamSessionSql, startTermTestListeningSessionSql,
  listTermTestTeacherResultsSql, fetchTermTestTeacherWritingDetailSql, fetchTermTestTeacherAttemptReviewSql } from '../src/sql.js';

// Chỉ nhận PostgreSQL fixture có marker. Google được mô phỏng, còn SQL/quyền/cookie/HTTP là thật.
function checkedUrl(field, role) {
  assert.equal(process.env.K67_TEST_FIXTURE_CONFIRMATION, 'synthetic-fixture-20261006');
  const url = new URL(process.env[field]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/term_mini_k67_test_database');
  assert.equal(url.username, role);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  return url.href;
}
const appPool = new pg.Pool({ connectionString: checkedUrl('K67_TEST_DATABASE_URL', 'k67_app'), max: 3 });
const ownerPool = new pg.Pool({ connectionString: checkedUrl('K67_TEST_OWNER_URL', 'k67_owner'), max: 3 });
const contextPool = new pg.Pool({ connectionString: checkedUrl('K67_TEST_CONTEXT_URL', 'k67_context_sync'), max: 2,
  application_name: 'k67-fixture-context-revocation' });
const teacher = 'k67-context-fixture@example.test';
const studentRef = crypto.randomUUID();
const studentId = 9870676301 + crypto.randomInt(1, 10000000);
let clock = Date.now();
let confirmed = false;
function snapshot(change = {}) {
  clock = Math.max(clock + 1, Date.now());
  return createContextSnapshot({ apiVersion: 1, productId: 'PRODUCT-TERM-MINI-K67',
    classes: [{ erp_course_class_id: '1124', erp_class_name_snapshot: 'K67SIM_CTXA' },
      { erp_course_class_id: '1131', erp_class_name_snapshot: 'K67SIM_CTXB' }],
    students: [{ public_id: studentRef, erp_course_class_id: '1124', erp_student_contact_id: String(studentId),
      erp_student_name_snapshot: 'Học viên mô phỏng ngữ cảnh', status: 'approved' }],
    memberships: [],
    accounts: [{ email: teacher, google_subject: null, display_name: 'Giáo viên mô phỏng ngữ cảnh',
      role: 'teacher', status: 'active', can_access_all_classes: false }],
    access: [{ reviewer_email: teacher, erp_course_class_id: '1124' }], ...change }, clock);
}
const config = loadConfig({ K67_ENV: 'test', K67_DATABASE_URL: process.env.K67_TEST_DATABASE_URL,
  K67_AUTH_MODE: 'google', K67_GOOGLE_CLIENT_ID: 'fixture-client',
  K67_ALLOWED_ORIGINS: 'https://fixture.example.test', K67_TRUST_PROXY_HOPS: 0,
  K67_PUBLIC_API_BASE_URL: 'http://localhost/term-mini-k67-api', K67_ASSET_DIR: '/fixture',
  K67_SESSION_SECRET: 's'.repeat(32), K67_APP_VERSION: 'fixture', K67_BUILD_SHA: '1234567' });
const verify = async () => ({ email: teacher, sub: 'k67-fixture-google-subject', email_verified: true });
const app = createApp({ config, pool: appPool, verifyGoogleToken: verify, logger: { info() {}, error() {} } });
async function login() {
  const response = await request(app).post('/api/auth/session').send({ credential: 'k67-synthetic-google-token-only' }).expect(201);
  assert.match(response.headers['set-cookie'][0], /Path=\/term-mini-k67-api/);
  assert.match(response.headers['set-cookie'][0], /HttpOnly/);
  return response.headers['set-cookie'][0].split(';')[0];
}
before(async () => {
  assert.deepEqual((await appPool.query('SELECT * FROM mapping.k67_fixture_identity')).rows,
    [{ product_id: 'PRODUCT-TERM-MINI-K67', fixture_id: 'synthetic-fixture-20261006' }]);
  confirmed = true;
  await applyContextSnapshot(contextPool, snapshot());
  await ownerPool.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES ('term-test-1','Đề mô phỏng K67',1,'{}','{}',true) ON CONFLICT DO NOTHING`);
});
after(async () => {
  try {
    if (confirmed) {
      await ownerPool.query('ALTER TABLE mapping.classroom_course_mapping DROP CONSTRAINT IF EXISTS fixture_context_reject');
      await ownerPool.query("DELETE FROM assessment.term_test_exam_session WHERE class_name_snapshot LIKE 'K67SIM_CTX%' AND attempt_id IS NULL");
      await ownerPool.query('DELETE FROM mapping.reviewer_session WHERE reviewer_email=$1', [teacher]);
      await ownerPool.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1', [teacher]);
      await ownerPool.query('DELETE FROM mapping.reviewer_account WHERE email=$1', [teacher]);
      await ownerPool.query('DELETE FROM mapping.student_mapping_review WHERE public_id=$1', [studentRef]);
      await ownerPool.query("DELETE FROM mapping.classroom_course_mapping WHERE erp_class_name_snapshot LIKE 'K67SIM_CTX%'");
      await ownerPool.query('DELETE FROM mapping.k67_context_state');
    }
  } finally { await Promise.all([appPool.end(), ownerPool.end(), contextPool.end()]); }
});
test('Role nguồn chỉ đọc được năm view theo scope, không đọc bảng gốc hoặc khóa phiên', async () => {
  const client = await ownerPool.connect();
  try {
    await client.query('SET ROLE k67_context_reader');
    assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'k67_context_reader');
    const classes = (await client.query('SELECT * FROM k67_context_api_v1.classes')).rows;
    assert.deepEqual(classes.map(row => row.erp_course_class_id).sort(), ['1124', '1131']);
    for (const sql of ['SELECT * FROM mapping.reviewer_account', 'SELECT token_hash FROM mapping.reviewer_session',
      'SELECT * FROM assessment.term_test_attempt', 'UPDATE k67_context_api_v1.classes SET erp_class_name_snapshot=erp_class_name_snapshot']) {
      await assert.rejects(client.query(sql), error => error.code === '42501' || error.code === '55000');
    }
  } finally { await client.query('RESET ROLE'); client.release(); }
});
test('API HTTP nguồn đọc PostgreSQL thật, consumer xác nhận hash rồi áp dụng được', async () => {
  const sourcePool = { connect: async () => {
    const client = await ownerPool.connect();
    await client.query('SET ROLE k67_context_reader');
    return { query: (...args) => client.query(...args), release: () => {
      // RESET ROLE trước trả pool; hàm query phía nguồn đã commit/rollback transaction.
      client.query('RESET ROLE').then(() => client.release(), () => client.release(true));
    } };
  } };
  const source = createContextSourceApp({ pool: sourcePool, secret: 'c'.repeat(32) });
  const server = source.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const received = await fetchContextSnapshot({ url: `http://127.0.0.1:${server.address().port}/v1/snapshot`, secret: 'c'.repeat(32) });
    assert.equal(received.classes.length, 2);
    const result = await applyContextSnapshot(contextPool, received);
    assert.equal(result.sourceRevision, received.sourceRevision);
    assert.equal((await appPool.query('SELECT source_revision FROM mapping.k67_context_state')).rows[0].source_revision, received.sourceRevision);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('Snapshot cũ và nội dung sửa sai hash không đổi mirror đã áp dụng', async () => {
  const good = snapshot();
  await applyContextSnapshot(contextPool, good);
  const old = { ...good, capturedAt: new Date(Date.parse(good.capturedAt) - 1000).toISOString() };
  await assert.rejects(applyContextSnapshot(contextPool, old), /CONTEXT_OLDER_SNAPSHOT/);
  const bad = structuredClone(good);
  bad.accounts[0].role = 'admin';
  await assert.rejects(applyContextSnapshot(contextPool, bad), /CONTEXT_REVISION_MISMATCH/);
  assert.equal((await appPool.query('SELECT role FROM mapping.reviewer_account WHERE email=$1', [teacher])).rows[0].role, 'teacher');
  assert.equal((await appPool.query('SELECT source_revision FROM mapping.k67_context_state')).rows[0].source_revision, good.sourceRevision);
});
test('SQL lỗi giữa lần đồng bộ quay lui cả quyền, phiên và mirror', async () => {
  await applyContextSnapshot(contextPool, snapshot());
  const cookie = await login();
  const prior = (await appPool.query('SELECT source_revision FROM mapping.k67_context_state')).rows[0].source_revision;
  await ownerPool.query("ALTER TABLE mapping.classroom_course_mapping ADD CONSTRAINT fixture_context_reject CHECK(erp_class_name_snapshot <> 'K67SIM_REJECT')");
  try {
    const candidate = snapshot({ classes: [{ erp_course_class_id: '1124', erp_class_name_snapshot: 'K67SIM_REJECT' }],
      accounts: [{ email: teacher, google_subject: null, display_name: 'Giáo viên mô phỏng', role: 'admin', status: 'active', can_access_all_classes: true }] });
    await assert.rejects(applyContextSnapshot(contextPool, candidate), error => error.code === '23514');
    assert.equal((await appPool.query('SELECT source_revision FROM mapping.k67_context_state')).rows[0].source_revision, prior);
    assert.equal((await appPool.query('SELECT role FROM mapping.reviewer_account WHERE email=$1', [teacher])).rows[0].role, 'teacher');
    const response = await request(app).get('/api/term-tests/teacher/options').set('Cookie', cookie).expect(200);
    assert.deepEqual(response.body.classes.map(row => row.id), ['1124']);
  } finally { await ownerPool.query('ALTER TABLE mapping.classroom_course_mapping DROP CONSTRAINT fixture_context_reject'); }
});
test('NULL subject từ nguồn giữ Google binding; thu hồi rồi cấp lại không phục hồi cookie cũ', async () => {
  await applyContextSnapshot(contextPool, snapshot());
  const cookie = await login();
  await applyContextSnapshot(contextPool, snapshot());
  assert.equal((await appPool.query('SELECT google_subject FROM mapping.reviewer_account WHERE email=$1', [teacher])).rows[0].google_subject, 'k67-fixture-google-subject');
  await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
  await applyContextSnapshot(contextPool, snapshot({ accounts: [], access: [] }));
  await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  await applyContextSnapshot(contextPool, snapshot());
  await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  assert.ok((await ownerPool.query('SELECT count(*)::int AS n FROM mapping.reviewer_session WHERE reviewer_email=$1 AND revoked_reason=$2', [teacher, 'context_changed'])).rows[0].n > 0);
  await assert.rejects(contextPool.query('SELECT token_hash FROM mapping.reviewer_session'), error => error.code === '42501');
  await assert.rejects(contextPool.query("INSERT INTO mapping.reviewer_session(token_hash) VALUES ('x')"), error => error.code === '42501');
});
test('Đăng xuất thu hồi phiên trong DB thật và cookie không đăng nhập lại được', async () => {
  await applyContextSnapshot(contextPool, snapshot());
  const cookie = await login();
  await request(app).delete('/api/auth/session').set('Cookie', cookie)
    .set('Origin', 'https://fixture.example.test').set('x-izone-csrf', '1').expect(200);
  await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  assert.ok((await ownerPool.query('SELECT count(*)::int AS n FROM mapping.reviewer_session WHERE reviewer_email=$1 AND revoked_reason=$2', [teacher, 'logout'])).rows[0].n > 0);
});
test('Đăng nhập đồng thời thu hồi quyền không tạo cookie sống lại khi cấp lại tài khoản', { timeout: 15000 }, async () => {
  await applyContextSnapshot(contextPool, snapshot());
  let releaseLogin;
  let reachedAccount;
  const pause = new Promise(resolve => { releaseLogin = resolve; });
  const reached = new Promise(resolve => { reachedAccount = resolve; });
  // Dừng sau kiểm tài khoản để ép đúng giao nhau; SQL và transaction vẫn chạy trên PostgreSQL thật.
  async function queryWithPause(target, sql, params) {
    const result = await target.query(sql, params);
    if (/^UPDATE mapping\.reviewer_account\s/.test(sql.trim())) {
      reachedAccount();
      await pause;
    }
    return result;
  }
  const pausedPool = {
    query: (sql, params) => queryWithPause(appPool, sql, params),
    connect: async () => {
      const client = await appPool.connect();
      return { query: (sql, params) => queryWithPause(client, sql, params), release: () => client.release() };
    }
  };
  const racingApp = createApp({ config, pool: pausedPool, verifyGoogleToken: verify, logger: { info() {}, error() {} } });
  const pendingLogin = request(racingApp).post('/api/auth/session').send({ credential: 'k67-synthetic-google-token-only' }).then(value => value);
  let syncPromise;
  try {
    await reached;
    let syncSettled = false;
    syncPromise = (async () => {
      await applyContextSnapshot(contextPool, snapshot({ accounts: [], access: [] }));
      await applyContextSnapshot(contextPool, snapshot());
    })();
    syncPromise.then(() => { syncSettled = true; }, () => { syncSettled = true; });
    // Bản có khóa phải chờ; bản lỗi hoàn tất đồng bộ trước INSERT. Cả hai đều được quan sát, không đoán bằng sleep.
    const deadline = Date.now() + 5000;
    while (!syncSettled) {
      const blocked = (await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name='k67-fixture-context-revocation' AND wait_event='advisory'`)).rows[0].n;
      if (blocked > 0) break;
      assert.ok(Date.now() < deadline, 'Không quan sát được giao nhau giữa đăng nhập và đồng bộ');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    releaseLogin();
    const response = await pendingLogin;
    assert.equal(response.status, 201);
    await syncPromise;
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  } finally {
    releaseLogin();
    await Promise.allSettled([pendingLogin, ...(syncPromise ? [syncPromise] : [])]);
  }
});
test('Cấp thêm lớp thu hồi cookie cũ và phiên mới mới được thấy quyền đã cập nhật', async () => {
  await applyContextSnapshot(contextPool, snapshot());
  const cookie = await login();
  await applyContextSnapshot(contextPool, snapshot({ access: [
    { reviewer_email: teacher, erp_course_class_id: '1124' },
    { reviewer_email: teacher, erp_course_class_id: '1131' }
  ] }));
  await request(app).get('/api/term-tests/teacher/options').set('Cookie', cookie).expect(401);
  const fresh = await login();
  const response = await request(app).get('/api/term-tests/teacher/options').set('Cookie', fresh).expect(200);
  assert.deepEqual(response.body.classes.map(row => row.id).sort(), ['1124', '1131']);
});
test('Nguồn hết hạn đóng quyền/mở lượt nhưng bản nháp Listening có token vẫn lưu và đọc lại được', async () => {
  await applyContextSnapshot(contextPool, snapshot());
  const cookie = await login();
  const created = (await appPool.query(insertTermTestExamSessionSql, ['term-test-1', 1, 1124, 'K67SIM_CTXA', studentId, 'Học viên mô phỏng ngữ cảnh', 0])).rows[0];
  await appPool.query(startTermTestListeningSessionSql, [created.exam_session_token, 'term-test-1', 1800]);
  await ownerPool.query("UPDATE mapping.k67_context_state SET captured_at=now()-interval '3 minutes'");
  await request(app).get('/api/term-tests/teacher/options').set('Cookie', cookie).expect(503);
  await request(app).post('/api/term-tests/term-test-1/session/prepare').send({}).expect(503);
  const response = await request(app).post('/api/term-tests/term-test-1/listening/draft').send({
    examSessionToken: created.exam_session_token, answers: { 1: 'bài vẫn lưu' }, revision: 1 }).expect(200);
  assert.equal(response.body.accepted, true);
  assert.deepEqual((await appPool.query('SELECT listening_draft FROM assessment.term_test_exam_session WHERE id=$1', [created.exam_session_token])).rows[0].listening_draft, { 1: 'bài vẫn lưu' });
});
test('Request đã xác thực admin không đọc lớp sau khi cookie bị thu hồi giữa authenticate và SQL', { timeout: 15000 }, async () => {
  await applyContextSnapshot(contextPool, snapshot({ accounts: [{ email: teacher, google_subject: null,
    display_name: 'Quản trị mô phỏng', role: 'admin', status: 'active', can_access_all_classes: true }] }));
  const cookie = await login();
  let releaseRequest;
  let reachedAuth;
  const pause = new Promise(resolve => { releaseRequest = resolve; });
  const reached = new Promise(resolve => { reachedAuth = resolve; });
  const pausedPool = { query: async (sql, ...args) => {
    const result = await appPool.query(sql, ...args);
    if (sql.includes('UPDATE mapping.reviewer_session AS session')) { reachedAuth(); await pause; }
    return result;
  } };
  const racingApp = createApp({ config, pool: pausedPool, verifyGoogleToken: verify, logger: { info() {}, error() {} } });
  const pending = request(racingApp).get('/api/term-tests/teacher/options').set('Cookie', cookie).then(value => value);
  try {
    await reached;
    await applyContextSnapshot(contextPool, snapshot());
    releaseRequest();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.classes, []);
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  } finally { releaseRequest(); await Promise.allSettled([pending]); }
});
test('SQL kết quả và hai chi tiết kiểm phiên/quyền hiện tại cùng dữ liệu, không nhận cờ admin cũ', async () => {
  await applyContextSnapshot(contextPool, snapshot());
  const cookie = await login();
  const tokenHash = crypto.createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('hex');
  const sessionAuthorization = { source: 'session', tokenHash };
  const queries = [
    [listTermTestTeacherResultsSql, []],
    [fetchTermTestTeacherWritingDetailSql, [studentRef, 1]],
    [fetchTermTestTeacherAttemptReviewSql, [studentRef]]
  ];
  async function check(authorization, className, expected) {
    for (const [sql, tail] of queries) {
      const result = await appPool.query(sql, [className, 'term-test-1', teacher, authorization, ...tail]);
      assert.equal(Number(result.rows[0].authorized_class_count), expected);
    }
  }
  await check(sessionAuthorization, 'K67SIM_CTXA', 1);
  await check(sessionAuthorization, 'K67SIM_CTXB', 0);
  await check({ source: 'google_bearer', googleSubject: 'k67-fixture-google-subject' }, 'K67SIM_CTXA', 1);
  await check({ source: 'google_bearer', googleSubject: 'wrong-subject' }, 'K67SIM_CTXA', 0);
  await check(true, 'K67SIM_CTXB', 0);
  await applyContextSnapshot(contextPool, snapshot({ access: [] }));
  await check(sessionAuthorization, 'K67SIM_CTXA', 0);
  await applyContextSnapshot(contextPool, snapshot());
  await check(sessionAuthorization, 'K67SIM_CTXA', 0);
});
