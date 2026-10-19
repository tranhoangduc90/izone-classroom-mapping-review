// Gọi route HTTP thật: giữ guard ngữ cảnh K67, pool K56 đổi schema và không ghi bài.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { mountTermStudentIdentity } from '../src/student-identity.js';
import { createContextGuard } from '../../products/term-mini-k67/src/context-guard.js';
const identity = { authority: 'erp-contact', id: '12345' };
const row = { person_id: '12345', student_ref: '11111111-1111-4111-8111-111111111111',
  class_id: '111', class_code: 'LOPTHU', student_name: 'Học viên thử' };
function app(pool, options = {}) {
  const app = express(); app.use(express.json());
  mountTermStudentIdentity(app, { pool, ...options });
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: 'FIXTURE_SOURCE_FAILURE' }));
  return app;
}
test('K56 giữ pool riêng, truyền lớp/bài và chỉ tra người đủ quyền', async () => {
  const calls = [];
  const api = app({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [row] }; } }, { k56: true });
  const response = await request(api).post('/api/term-tests/term-test-1-k56/student-identity')
    .send({ identity, classCode: 'LOPTHU' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.identity, identity);
  assert.deepEqual(calls[0].params, ['12345', null, 'LOPTHU', 'term-test-1-k56']);
  assert.match(calls[0].sql, /term_test_class_access/);
  assert.match(calls[0].sql, /is_eligible/);
  assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
});
test('K67 thiếu/cũ ngữ cảnh: từ chối trước SQL nhận diện', async () => {
  for (const captured of [null, new Date(Date.now() - 300000)]) {
    const calls = [];
    const pool = { query: async sql => { calls.push(sql); return { rows: captured ? [{ captured_at: captured }] : [] }; } };
    const response = await request(app(pool, { middleware: [createContextGuard({ pool })] }))
      .post('/api/term-tests/term-test-1/student-identity').send({ identity });
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'CONTEXT_UNAVAILABLE');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /k67_context_state/);
  }
});
test('K67 ngữ cảnh mới: tra đúng người; không yêu cầu bảng riêng K56', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params });
    return { rows: sql.includes('k67_context_state') ? [{ captured_at: new Date() }] : [row] }; } };
  const response = await request(app(pool, { middleware: [createContextGuard({ pool })] }))
    .post('/api/term-tests/mini-test-lesson-5/student-identity').send({ identity });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'unique');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].sql, /term_test_class_access/);
});
test('Mã bài và input sai không truy vấn nguồn; lỗi nguồn không giả thành không có người', async () => {
  let calls = 0;
  const api = app({ query: async () => { calls++; throw new Error('offline'); } });
  assert.equal((await request(api).post('/api/term-tests/not-a-test/student-identity').send({ identity })).status, 400);
  assert.equal((await request(api).post('/api/term-tests/term-test-1/student-identity').send({ identity, attemptToken: 'x' })).status, 400);
  assert.equal(calls, 0);
  const failed = await request(api).post('/api/term-tests/term-test-1/student-identity').send({ identity });
  assert.equal(failed.status, 500); assert.equal(failed.body.status, undefined);
});
test('Module được đóng cùng K67 khớp chính xác bản chuẩn, không lệ thuộc runtime Mapping', async () => {
  const [source, bundled] = await Promise.all([readFile(new URL('../src/student-identity.js', import.meta.url), 'utf8'),
    readFile(new URL('../../products/term-mini-k67/src/student-identity.js', import.meta.url), 'utf8')]);
  // Git trên Windows có thể checkout hai bản bằng CRLF/LF; chỉ khác xuống dòng không đổi module.
  assert.equal(bundled.replaceAll('\r\n','\n'), source.replaceAll('\r\n','\n'));
});
