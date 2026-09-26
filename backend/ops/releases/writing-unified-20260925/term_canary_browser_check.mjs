import { verifyTermCanaryBrowserResult } from './term_canary_browser.mjs';

// Dữ liệu vào: JSON kết quả của đúng một bài giả từ canary, truyền qua stdin.
// Việc chính: kiểm giao diện Term bằng Chrome cô lập, không gọi API thật.
// Kết quả: chỉ in số phép đọc và trạng thái, không in bài viết hay nhận xét.
// Khi lỗi: trả mã thất bại và tên lỗi ngắn để người vận hành kiểm lại canary.
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw new Error('CANARY_BROWSER_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const pagesRoot = process.env.K56_PAGES_ROOT;
  const checked = await verifyTermCanaryBrowserResult({ result, pagesRoot });
  process.stdout.write(`${JSON.stringify({ toolOutcome: 'success',
    businessOutcome: 'browser_result_verified', ...checked })}\n`);
} catch (error) {
  const code = /^CANARY_BROWSER_[A-Z0-9_]+$/u.test(error?.message || '')
    ? error.message : 'CANARY_BROWSER_FAILED';
  process.stderr.write(`${JSON.stringify({ toolOutcome: 'failure',
    businessOutcome: 'unknown', errorCode: code })}\n`);
  process.exitCode = 2;
}
