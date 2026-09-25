// Dữ liệu vào: API canary trên localhost, không nhận bài/học viên từ dòng lệnh.
// Việc chính: tạo đúng một job dispatch cho bài giả Term K56 đã ghim đề.
// Kết quả: trạng thái và số job, không in prompt, essay hoặc định danh.
// Khi lỗi: trả mã thất bại; không tự seed lại vì endpoint chỉ nhận một lần.
const response = await fetch('http://127.0.0.1:8791/__canary/seed-dispatch', {
  method: 'POST', signal: AbortSignal.timeout(10000),
});
const body = await response.json();
if (!response.ok || body?.ok !== true || body?.state !== 'ready'
    || body?.jobType !== 'dispatch' || body?.pendingJobs !== 1) process.exit(2);
process.stdout.write(JSON.stringify({ outcome: 'success', state: body.state,
  pendingJobs: body.pendingJobs, jobType: body.jobType }) + '\n');
