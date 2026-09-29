import { createLearningDemoApp, createDemoSourceFetcher, createPGlitePool,
  openLearningDemoDatabase } from './learning-demo.js';
import { startLearningAttendanceWorker } from './learning-attendance-worker.js';

const port = Number(process.env.DEMO_PORT || 8797);
const allowedOrigin = process.env.DEMO_ALLOWED_ORIGIN || 'https://tranhoangduc90.github.io';
const dataDir = process.env.DEMO_DATA_DIR || '';
if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^https:\/\/[^/]+$/.test(allowedOrigin)) {
  throw new Error('Cổng hoặc origin demo không hợp lệ.');
}

const database = await openLearningDemoDatabase(dataDir);
const pool = createPGlitePool(database);
const fetchSource = createDemoSourceFetcher({
  url: process.env.DEMO_SOURCE_API_URL || '',
  secret: process.env.DEMO_SOURCE_SECRET || ''
});
const app = createLearningDemoApp({ pool, fetchSource, allowedOrigin,
  grantSecret: process.env.DEMO_SOURCE_SECRET || '' });
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Progress Log demo đang lắng nghe tại cổng ${port}.`);
});
// Điểm danh được xử lý trong kho demo; không gọi Portal hoặc dịch vụ ngoài.
const attendanceWorker = startLearningAttendanceWorker({
  pool,
  handler: async job => ({
    entityKey: job.entityKey,
    unitKey: job.unitKey,
    operationKey: job.operationKey,
    idempotencyKey: job.idempotencyKey,
    status: 'complete',
    portalStatus: 'simulated'
  }),
  pollMs: 2000
});

async function shutdown() {
  server.close(async () => {
    await attendanceWorker.stop();
    await database.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
