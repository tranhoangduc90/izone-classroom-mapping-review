// Dữ liệu nhận vào: ba mẫu phiếu giả của source code, không đọc production.
// Việc chính: chạy API demo trong bộ nhớ để kiểm giao diện tại localhost.
// Kết quả: URL thử cho Playwright/trình duyệt; dừng tiến trình là xóa dữ liệu.
// Khi lỗi: in mã lỗi kỹ thuật, không kết nối hoặc sửa hệ thống thật.
import { PGlite } from '@electric-sql/pglite';
import { createLearningDemoApp, createPGlitePool, initializeLearningDemoDatabase } from '../src/learning-demo.js';
import { createLearningDemoGrant } from '../src/learning-demo-grant.js';
import { startLearningAttendanceWorker } from '../src/learning-attendance-worker.js';
import { sha256, stableStringify } from '../src/learning-domain.js';
import { buildIc2305EntranceDefinition, buildIc2305EntranceGradingKey } from '../src/learning-templates/ic2305-entrance-reading1-listening1.js';
import { buildIc2305Writing1Definition, buildIc2305Writing1GradingKey } from '../src/learning-templates/ic2305-entrance-writing1.js';
import { buildIc2305Session4Definition, buildIc2305Session4GradingKey } from '../src/learning-templates/ic2305-session4-listening1-speaking2.js';

const examples = [
  ['90000000-0000-4000-8000-000000000001', buildIc2305EntranceDefinition(), buildIc2305EntranceGradingKey()],
  ['90000000-0000-4000-8000-000000000002', buildIc2305Writing1Definition(), buildIc2305Writing1GradingKey()],
  ['90000000-0000-4000-8000-000000000003', buildIc2305Session4Definition(), buildIc2305Session4GradingKey()]
];
const grantSecret = 'local-only-progress-log-preview-20260929';
const catalog = new Map(examples.map(([token, definition, gradingKey], index) => [token, {
  sourceAssignmentId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  title: definition.title,
  className: `Lớp mẫu ${index + 1}`,
  courseCode: definition.courseCode || 'ic23',
  sessionNumber: 4,
  definitionHash: sha256(stableStringify(definition)),
  definition, gradingKey
}]));

const database = new PGlite();
await initializeLearningDemoDatabase(database);
const pool = createPGlitePool(database);
const app = createLearningDemoApp({
  pool, allowedOrigin: 'http://127.0.0.1:5173', grantSecret,
  fetchSource: async token => {
    if (!catalog.has(token)) throw new Error('Không có phiếu mẫu này.');
    return catalog.get(token);
  }
});
const server = app.listen(8792, '127.0.0.1', () => {
  console.log('API demo mẫu đã sẵn sàng ở http://127.0.0.1:8792');
  for (const [token, source] of catalog) {
    const grant = createLearningDemoGrant({ assignmentId: source.sourceAssignmentId,
      publicToken: token, definitionHash: source.definitionHash, secret: grantSecret });
    console.log(`http://127.0.0.1:5173/progress-log/demo/#grant=${grant}`);
  }
});
const worker = startLearningAttendanceWorker({
  pool, pollMs: 1000,
  handler: async job => ({
    entityKey: job.entityKey, unitKey: job.unitKey,
    operationKey: job.operationKey, idempotencyKey: job.idempotencyKey,
    status: 'complete', portalStatus: 'simulated'
  })
});
async function stop() {
  server.close(async () => {
    await worker.stop();
    await database.close();
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
