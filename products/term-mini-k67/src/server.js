import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool, verifyDatabaseBoundary } from './db.js';
import { createErpGradeSync } from './erp-sync.js';
import { createTermTestAssetService } from './term-test-assets.js';
import { createTermTestWritingGradingService } from './term-test-writing-grading.js';
import { createTermTestWritingNotifier, withTermTestWritingNotifications } from './term-test-writing-notifier.js';

// Đọc cấu hình riêng, xác nhận DB rồi chỉ khởi động thi/chấm K67.
// Cấu hình lỗi dừng sớm; lỗi lúc chạy không in bài làm hoặc khóa bí mật.
const config = loadConfig();
const pool = createDatabasePool(config);
try { await verifyDatabaseBoundary(pool, config); }
catch (error) { await pool.end(); throw error; }
const syncErpGrades = createErpGradeSync({ config });
const termTestAssetService = createTermTestAssetService({
  assetDir: config.termTestAssetDir, sessionSecret: config.termTestSessionSecret
});
const notifier = createTermTestWritingNotifier({
  pool, url: config.termTestNotifyUrl, secret: config.termTestNotifySecret
});
const termTestWritingGradingService = withTermTestWritingNotifications(
  config.writingTestSyncSecret ? createTermTestWritingGradingService({ pool, syncErpGrades }) : null,
  notifier
);
const app = createApp({ config, pool, syncErpGrades, termTestAssetService, termTestWritingGradingService });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Backend thi K67 đang lắng nghe tại cổng ${config.port}.`);
  notifier.kick();
});
server.requestTimeout = 15000;
server.headersTimeout = 16000;
server.keepAliveTimeout = 5000;
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  notifier.close();
  console.log(`Nhận ${signal}; đang đóng backend K67 an toàn.`);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
