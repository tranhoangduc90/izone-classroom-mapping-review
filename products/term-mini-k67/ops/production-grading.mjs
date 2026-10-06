// Nhận một ứng viên đã ghim; chỉ đọc/sửa workflow K67 do task tạo, luôn inactive.
// Kiểm bản trước và đọc lại sau PUT; mất phản hồi giữ unknown để đối soát.
// Không bật lịch/Webhook, không chạy chấm, không in nội dung bài hoặc credential.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { body, hash } from './grading-fixture.mjs';

const PRIVATE = 'E:/Codex-Data/k67-backend-separation-20261006';
const HOSTS = { default: 'https://ducizone.ddns.net', 'izone-ai': 'https://n8n-ai.izone.edu.vn' };
let diagnostic = {};
export async function readInput(stream) {
  // Ghép byte trước giải mã UTF-8: ký tự tiếng Việt có thể bị chia giữa hai chunk.
  const chunks = []; let bytes = 0;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw Error('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function assertOwned(live, own) {
  if (!own || live.id !== own.id || live.name !== own.name || live.active !== false)
    throw Error('PRODUCTION_GRADING_NOT_OWN_INACTIVE');
  if (live.pinData && Object.keys(live.pinData).length) throw Error('PRODUCTION_GRADING_PIN_DATA_CHANGED');
  if (live.settings?.saveDataErrorExecution !== 'all' || live.settings?.saveDataSuccessExecution !== 'all'
    || live.settings?.saveManualExecutions !== true) throw Error('PRODUCTION_GRADING_RETENTION_CHANGED');
}
export function classify(live, before, candidate, own) {
  assertOwned(live, own); assertOwned(before, own); assertOwned(candidate, own);
  if (hash(body(live)) === hash(body(candidate))) return 'candidate';
  if (live.versionId === before.versionId && hash(body(live)) === hash(body(before))) return 'before';
  diagnostic = { live_version: live.versionId, before_version: before.versionId,
    live_body_sha256: hash(body(live)), before_body_sha256: hash(body(before)), candidate_body_sha256: hash(body(candidate)) };
  throw Error('PRODUCTION_GRADING_LIVE_CHANGED');
}
async function run(input) {
  const provision = JSON.parse(await readFile(PRIVATE + '/grading-provision/state.json', 'utf8'));
  const lock = JSON.parse(await readFile(new URL('./grading-source-lock.json', import.meta.url), 'utf8'));
  const pin = lock.workflows.find(row => row.id === input.sourceId && row.profile === input.profile);
  const own = provision.created[input.sourceId];
  if (!pin || !own || own.profile !== input.profile || own.name !== 'K67 · ' + pin.name
    || own.id === pin.id || !own.readback_verified) throw Error('PRODUCTION_GRADING_OWNERSHIP_INVALID');
  const base = 'C:/Users/ADMIN/AppData/Roaming/npm/node_modules/@trngthnh369/n8nctl/dist/lib/';
  const { resolveAuth } = await import(pathToFileURL(base + 'auth.js'));
  const { N8nClient } = await import(pathToFileURL(base + 'api.js'));
  const auth = await resolveAuth({ profile: input.profile });
  if (auth.host.replace(/\/$/, '') !== HOSTS[input.profile]) throw Error('PRODUCTION_GRADING_HOST_CHANGED');
  const client = new N8nClient(auth, { maxRetries: 0, timeout: 30000 });
  const live = await client.get('/workflows/' + own.id);
  assertOwned(live, own);
  if (input.operation === 'snapshot') return { outcome: 'success', workflow: live };
  if (!['inspect', 'update'].includes(input.operation)) throw Error('PRODUCTION_GRADING_OPERATION_INVALID');
  const classification = classify(live, input.before, input.candidate, own);
  if (input.operation === 'update' && classification === 'before') {
    await client.put('/workflows/' + own.id, body(input.candidate));
    const after = await client.get('/workflows/' + own.id);
    if (classify(after, input.before, input.candidate, own) !== 'candidate') throw Error('PRODUCTION_GRADING_READBACK_UNKNOWN');
    return { outcome: 'success', classification: 'candidate', workflow: after };
  }
  return { outcome: 'success', classification, workflow: live };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(await run(await readInput(process.stdin))) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ outcome: 'failure', code: /^[A-Z_]+$/.test(e.message) ? e.message : 'PRODUCTION_GRADING_OPERATION_FAILED',
      error_type: e.name, http_status: Number.isInteger(e.status) ? e.status : null, ...diagnostic }) + '\n');
    process.exitCode = 1;
  }
}
