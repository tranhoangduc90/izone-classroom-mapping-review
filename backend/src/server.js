import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool, createLearningDatabasePool, createSpeakingHomeworkDatabasePool } from './db.js';
import { createErpGradeSync } from './erp-sync.js';
import { createTermTestAssetService } from './term-test-assets.js';
import { createTermTestWritingGradingService } from './term-test-writing-grading.js';
import { createTermTestWritingNotifier, withTermTestWritingNotifications } from './term-test-writing-notifier.js';
import { createLearningAttendanceSync } from './learning-attendance-sync.js';
import { startLearningAttendanceWorker } from './learning-attendance-worker.js';
import { startSpeakingCheckWorker } from './speaking-check-worker.js';
import { startSpeakingGradeWorker } from './speaking-grade-worker.js';
import { startSpeakingDoctorWorker } from './speaking-doctor-worker.js';

// Khởi động API: đọc cấu hình, kết nối PostgreSQL và lắng nghe trên cổng nội bộ.
const config = loadConfig();
const pool = createDatabasePool(config);
const learningPool = config.learningEnabled ? createLearningDatabasePool(config) : null;
const speakingHomeworkPool = config.speakingHomeworkEnabled ? createSpeakingHomeworkDatabasePool(config) : null;
const syncErpGrades = createErpGradeSync({ config });
const termTestAssetService = config.termTestAssetDir
  ? createTermTestAssetService({
      assetDir: config.termTestAssetDir,
      sessionSecret: config.termTestSessionSecret
    })
  : null;
const writingNotifier = createTermTestWritingNotifier({
  pool,
  url: process.env.TERM_TEST_NOTIFY_URL || '',
  secret: process.env.TERM_TEST_NOTIFY_SECRET || ''
});
const termTestWritingGradingService = withTermTestWritingNotifications(
  config.writingTestSyncSecret
    ? createTermTestWritingGradingService({ pool, syncErpGrades })
    : null,
  writingNotifier
);
const learningAttendanceSync = createLearningAttendanceSync({ config });
const app = createApp({
  config,
  pool,
  learningPool,
  speakingHomeworkPool,
  syncErpGrades,
  termTestAssetService,
  termTestWritingGradingService
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Mapping review API đang lắng nghe tại cổng ${config.port}.`);
  writingNotifier.kick();
});
const learningAttendanceWorker = startLearningAttendanceWorker({
  pool: learningPool,
  handler: learningAttendanceSync,
  pollMs: config.learningAttendancePollMs
});
const speakingCheckWorker = startSpeakingCheckWorker({
  pool: speakingHomeworkPool,
  enabled: config.speakingHomeworkEnabled
});
const speakingGradeWorker = startSpeakingGradeWorker({
  pool: speakingHomeworkPool,
  enabled: config.speakingHomeworkEnabled
});
const speakingDoctorWorker = startSpeakingDoctorWorker({
  pool: speakingHomeworkPool,
  enabled: config.speakingHomeworkEnabled
});

server.requestTimeout = 15_000;
server.headersTimeout = 16_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  writingNotifier.close();
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  server.close(async () => {
    await learningAttendanceWorker.stop();
    await speakingCheckWorker.stop();
    await speakingGradeWorker.stop();
    await speakingDoctorWorker.stop();
    await Promise.all([pool.end(), learningPool?.end(), speakingHomeworkPool?.end()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
