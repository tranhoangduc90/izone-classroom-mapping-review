import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createErpGradeSync } from '../src/erp-sync.js';

// Nhận status/body đã quan sát; chạy chính bên gửi điểm với fetch tiêm vào, không gọi mạng.
// Tín hiệu invalidJSON cũ được replay theo lỗi parser, không giả là nguyên byte phản hồi.
// Trả việc bên gọi chấp nhận/từ chối và số lần gọi; đầu vào sai làm phép kiểm thất bại.
export async function proveErpResponse({ httpStatus, responseText, parseFailure = false, payload }) {
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 599
      || (parseFailure !== true && typeof responseText !== 'string')) throw new Error('RESPONSE_PROOF_INVALID');
  let calls = 0;
  const sync = createErpGradeSync({
    config: { erpSyncUrl: 'https://fixture.invalid/portal', erpSyncSecret: 'synthetic', erpSyncTimeoutMs: 1000 },
    fetchImpl: async () => {
      calls++;
      return parseFailure ? {
        ok: httpStatus >= 200 && httpStatus < 300,
        json: async () => { throw new SyntaxError('Captured response was not JSON'); }
      } : new Response(responseText, { status: httpStatus });
    }
  });
  let accepted = false, errorCode = null;
  try { accepted = (await sync(payload)).status === 'synced'; }
  catch (error) {
    errorCode = error instanceof SyntaxError ? 'ERP_SYNC_RESPONSE_NOT_JSON'
      : ['ERP_SYNC_HTTP_ERROR', 'ERP_SYNC_INVALID_RESPONSE'].includes(error.message) ? error.message : 'ERP_SYNC_OTHER_ERROR';
  }
  if (calls !== 1) throw new Error('RESPONSE_PROOF_CALLER_NOT_EXECUTED');
  return { accepted, rejected: !accepted, calls, errorCode,
    representation: parseFailure ? 'captured-invalidJSON' : 'captured-response-text' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  console.log(JSON.stringify(await proveErpResponse(input)));
}
