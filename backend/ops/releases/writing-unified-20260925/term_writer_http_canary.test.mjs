import assert from 'node:assert/strict';
import test from 'node:test';
import { runCanary, validateCanaryWriterUrl } from './term_writer_http_canary.mjs';

const TRIAL_URL = 'https://n8n-ai.izone.edu.vn/webhook/'
  + 'term-k56-writer-bridge-00000000-0000-4000-8000-000000000001';

// Dữ liệu vào: URL workflow thử và gói điểm chỉ dùng lớp/học viên giả.
// Việc chính: kiểm đường gửi bị khóa và adapter chỉ gửi một HTTP dù gọi đồng bộ hai lần.
// Kết quả: test chạy hoàn toàn local, không gọi n8n hoặc Portal production.
// Khi lỗi: bộ canary không được dùng để mở cổng phát hành.
test('chỉ chấp nhận webhook bridge thử đúng host và đường dẫn', () => {
  assert.equal(validateCanaryWriterUrl(TRIAL_URL), TRIAL_URL);
  for (const invalid of [
    'https://n8n-ai.izone.edu.vn/webhook/term-test-portal-writer',
    'https://gateway.izone.edu.vn/webhook/term-k56-writer-bridge-00000000-0000-4000-8000-000000000001',
    TRIAL_URL + '?classId=123',
    TRIAL_URL.replace('https:', 'http:'),
  ]) assert.throws(() => validateCanaryWriterUrl(invalid));
});

test('backend adapter nhận đúng phản hồi và không gửi lặp', async () => {
  const sent = [];
  const result = await runCanary(TRIAL_URL, {
    fetchImpl: async (url, options) => {
      assert.equal(url, TRIAL_URL);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['x-term-test-sync'], 'canary-term-k56');
      const body = JSON.parse(options.body);
      sent.push(body);
      assert.equal(body.classId, '99000002');
      assert.equal(body.studentId, '9002');
      assert.equal(body.testSlug, 'term-test-2-k56');
      assert.deepEqual(body.grades, { listening: 31, reading: 28, writing: 6.5 });
      return Response.json({ ok: true, status: 'synced', attemptToken: body.attemptToken });
    },
  });
  assert.deepEqual(result, {
    businessOutcome: 'success', profile: 'term-test-2-k56',
    firstStatus: 'synced', repeatStatus: 'synced', repeatSkipped: true,
    httpCalls: 1, syncRows: 1,
  });
  assert.equal(sent.length, 1);
});

test('backend không nhận phản hồi thiếu ok là đồng bộ thành công', async () => {
  await assert.rejects(runCanary(TRIAL_URL, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return Response.json({ status: 'synced', attemptToken: body.attemptToken });
    },
  }), /CANARY_FIRST_SYNC_FAILED/u);
});
