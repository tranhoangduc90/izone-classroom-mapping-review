// Đầu vào: bản source đọc từ đúng image API đang chạy và source Journey đã kiểm thử.
// Việc chính: kiểm mã băm, ghép đúng các điểm tích hợp và tạo thư mục build riêng.
// Kết quả: Docker overlay giữ các sửa đổi production khác; lỗi hash/anchor sẽ dừng build.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [liveInput, backendInput, outputInput] = process.argv.slice(2);
if (!liveInput || !backendInput || !outputInput) {
  throw new Error('Cần live-source, backend và thư mục output.');
}
const live = resolve(liveInput);
const backend = resolve(backendInput);
const output = resolve(outputInput);
const expected = {
  'app.js': '1c34d61a44fe7124ef04eb87f64f804e81191547e79c4e8a8225ef8042567141',
  'config.js': '065fcca9abd238f47d82b052155fa5790b083d4d27235ea579136c910f4dcb38',
  'learning-routes.js': '4173b2beccad28dc2b5d1b40650f23c9fc70786dd81e53eb8af386253b35a35c',
  'learning-service.js': '1dfbb7ae672b0085a17840730dc14b38ff1b57c9e2d1583157623141149907d6',
  'learning-sql.js': '33499d8ca6d2b4029d17e0a49c7505a4bf541ec0351665cef20a5275c1bf60bd',
  'auth.js': 'af50eac4d39f0c0c4e9c5042e672b3fbd34d52a18e9f094072e0d8451858394b',
  'server.js': '5aa0068436adfaf1b1ea1b815ffa59a5c5011d6bf7ae045415fc181c182234e5',
  'learning-attendance-worker.js': 'fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d'
};
const hash = data => createHash('sha256').update(data).digest('hex');
for (const [file, digest] of Object.entries(expected)) {
  const bytes = await readFile(join(live, 'src', file));
  if (hash(bytes) !== digest) throw new Error(`Image nền đã đổi: ${file}`);
}
function replaceOne(source, oldText, newText, label) {
  const pieces = source.split(oldText);
  if (pieces.length !== 2) throw new Error(`Điểm ghép không duy nhất: ${label}`);
  return pieces.join(newText);
}
const normalized = data => data.toString('utf8').replace(/\r\n/g, '\n');
let app = normalized(await readFile(join(live, 'src', 'app.js')));
app = replaceOne(app,
  "import { createLearningRouter } from './learning-routes.js';",
  "import { createLearningRouter } from './learning-routes.js';\nimport { createLearningErpScheduleReader } from './learning-erp-schedule.js';\nimport { createLearningTestSourceReader } from './learning-test-sources.js';\nimport { createLearningTestResultReader } from './learning-test-results.js';",
  'app imports');
app = replaceOne(app, '  learningPool = null,\n  speakingHomeworkPool = null,',
  '  learningPool = null,\n  learningErpScheduleReader = null,\n  speakingHomeworkPool = null,',
  'app dependency injection');
app = replaceOne(app,
  "  if (config.learningEnabled) {\n    app.use('/api/learning', (req, res, next) => {",
  "  if (config.learningEnabled) {\n    const scheduleReader = learningErpScheduleReader ?? createLearningErpScheduleReader({\n      url: config.learningErpScheduleMetabaseUrl,\n      username: config.learningErpScheduleMetabaseUsername,\n      password: config.learningErpScheduleMetabasePassword,\n      timeoutMs: config.learningErpScheduleTimeoutMs\n    });\n    app.use('/api/learning', (req, res, next) => {",
  'app ERP reader');
app = replaceOne(app,
  '      pool: learningPool, authenticate, demoSourceSecret: config.learningDemoSourceSecret\n',
  '      pool: learningPool, authenticate, demoSourceSecret: config.learningDemoSourceSecret,\n      erpScheduleReader: scheduleReader,\n      testSourceReader: createLearningTestSourceReader({ pool }),\n      testResultReader: createLearningTestResultReader({ pool })\n',
  'app Journey readers');
let config = normalized(await readFile(join(live, 'src', 'config.js')));
config = replaceOne(config,
  "  LEARNING_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(20),",
  "  LEARNING_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(20),\n  LEARNING_ERP_SCHEDULE_METABASE_URL: z.union([z.literal(''), z.url()]).default(''),\n  LEARNING_ERP_SCHEDULE_METABASE_USERNAME: z.string().optional().default(''),\n  LEARNING_ERP_SCHEDULE_METABASE_PASSWORD: z.string().optional().default(''),\n  LEARNING_ERP_SCHEDULE_TIMEOUT_MS: z.coerce.number().int().min(2000).max(15000).default(7000),",
  'config schema');
config = replaceOne(config,
  '}).superRefine((value, context) => {\n  if (Boolean(value.ERP_SYNC_URL)',
  "}).superRefine((value, context) => {\n  const scheduleFields = [value.LEARNING_ERP_SCHEDULE_METABASE_URL,\n    value.LEARNING_ERP_SCHEDULE_METABASE_USERNAME, value.LEARNING_ERP_SCHEDULE_METABASE_PASSWORD];\n  if (scheduleFields.some(Boolean) && !scheduleFields.every(Boolean)) {\n    context.addIssue({ code: 'custom', message: 'Cấu hình đọc lịch ERP phải có đủ URL, tài khoản và mật khẩu.' });\n  }\n  if (value.LEARNING_ERP_SCHEDULE_METABASE_URL\n    && !value.LEARNING_ERP_SCHEDULE_METABASE_URL.startsWith('https://')) {\n    context.addIssue({ code: 'custom', message: 'Nguồn lịch ERP phải dùng HTTPS.' });\n  }\n  if (Boolean(value.ERP_SYNC_URL)",
  'config validation');
config = replaceOne(config,
  '    learningDbPoolMax: parsed.LEARNING_DB_POOL_MAX,\n',
  '    learningDbPoolMax: parsed.LEARNING_DB_POOL_MAX,\n    learningErpScheduleMetabaseUrl: parsed.LEARNING_ERP_SCHEDULE_METABASE_URL,\n    learningErpScheduleMetabaseUsername: parsed.LEARNING_ERP_SCHEDULE_METABASE_USERNAME,\n    learningErpScheduleMetabasePassword: parsed.LEARNING_ERP_SCHEDULE_METABASE_PASSWORD,\n    learningErpScheduleTimeoutMs: parsed.LEARNING_ERP_SCHEDULE_TIMEOUT_MS,\n',
  'config return');
await mkdir(join(output, 'src'), { recursive: true });
await writeFile(join(output, 'src', 'app.js'), app, 'utf8');
await writeFile(join(output, 'src', 'config.js'), config, 'utf8');
const copyModules = [
  'learning-routes.js', 'learning-service.js', 'learning-sql.js',
  'learning-erp-schedule.js', 'learning-test-sources.js', 'learning-test-results.js'
];
for (const file of copyModules) {
  await cp(join(backend, 'src', file), join(output, 'src', file));
}
await cp(join(import.meta.dirname, 'Dockerfile'), join(output, 'Dockerfile'));
const result = { baseHashes: expected, overlayHashes: {} };
for (const file of ['app.js', 'config.js', ...copyModules]) {
  result.overlayHashes[file] = hash(await readFile(join(output, 'src', file)));
}
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`overlay_ready modules=${Object.keys(result.overlayHashes).length}\n`);
