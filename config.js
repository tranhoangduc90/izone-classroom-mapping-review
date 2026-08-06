/*
 * Cấu hình phía trình duyệt.
 *
 * API_BASE_URL, AUTH_MODE và GOOGLE_CLIENT_ID đều là cấu hình công khai của trình duyệt.
 * DEMO_MODE đã tắt sau khi API production được phê duyệt và kiểm tra.
 * Không đặt mật khẩu Metabase, mật khẩu PostgreSQL, API key hoặc token vào file này.
 */
window.APP_CONFIG = {
  API_BASE_URL: 'https://ducizone.ddns.net/mapping-api',
  AUTH_MODE: 'google',
  GOOGLE_CLIENT_ID: '235597750133-urmb86ktf5recnvvtbghf13bktfv5rkj.apps.googleusercontent.com',
  DEMO_MODE: false
};
