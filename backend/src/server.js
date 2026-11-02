import { createApp } from './app.js';
import {createLearningTestSources} from './learning-test-current-sources.js';
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
import { createSpeakingDocsNotifier } from './speaking-docs-notifier.js';
import { startSpeakingPracticeWorker } from './speaking-practice-worker.js';
import { startSpeakingProgressDocsWorker } from './speaking-progress-docs.js';
import { createSpeakingProgressGoogle } from './speaking-progress-google.js';
import pg from 'pg';
import {startSpeakingLegacyWorker} from './speaking-legacy-work.js';
import {startSpeakingWorkCoordinator} from './speaking-work-runtime.js';

// Khởi động API: đọc cấu hình, kết nối PostgreSQL và lắng nghe trên cổng nội bộ.
const config = loadConfig();
const workersEnabled=process.env.WORKER_ENABLED!=='false';
const pool = createDatabasePool(config);
const learningPool = config.learningEnabled ? createLearningDatabasePool(config) : null;
const learningTestSources = config.learningEnabled ? createLearningTestSources({config,legacyPool:pool}) : null;
const speakingHomeworkPool = config.speakingHomeworkEnabled ? createSpeakingHomeworkDatabasePool(config) : null;
const speakingCoordinated=process.env.TEST_SERVICES_COORDINATOR_ENABLED==='true';
const progressGateway=process.env.SPEAKING_PROGRESS_DOCS_CREDENTIALS_FILE?createSpeakingProgressGoogle({credentialFile:process.env.SPEAKING_PROGRESS_DOCS_CREDENTIALS_FILE}):null;
const speakingProgressWorker=startSpeakingProgressDocsWorker({pool:speakingHomeworkPool,schema:'speaking_homework',gateway:speakingHomeworkPool&&workersEnabled?progressGateway:null,coordinated:speakingCoordinated});
const speakingDocsNotifier = createSpeakingDocsNotifier({
  pool: speakingHomeworkPool,
  url: workersEnabled?process.env.SPEAKING_DOCS_NOTIFY_URL||'':'',
  secret: process.env.SPEAKING_DOCS_NOTIFY_SECRET || ''
});
const syncErpGrades = createErpGradeSync({ config });
const termTestAssetService = config.termTestAssetDir
  ? createTermTestAssetService({
      assetDir: config.termTestAssetDir,
      sessionSecret: config.termTestSessionSecret
    })
  : null;
const writingNotifier = createTermTestWritingNotifier({
  pool,
  url: workersEnabled?process.env.TERM_TEST_NOTIFY_URL||'':'',
  secret: process.env.TERM_TEST_NOTIFY_SECRET || ''
});
const termTestWritingGradingService = withTermTestWritingNotifications(
  config.writingTestSyncSecret
    ? createTermTestWritingGradingService({ pool, syncErpGrades })
    : null,
  writingNotifier
);
const learningAttendanceSync = createLearningAttendanceSync({ config, pool: learningPool });
const app = createApp({
  config,
  pool,
  learningPool,
  learningTestResultReader: learningTestSources?.reader,
  speakingHomeworkPool,
  syncErpGrades,
  termTestAssetService,
  termTestWritingGradingService
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Mapping review API đang lắng nghe tại cổng ${config.port}.`);
  writingNotifier.kick();
  void speakingDocsNotifier.start();
});
const learningAttendanceWorker = startLearningAttendanceWorker({
  pool: workersEnabled?learningPool:null,
  handler: learningAttendanceSync,
  pollMs: config.learningAttendancePollMs
});
const speakingCheckWorker = startSpeakingCheckWorker({
  pool: speakingHomeworkPool,
  enabled: config.speakingHomeworkEnabled&&workersEnabled&&!speakingCoordinated
});
const speakingGradeWorker = startSpeakingGradeWorker({
  pool: speakingHomeworkPool,
  enabled: config.speakingHomeworkEnabled&&workersEnabled&&!speakingCoordinated
});
const speakingDoctorWorker = startSpeakingDoctorWorker({
  pool: speakingHomeworkPool,
  enabled: config.speakingHomeworkEnabled&&workersEnabled&&!speakingCoordinated
});
const speakingPracticeWorker = startSpeakingPracticeWorker({
  pool: speakingHomeworkPool,
  enabled: config.speakingHomeworkEnabled&&workersEnabled&&!speakingCoordinated
});
const speakingLegacyWorker=startSpeakingLegacyWorker({pool:speakingHomeworkPool,enabled:config.speakingHomeworkEnabled&&workersEnabled&&speakingCoordinated,
  onError:error=>console.error('Hàng Speaking cũ lỗi:',String(error.code||'SPEAKING_WORKER_ERROR'))});
const speakingCoordinator=speakingHomeworkPool&&speakingCoordinated?startSpeakingWorkCoordinator({pool:speakingHomeworkPool,schema:'speaking_homework',worker:speakingLegacyWorker,
  createClient:()=>new pg.Client({connectionString:config.speakingHomeworkDatabaseUrl,connectionTimeoutMillis:5000,application_name:'speaking_homework_work_listener'}),
  onDocs:()=>{speakingProgressWorker.wake?.();speakingDocsNotifier.kick();},
  onError:error=>console.error('Tín hiệu Speaking cũ lỗi:',String(error.code||'SPEAKING_SIGNAL_ERROR'))}):null;

server.requestTimeout = 15_000;
server.headersTimeout = 16_000;
server.keepAliveTimeout = 5_000;

let shuttingDown;
function shutdown(signal) {
  if(shuttingDown)return shuttingDown;
  const deadline=setTimeout(()=>process.exit(1),240_000).unref();
  return shuttingDown=(async()=>{
  await app.locals.learningLiveUpdates?.close();
  writingNotifier.close();
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await Promise.all([learningAttendanceWorker.stop(),speakingCheckWorker.stop(),speakingGradeWorker.stop(),
      speakingDoctorWorker.stop(),speakingPracticeWorker.stop(),speakingLegacyWorker.stop(),speakingProgressWorker.stop()]);
    await speakingCoordinator?.stop();
    await speakingDocsNotifier.close();
    await Promise.all([pool.end(), learningPool?.end(), speakingHomeworkPool?.end(), learningTestSources?.close()]);
    clearTimeout(deadline);
    process.exit(0);
  })().catch(error=>{console.error('Đóng API chưa hoàn tất:',String(error.code||'SHUTDOWN_FAILED'));process.exit(1);});
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
