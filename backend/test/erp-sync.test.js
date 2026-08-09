import assert from 'node:assert/strict';
import test from 'node:test';
import { buildErpGradePayload, createErpGradeSync } from '../src/erp-sync.js';

test('tạo payload ERP chỉ gồm ID kỹ thuật và Band', () => {
  const payload = buildErpGradePayload({
    attempt_token: '00000000-0000-4000-8000-000000000099',
    test_slug: 'term-test-1',
    class_id: '2139',
    student_id: '9001'
  }, {
    listening: { band: 6.5 },
    reading: { band: '<2.5' }
  });
  assert.deepEqual(payload.grades, { listening: 6.5, reading: 2 });
  assert.equal(JSON.stringify(payload).includes('studentName'), false);
});

test('Term Test 2 giữ đúng slug để n8n ghi vào các cột Phase 2', () => {
  const payload = buildErpGradePayload({
    attempt_token: '00000000-0000-4000-8000-000000000100',
    test_slug: 'term-test-2',
    class_id: '2139',
    student_id: '9002'
  }, {
    listening: { band: 7.0 },
    reading: { band: 6.5 }
  }, {
    writing: 6.0
  });

  assert.equal(payload.testSlug, 'term-test-2');
  assert.deepEqual(payload.grades, { listening: 7, reading: 6.5, writing: 6 });
});

test('gửi payload qua header bí mật và kiểm tra attempt token trả về', async () => {
  const payload = {
    version: 1,
    attemptToken: '00000000-0000-4000-8000-000000000099',
    testSlug: 'term-test-1',
    classId: '2139',
    studentId: '9001',
    grades: { listening: 6.5, reading: 6.5 }
  };
  let request;
  const sync = createErpGradeSync({
    config: {
      erpSyncUrl: 'https://n8n.example.invalid/webhook/dong-bo-diem-term-test',
      erpSyncSecret: 'x'.repeat(32),
      erpSyncTimeoutMs: 5000
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true, status: 'synced', attemptToken: payload.attemptToken }) };
    }
  });
  await sync(payload);
  assert.equal(request.options.headers['x-term-test-sync'], 'x'.repeat(32));
  assert.deepEqual(JSON.parse(request.options.body), payload);
});
