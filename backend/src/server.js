import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool, createLearningDatabasePool } from './db.js';
import { createErpGradeSync } from './erp-sync.js';
import { createTermTestAssetService } from './term-test-assets.js';
import { createTermTestWritingGradingService } from './term-test-writing-grading.js';
import { createLearningAttendanceSync } from './learning-attendance-sync.js';
import { startLearningAttendanceWorker } from './learning-attendance-worker.js';

// Khởi động API: đọc cấu hình, kết nối PostgreSQL và lắng nghe trên cổng nội bộ.
const config = loadConfig();
const pool = createDatabasePool(config);
const learningPool = config.learningEnabled ? createLearningDatabasePool(config) : null;
const syncErpGrades = createErpGradeSync({ config });
const termTestAssetService = config.termTestAssetDir
  ? createTermTestAssetService({
      assetDir: config.termTestAssetDir,
      sessionSecret: config.termTestSessionSecret
    })
  : null;
const termTestWritingGradingService = config.writingTestSyncSecret
  ? createTermTestWritingGradingService({ pool, syncErpGrades })
  : null;
const learningAttendanceSync = createLearningAttendanceSync({ config });
const app = createApp({
  config,
  pool,
  learningPool,
  syncErpGrades,
  termTestAssetService,
  termTestWritingGradingService
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Mapping review API đang lắng nghe tại cổng ${config.port}.`);
});
const learningAttendanceWorker = startLearningAttendanceWorker({
  pool: learningPool,
  handler: learningAttendanceSync,
  pollMs: config.learningAttendancePollMs
});

server.requestTimeout = 15_000;
server.headersTimeout = 16_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  server.close(async () => {
    await learningAttendanceWorker.stop();
    await Promise.all([pool.end(), learningPool?.end()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
