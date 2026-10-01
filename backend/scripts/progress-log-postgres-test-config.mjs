// Nhận URL/mã xác nhận của DB test; chỉ trả cấu hình localhost đã kiểm.
// Từ chối query/hash để tham số phụ không đổi host hoặc tắt timeout.
// Không kết nối, không ghi và không đưa mật khẩu vào lỗi.
import assert from 'node:assert/strict';
export function isolatedPostgresConfig(input,confirmation) {
  assert.ok(input&&confirmation==='progress-log-upgrade-20261001','ISOLATED_TEST_DATABASE_REQUIRED');
  const url=new URL(input);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol),'POSTGRES_URL_REQUIRED');
  assert.equal(url.search,'','QUERY_PARAMETERS_FORBIDDEN');
  assert.equal(url.hash,'','URL_FRAGMENT_FORBIDDEN');
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'LOCALHOST_ONLY');
  assert.match(decodeURIComponent(url.pathname),/^\/progress_log_upgrade_test_[a-z0-9_]+$/,'TEST_DATABASE_NAME_REQUIRED');
  const port=url.port?Number(url.port):5432;
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535,'INVALID_PORT');
  assert.ok(url.username,'EXPLICIT_TEST_USER_REQUIRED');
  return {host:url.hostname.replace(/^\[|\]$/g,''),port,database:decodeURIComponent(url.pathname.slice(1)),
    user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),max:8,
    connectionTimeoutMillis:5000,options:'-c statement_timeout=10000 -c lock_timeout=5000',ssl:false};
}
