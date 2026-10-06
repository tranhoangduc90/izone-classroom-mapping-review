import test from 'node:test';
import assert from 'node:assert/strict';
import { proveErpResponse } from '../ops/erp-response-proof.mjs';

// Phản hồi lỗi không được thành đã ghi điểm; ACK đúng token là positive control.
// Chỉ chạy caller thật với fetch giả, không gửi điểm tới bất kỳ hệ thống ngoài nào.
const token = '00000000-0000-4000-8000-000000000067';
const payload = { attemptToken: token };
const valid = JSON.stringify({ ok: true, status: 'synced', attemptToken: token });
for (const [name, responseText] of [
  ['rỗng', ''], ['HTML', '<html>Error</html>'], ['thiếu trường', '{}'],
  ['ok false', JSON.stringify({ ok: false, status: 'synced', attemptToken: token })],
  ['chưa synced', JSON.stringify({ ok: true, status: 'pending', attemptToken: token })],
  ['sai token', JSON.stringify({ ok: true, status: 'synced', attemptToken: '00000000-0000-4000-8000-000000000056' })]
]) test(`Caller từ chối HTTP200 ${name}`, async () => {
  const result = await proveErpResponse({ httpStatus: 200, responseText, payload });
  assert.equal(result.rejected, true); assert.equal(result.calls, 1);
});
test('Caller nhận ACK synced đúng token, tránh oracle luôn từ chối', async () => {
  const result = await proveErpResponse({ httpStatus: 200, responseText: valid, payload });
  assert.equal(result.accepted, true); assert.equal(result.calls, 1); assert.equal(result.errorCode, null);
});
test('Caller từ chối HTTP lỗi dù body có ACK hợp lệ', async () => {
  const result = await proveErpResponse({ httpStatus: 503, responseText: valid, payload });
  assert.equal(result.rejected, true); assert.equal(result.errorCode, 'ERP_SYNC_HTTP_ERROR');
});
test('Replay tín hiệu invalidJSON giữ giới hạn representation', async () => {
  const result = await proveErpResponse({ httpStatus: 200, parseFailure: true, payload });
  assert.equal(result.rejected, true); assert.equal(result.errorCode, 'ERP_SYNC_RESPONSE_NOT_JSON');
  assert.equal(result.representation, 'captured-invalidJSON'); assert.equal(result.calls, 1);
});
