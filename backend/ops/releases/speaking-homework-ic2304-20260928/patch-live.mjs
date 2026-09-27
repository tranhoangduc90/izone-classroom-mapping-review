import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = process.env.RELEASE_APP_ROOT || '/app';
const expected = {
  // Hash của bốn file lõi trong image đang phục vụ production; sai hash thì dừng build.
  'app.js': '7b20a0f69774de7c5815723ee2a19c072718bd0ca5417de6815d9c544b957b4f',
  'config.js': '480ded5edd2654cd3e82ee280cf8b8807f1fa3b78980f0a104727098fa850661',
  'server.js': '6ecf0f6cde32a636df96ac367cc8695a22160b3200274ac9c57e64e29641feb9'
};
function replaceOnce(text, oldText, newText, name) {
  const first = text.indexOf(oldText);
  if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Không tìm thấy duy nhất điểm ghép ${name}.`);
  }
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}
function patch(name, edits) {
  const file = `${root}/src/${name}`;
  let value = readFileSync(file, 'utf8');
  const actual = createHash('sha256').update(value).digest('hex');
  if (actual !== expected[name]) throw new Error(`Image gốc thay đổi: ${name}.`);
  value = value.replace(/\r\n/g, '\n');
  for (const [oldText, newText, label] of edits) value = replaceOnce(value, oldText, newText, label);
  writeFileSync(file, value, 'utf8');
}

patch('app.js', [
  ["import { createLearningRouter } from './learning-routes.js';",
    "import { createLearningRouter } from './learning-routes.js';\nimport { createSpeakingHomeworkRouter } from './speaking-homework-routes.js';", 'app-import'],
  ['  learningPool = null,\n  verifyGoogleToken,',
    '  learningPool = null,\n  speakingHomeworkPool = null,\n  verifyGoogleToken,', 'app-pool'],
  ["  const sendAuthenticatedReviewer = (req, res) => {",
    "  if (config.speakingHomeworkEnabled && !speakingHomeworkPool) {\n    throw new Error('SPEAKING_HOMEWORK_ENABLED cần database pool riêng.');\n  }\n  if (config.speakingHomeworkEnabled) {\n    app.use('/api/speaking-homework', createSpeakingHomeworkRouter({\n      pool: speakingHomeworkPool,\n      workerSecret: config.speakingHomeworkWorkerSecret,\n      accessSecret: config.speakingHomeworkAccessSecret,\n      authenticate\n    }));\n  }\n  const sendAuthenticatedReviewer = (req, res) => {", 'app-router']
]);

patch('config.js', [
  ["  LEARNING_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(20),",
    "  LEARNING_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(20),\n  SPEAKING_HOMEWORK_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),\n  SPEAKING_HOMEWORK_DATABASE_URL: z.string().optional().default(''),\n  SPEAKING_HOMEWORK_DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),\n  SPEAKING_HOMEWORK_WORKER_SECRET: z.string().optional().default(''),\n  SPEAKING_HOMEWORK_ACCESS_SECRET: z.string().optional().default(''),", 'config-schema'],
  ["  if (value.LEARNING_ENABLED && !value.LEARNING_DATABASE_URL) {\n    context.addIssue({ code: 'custom', path: ['LEARNING_DATABASE_URL'], message: 'LEARNING_DATABASE_URL là bắt buộc khi bật Progress Log.' });\n  }",
    "  if (value.LEARNING_ENABLED && !value.LEARNING_DATABASE_URL) {\n    context.addIssue({ code: 'custom', path: ['LEARNING_DATABASE_URL'], message: 'LEARNING_DATABASE_URL là bắt buộc khi bật Progress Log.' });\n  }\n  if (value.SPEAKING_HOMEWORK_ENABLED && (!value.SPEAKING_HOMEWORK_DATABASE_URL || value.SPEAKING_HOMEWORK_WORKER_SECRET.length < 32 || value.SPEAKING_HOMEWORK_ACCESS_SECRET.length < 32)) {\n    context.addIssue({ code: 'custom', path: ['SPEAKING_HOMEWORK_ENABLED'], message: 'Speaking Homework cần database và hai secret riêng.' });\n  }", 'config-validation'],
  ["    learningDbPoolMax: parsed.LEARNING_DB_POOL_MAX,",
    "    learningDbPoolMax: parsed.LEARNING_DB_POOL_MAX,\n    speakingHomeworkEnabled: parsed.SPEAKING_HOMEWORK_ENABLED,\n    speakingHomeworkDatabaseUrl: parsed.SPEAKING_HOMEWORK_DATABASE_URL,\n    speakingHomeworkDbPoolMax: parsed.SPEAKING_HOMEWORK_DB_POOL_MAX,\n    speakingHomeworkWorkerSecret: parsed.SPEAKING_HOMEWORK_WORKER_SECRET,\n    speakingHomeworkAccessSecret: parsed.SPEAKING_HOMEWORK_ACCESS_SECRET,", 'config-output']
]);

patch('server.js', [
  ["import { createDatabasePool, createLearningDatabasePool } from './db.js';",
    "import { createDatabasePool, createLearningDatabasePool, createSpeakingHomeworkDatabasePool } from './db.js';", 'server-db'],
  ["import { createTermTestWritingGradingService } from './term-test-writing-grading.js';",
    "import { createTermTestWritingGradingService } from './term-test-writing-grading.js';\nimport { startSpeakingCheckWorker } from './speaking-check-worker.js';\nimport { startSpeakingGradeWorker } from './speaking-grade-worker.js';", 'server-import'],
  ["const learningPool = config.learningEnabled ? createLearningDatabasePool(config) : null;",
    "const learningPool = config.learningEnabled ? createLearningDatabasePool(config) : null;\nconst speakingHomeworkPool = config.speakingHomeworkEnabled ? createSpeakingHomeworkDatabasePool(config) : null;", 'server-pool'],
  ["  learningPool,\n  syncErpGrades,",
    "  learningPool,\n  speakingHomeworkPool,\n  syncErpGrades,", 'server-app'],
  ["server.requestTimeout = 15_000;",
    "const speakingCheckWorker = startSpeakingCheckWorker({\n  pool: speakingHomeworkPool, enabled: config.speakingHomeworkEnabled\n});\nconst speakingGradeWorker = startSpeakingGradeWorker({\n  pool: speakingHomeworkPool, enabled: config.speakingHomeworkEnabled\n});\n\nserver.requestTimeout = 15_000;", 'server-workers'],
  ["    await Promise.all([pool.end(), learningPool?.end()]);",
    "    await speakingCheckWorker.stop();\n    await speakingGradeWorker.stop();\n    await Promise.all([pool.end(), learningPool?.end(), speakingHomeworkPool?.end()]);", 'server-shutdown']
]);
