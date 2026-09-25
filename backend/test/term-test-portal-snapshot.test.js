import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { projectTermK56PortalSnapshot } from '../src/term-test-portal-snapshot.js';

const privateMarker = 'PRIVATE_DATA_MUST_NOT_LEAVE_BACKEND';
const portalResponse = () => ({
  class_tests: [
    { id: 101, name: 'Term Test 1 Listening', max_grade: 40, note: privateMarker },
    { id: 102, name: 'Term Test 1 Reading', max_grade: 26 },
    { id: 103, name: 'Term Test 1 Writing', max_grade: 9 },
    { id: 201, name: 'Term Test 2 Writing', max_grade: 9 }
  ],
  student_test_grades: [
    { student_id: 9002, class_test_id: 101, grade: 20,
      meta: { records: [{ id: 'record_101', note: privateMarker }] } },
    { student_id: 9002, class_test_id: 102, grade: 13 },
    { student_id: 9002, class_test_id: 103, grade: null },
    { student_id: 9002, class_test_id: 201, grade: 7 },
    { student_id: 9003, class_test_id: 103, grade: 6 }
  ],
  class_registrations: [{ contact: { full_name: privateMarker,
    email: privateMarker, phone: privateMarker, dob: privateMarker },
    teacher_feedback: privateMarker }]
});

function appFor(profile, fetchImpl, overrides = {}) {
  return createApp({
    config: {
      nodeEnv: 'test', authMode: 'legacy', googleClientId: '',
      legacyReviewToken: '', allowedOrigins: new Set(), trustProxyHops: 0,
      deploymentProfileName: profile, erpSyncSecret: 'synthetic-term-secret',
      ...overrides
    },
    pool: { async query() { throw new Error('Endpoint lọc Portal không được gọi database'); } },
    portalSnapshotFetchImpl: fetchImpl,
    logger: { info() {}, warn() {}, error() {} }
  });
}

const path = '/api/term-tests/writing-grading/portal-snapshot'
  + '?classId=99000001&studentId=9002&testSlug=term-test-1-k56';

test('snapshot Term K56 chỉ chứa ba cột và điểm của đúng học viên', () => {
  const snapshot = projectTermK56PortalSnapshot(portalResponse(), {
    studentId: '9002', testSlug: 'term-test-1-k56'
  });
  assert.deepEqual(snapshot.class_tests.map(item => item.id), [101, 102, 103]);
  assert.deepEqual(snapshot.student_test_grades.map(item => item.grade), [20, 13, null]);
  assert.equal(snapshot.student_test_grades[0].meta.records[0].id, 'record_101');
  assert.equal(JSON.stringify(snapshot).includes(privateMarker), false);
  assert.equal(JSON.stringify(snapshot).includes('class_registrations'), false);
});

test('cột hoặc điểm trùng được giữ để writer phát hiện xung đột', () => {
  const source = portalResponse();
  source.class_tests.push({ id: 104, name: 'Term Test 1 Writing', max_grade: 9 });
  source.student_test_grades.push({ student_id: 9002, class_test_id: 103, grade: 4.5 });
  const snapshot = projectTermK56PortalSnapshot(source, {
    studentId: '9002', testSlug: 'term-test-1-k56'
  });
  assert.equal(snapshot.class_tests.filter(item => item.name === 'Term Test 1 Writing').length, 2);
  assert.equal(snapshot.student_test_grades.filter(item => item.class_test_id === 103).length, 2);
});

test('route K56 xác thực trước khi đọc và chỉ gọi đúng URL Portal cố định', async () => {
  let fetchCount = 0;
  const app = appFor('k56-ic2264', async (url, options) => {
    fetchCount += 1;
    assert.equal(url,
      'https://gateway.izone.edu.vn/portal/v1/course-classes/99000001/student-tests');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(portalResponse()), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  });
  assert.equal((await request(app).get(path)).status, 401);
  assert.equal((await request(app).get(path).set('x-term-test-sync', 'wrong')).status, 401);
  assert.equal(fetchCount, 0);
  const response = await request(app).get(path).set('x-term-test-sync', 'synthetic-term-secret');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(fetchCount, 1);
  assert.equal(JSON.stringify(response.body).includes(privateMarker), false);
  assert.equal(response.body.student_test_grades.length, 3);
});

test('K67 và K56 demo không mở route mới; query sai dừng trước GET', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount += 1; throw new Error('Không được gọi'); };
  for (const profile of ['k67', 'k56-demo']) {
    const app = appFor(profile, fetchImpl);
    assert.equal((await request(app).get(path)
      .set('x-term-test-sync', 'synthetic-term-secret')).status, 404);
  }
  const app = appFor('k56-ic2264', fetchImpl);
  const bad = await request(app).get(path.replace('studentId=9002', 'studentId=9002&studentId=9003'))
    .set('x-term-test-sync', 'synthetic-term-secret');
  assert.equal(bad.status, 400);
  assert.equal(fetchCount, 0);
});

test('Portal lỗi hoặc phản hồi quá lớn không trả payload chưa lọc', async () => {
  for (const response of [
    new Response('', { status: 503 }),
    new Response(privateMarker, { status: 200 }),
    new Response('X'.repeat((4 * 1024 * 1024) + 1), { status: 200 })
  ]) {
    const app = appFor('k56-ic2264', async () => response);
    const result = await request(app).get(path)
      .set('x-term-test-sync', 'synthetic-term-secret');
    assert.equal(result.status, 502);
    assert.equal(JSON.stringify(result.body).includes(privateMarker), false);
    assert.equal(result.body.error, 'PORTAL_SNAPSHOT_UNAVAILABLE');
  }
});
