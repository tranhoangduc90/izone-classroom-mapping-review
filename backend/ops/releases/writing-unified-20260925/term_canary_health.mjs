// Dữ liệu vào: phản hồi /health chỉ trong container canary.
// Việc chính: xác nhận ứng dụng đang nhận yêu cầu, không đọc bài hoặc credential.
// Kết quả: exit 0 khi sẵn sàng; Docker báo unhealthy nếu không đáp ứng.
// Khi lỗi: chỉ trả mã lỗi, không tự khởi động lại hay sửa dữ liệu.
try {
  const response = await fetch('http://127.0.0.1:8791/health', {
    signal: AbortSignal.timeout(4000),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
