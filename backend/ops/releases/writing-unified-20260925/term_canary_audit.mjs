// Dữ liệu vào: trạng thái canary ở localhost bên trong container thử.
// Việc chính: chỉ lấy tên khóa đồng bộ và số lượng job, không đọc bài hoặc khóa bí mật.
// Kết quả: bằng chứng ngắn để nối workflow thử và xác nhận ghi nhận kết quả.
// Khi lỗi: trả mã lỗi, không sửa dữ liệu hoặc tự chạy lại workflow.
const response = await fetch('http://127.0.0.1:8791/__canary/audit', {
  signal: AbortSignal.timeout(5000),
});
const body = await response.json();
if (!response.ok || body?.ok !== true) process.exit(2);
process.stdout.write(JSON.stringify({
  outcome: 'success',
  database: body.database,
  seedState: body.seedState,
  syncKey: body.syncKey,
  jobs: body.jobs,
  runStates: body.runStates,
  portalMockCalls: body.portalMockCalls,
  attemptCount: body.attemptCount,
  ownedRedisKeyCount: body.ownedRedisKeys?.length,
}) + '\n');
