import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool, createLearningDatabasePool } from './db.js';
import { createErpGradeSync } from './erp-sync.js';
import { createTermTestAssetService } from './term-test-assets.js';
import { createTermTestResultEvents } from './term-test-result-events.js';
import { createTermTestWritingGradingService } from './term-test-writing-grading.js';
import { createTermTestWritingNotifier, withTermTestWritingNotifications } from './term-test-writing-notifier.js';
import { createTermTestPortalSyncService, startTermTestPortalSyncWorker } from './term-test-portal-sync.js';

// Khởi động API: đọc cấu hình, kết nối PostgreSQL và lắng nghe trên cổng nội bộ.
const config = loadConfig();
const pool = createDatabasePool(config);
const learningPool = config.learningEnabled ? createLearningDatabasePool(config) : null;
const syncErpGrades = createErpGradeSync({ config, pool });
const termTestResultEvents = createTermTestResultEvents();
const termTestPortalSyncService = createTermTestPortalSyncService({
  pool,
  syncErpGrades,
  enabled: Boolean(config.erpSyncUrl) && !config.demoIsolatedMode
});
const termTestAssetService = config.termTestAssetDir
  ? createTermTestAssetService({
      assetDir: config.termTestAssetDir,
      sessionSecret: config.termTestSessionSecret
    })
  : null;
const writingNotifier = createTermTestWritingNotifier({
  pool,
  url: config.deploymentProfile.writingNotifierEnabled ? (process.env.TERM_TEST_NOTIFY_URL || '') : '',
  secret: config.deploymentProfile.writingNotifierEnabled ? (process.env.TERM_TEST_NOTIFY_SECRET || '') : ''
});
const termTestWritingGradingService = withTermTestWritingNotifications(
  config.writingTestSyncSecret
    ? createTermTestWritingGradingService({
        pool,
        syncErpGrades,
        onResultStored: ({ attemptId }) => {
          if (config.deploymentProfile.resultStreamEnabled) termTestResultEvents.publishReady(attemptId);
        }
      })
    : null,
  writingNotifier
);
const app = createApp({
  config,
  pool,
  learningPool,
  syncErpGrades,
  termTestPortalSyncService,
  termTestAssetService,
  termTestWritingGradingService,
  termTestResultEvents
});

const portalSyncWorker = startTermTestPortalSyncWorker(termTestPortalSyncService);

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Mapping review API đang lắng nghe tại cổng ${config.port}.`);
  writingNotifier.kick();
});

server.requestTimeout = config.deploymentProfile.family === 'k56' ? 35_000 : 15_000;
server.headersTimeout = config.deploymentProfile.family === 'k56' ? 36_000 : 16_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  writingNotifier.close();
  termTestResultEvents.closeAll();
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  server.close(async () => {
    await portalSyncWorker.stop();
    await Promise.all([pool.end(), learningPool?.end()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
