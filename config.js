/*
 * Cấu hình phía trình duyệt.
 *
 * API_BASE_URL có thể công khai vì chỉ là địa chỉ endpoint; API vẫn yêu cầu mã truy cập.
 * DEMO_MODE đã tắt sau khi API production được phê duyệt và kiểm tra.
 * Không đặt mật khẩu Metabase, mật khẩu PostgreSQL, API key hoặc token vào file này.
 */
window.APP_CONFIG = {
  API_BASE_URL: 'https://ducizone.ddns.net/webhook',
  DEMO_MODE: false
};
