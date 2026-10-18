// Gọi HTTP qua app thật và pool giả ở biên; không gọi Google, VPS hoặc điểm danh.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { mappingStudentIdentitySql } from '../src/student-identity.js';

const origin = 'https://tranhoangduc90.github.io';
const identity = { authority: 'erp-contact', id: '12345' };
const row = { person_id: '12345', student_ref: '11111111-1111-4111-8111-111111111111',
  class_id: '111', class_code: 'LOPTHU', student_name: 'Học viên thử' };
function app(query) {
  return createApp({ config: { nodeEnv: 'test', authMode: 'legacy', legacyReviewToken: 'fixture-only',
    allowedOrigins: new Set([origin]), trustProxyHops: 0 }, pool: { query },
    logger: { info() {}, error() {}, warn() {} } });
}

test('API nhận diện qua app thật chỉ SELECT và trả đúng người, không tạo mã phiên', async () => {
  const queries = [];
  const api = app(async (sql, params) => { queries.push({ sql, params }); return { rows: [row] }; });
  const response = await request(api).post('/api/student-identity/resolve').set('Origin', origin).send({ identity });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.identity, identity);
  assert.deepEqual(response.body.aliases, [{ classId: '111', classCode: 'LOPTHU', studentRef: row.student_ref, studentName: row.student_name }]);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].sql, mappingStudentIdentitySql);
  assert.deepEqual(queries[0].params, ['12345', null, null]);
  assert.equal(Object.keys(response.body).some(key => /token|session|attempt/i.test(key)), false);
});

test('Input sai hoặc origin không được phép không được chạm nguồn danh tính', async () => {
  let calls = 0;
  const api = app(async () => { calls++; return { rows: [row] }; });
  const invalid = await request(api).post('/api/student-identity/resolve').set('Origin', origin)
    .send({ identity: { authority: 'erp-contact', id: '-5' } });
  assert.equal(invalid.status, 400);
  const forbidden = await request(api).post('/api/student-identity/resolve').set('Origin', 'https://untrusted.invalid').send({ identity });
  assert.equal(forbidden.status, 403);
  assert.equal(calls, 0);
});

test('Hai HTTP giống nhau cùng chờ một lần đọc, sau đó đọc mới khi nguồn đổi', async () => {
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const api = app(async () => {
    calls++;
    if (calls === 1) await waiting;
    return { rows: calls === 1 ? [row] : [] };
  });
  const a = request(api).post('/api/student-identity/resolve').send({ identity }).then(value => value);
  const b = request(api).post('/api/student-identity/resolve').send({ identity }).then(value => value);
  // Đợi cả hai request vào app; chỉ pool đầu bị giữ để kiểm gộp, không giả lập kết quả nhận diện.
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 1);
  release();
  assert.deepEqual((await Promise.all([a, b])).map(value => value.body.status), ['unique', 'unique']);
  const fresh = await request(api).post('/api/student-identity/resolve').send({ identity });
  assert.equal(calls, 2);
  assert.equal(fresh.body.status, 'missing');
});

test('Lỗi SQL trả lỗi HTTP, không trả missing hoặc xóa danh tính thay người dùng', async () => {
  const api = app(async () => { throw new Error('fixture source offline'); });
  const response = await request(api).post('/api/student-identity/resolve').send({ identity });
  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.status, undefined);
});
