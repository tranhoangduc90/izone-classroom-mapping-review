// Dữ liệu vào: đúng một cacheValue bài giả đã ẩn danh qua stdin; không ghi file.
// Việc chính: gửi tới cổng seed chỉ nhận kết nối localhost trong container canary.
// Kết quả: một collect job sẵn sàng; không in bài, nhận xét hoặc khóa đồng bộ.
// Khi lỗi: trả mã khác 0 và chỉ in mã lỗi tổng quát để người vận hành điều tra.
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 8_000_000) throw new Error('CANARY_SEED_STDIN_TOO_LARGE');
}
const payload = JSON.parse(raw);
if (typeof payload.cacheValue !== 'string') throw new Error('CANARY_SEED_CACHE_REQUIRED');
const response = await fetch('http://127.0.0.1:8791/__canary/seed', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cacheValue: payload.cacheValue }),
  signal: AbortSignal.timeout(30000),
});
const body = await response.json();
if (response.status !== 200 || body?.ok !== true) {
  throw new Error(`CANARY_SEED_HTTP_${response.status}`);
}
process.stdout.write(JSON.stringify({ outcome: 'success',
  state: body.state, pendingJobs: body.pendingJobs }) + '\n');
