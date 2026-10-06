import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { changeWriterReadback } from './grading-bundle.mjs';

export const PRODUCT = 'PRODUCT-TERM-MINI-K67';
export const OWN = Object.freeze({
  event: ['default', 'pY437GnW09WmD9b2'],
  poll: ['default', 'qj1aGCo406QsXtai'],
  writer: ['izone-ai', 'nwp6ERqWKb2FkgFl']
});
const JOBS = 'https://ducizone.ddns.net/term-mini-k67-api/api/term-tests/writing-grading/jobs';
const FIXTURE_JOBS = 'http://term-mini-k67-gateway-fixture:8876/term-mini-k67-api/api/term-tests/writing-grading/jobs';
const CALLBACKS = ['Nhận việc chấm', 'Xác nhận đã chấm xong', 'Ghi kết quả vào bài thi',
  'Báo lỗi chấm để thử lại', 'Báo lỗi đọc lưu tạm để thử lại'];
const PORTAL = "=https://gateway.izone.edu.vn/portal/v1/course-classes/{{ $('Xác thực và chuẩn bị dữ liệu').first().json.classId }}/student-tests";
const PORTAL_IDS = ['4414477a-acde-48f5-bca5-6b015e8477f2', 'e261c8a7-0434-40ff-a34c-839756a8d917',
  '33a04bd0-fda2-48f0-8ced-022cabaa34e3', 'f2ece298-2ccc-4b36-86e6-3122bb5d913a', 'b1f8431e-d88c-433f-a640-50e275c30668'];
export function body(w) {
  return Object.fromEntries(['name', 'nodes', 'connections', 'settings'].map(k => [k, w[k]]));
}
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
}
export function hash(x) { return createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex'); }
function requireOwn(role, profile, w) {
  if (!OWN[role] || OWN[role][0] !== profile || OWN[role][1] !== w.id || w.active !== false)
    throw Error('WORKFLOW_NOT_OWN_INACTIVE');
  if (w.settings?.saveDataErrorExecution !== 'all' || w.settings?.saveDataSuccessExecution !== 'all'
    || w.settings?.saveManualExecutions !== true) throw Error('EXECUTION_RETENTION_MISMATCH');
  if (new Set(w.nodes.map(n => n.id)).size !== w.nodes.length) throw Error('DUPLICATE_NODE_ID');
}
export function overlay(w, { role, profile, intent, credential }) {
  // Nhận baseline K67 inactive; chỉ đổi đích callback hoặc năm kết nối Portal giả.
  // Đầu ra giữ nguyên prompt, AI, trigger và ID; sai nguồn thì dừng trước API.
  requireOwn(role, profile, w);
  if (!/^[a-f0-9]{32}$/.test(intent)) throw Error('FIXTURE_INTENT_INVALID');
  const out = structuredClone(w);
  if (role === 'writer') {
    if (!credential || !/^[A-Za-z0-9_-]{8,128}$/.test(credential.id)
      || credential.name !== 'K67 · Khóa Portal giả để diễn tập') throw Error('FIXTURE_CREDENTIAL_INVALID');
    const http = out.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest');
    if (hash(http.map(n => n.id).sort()) !== hash([...PORTAL_IDS].sort())) throw Error('PORTAL_INVENTORY_CHANGED');
    for (const n of http) {
      if (n.parameters.url !== PORTAL || n.parameters.authentication !== 'genericCredentialType'
        || n.parameters.genericAuthType !== 'oAuth2Api' || Object.keys(n.credentials ?? {}).join() !== 'oAuth2Api'
        || n.credentials.oAuth2Api.id !== '5t3dhy3tWIoPzmXc') throw Error('PORTAL_BASELINE_CHANGED');
      n.parameters.url = PORTAL.replace('https://gateway.izone.edu.vn/portal/v1/course-classes/',
        `https://ducizone.ddns.net:18868/k67-portal-fixture/${intent}/`);
      n.parameters.genericAuthType = 'httpHeaderAuth';
      n.credentials = { httpHeaderAuth: structuredClone(credential) };
    }
  } else {
    const nodes = out.nodes.filter(n => CALLBACKS.includes(n.name));
    if (nodes.length !== 5 || new Set(nodes.map(n => n.name)).size !== 5) throw Error('CALLBACK_INVENTORY_CHANGED');
    for (const n of nodes) {
      const code = n.parameters?.jsCode;
      if (n.type !== 'n8n-nodes-base.code' || typeof code !== 'string' || code.split(JOBS).length !== 2)
        throw Error('CALLBACK_BASELINE_CHANGED');
      n.parameters.jsCode = code.replace(JOBS, FIXTURE_JOBS);
    }
  }
  return out;
}
export function classifyLive(live, before, candidate, role, profile) {
  requireOwn(role, profile, live);
  if (hash(body(live)) === hash(body(candidate))) return 'candidate';
  if (hash(body(live)) === hash(body(before)) && live.versionId === before.versionId) return 'before';
  throw Error('LIVE_CHANGED_NO_OVERWRITE');
}

export function repairWriterReadback(workflow) {
  // Chỉ vá Code đọc lại của writer K67 inactive; giữ toàn đích Portal/khóa/graph.
  requireOwn('writer', 'izone-ai', workflow);
  const result = structuredClone(workflow);
  const nodes = result.nodes.filter(n => n.name === 'Kiểm tra kết quả ghi' && n.type === 'n8n-nodes-base.code');
  if (nodes.length !== 1) throw Error('WRITER_READBACK_NODE_CHANGED');
  nodes[0].parameters.jsCode = changeWriterReadback(nodes[0].parameters.jsCode);
  return result;
}

let diagnostic = {};
async function sdk(input) {
  // SDK đã pin nhận secret qua stdin; chỉ trả metadata/boolean, không trả giá trị khóa.
  const base = 'C:/Users/ADMIN/AppData/Roaming/npm/node_modules/@trngthnh369/n8nctl/dist/lib/';
  const { resolveAuth } = await import(pathToFileURL(base + 'auth.js'));
  const { N8nClient } = await import(pathToFileURL(base + 'api.js'));
  const hosts = { default: 'https://ducizone.ddns.net', 'izone-ai': 'https://n8n-ai.izone.edu.vn' };
  if (!hosts[input.profile]) throw Error('PROFILE_NOT_ALLOWED');
  diagnostic = { operation: input.operation, profile: input.profile };
  const auth = await resolveAuth({ profile: input.profile });
  if (auth.host.replace(/\/$/, '') !== hosts[input.profile]) throw Error('PROFILE_HOST_MISMATCH');
  const client = new N8nClient(auth, { maxRetries: 0, timeout: 30000 });
  if (input.operation === 'start-notification') {
    // Mô phỏng đúng một tín hiệu trong manual execution native; không sửa workflow.
    // Chỉ parent event K67 inactive; ACK trả ID ngay, lỗi giữ journal để đối soát.
    if (input.profile !== 'default' || input.role !== 'event') throw Error('NOTIFICATION_SCOPE_INVALID');
    requireOwn(input.role, input.profile, input.candidate);
    if (input.candidate.id !== OWN.event[1]) throw Error('OWN_ID_MISMATCH');
    const live = await client.get('/workflows/' + input.candidate.id);
    requireOwn(input.role, input.profile, live);
    if (live.versionId !== input.expectedVersion || hash(body(live)) !== hash(body(input.candidate)))
      throw Error('LIVE_CHANGED_NO_OVERWRITE');
    const { resolveSession } = await import(pathToFileURL(base + 'auth.js'));
    const { N8nSessionClient } = await import(pathToFileURL(base + 'session-api.js'));
    const session = await resolveSession({ profile: 'default' });
    if (session.host.replace(/\/$/, '') !== hosts.default) throw Error('PROFILE_HOST_MISMATCH');
    const service = new N8nSessionClient(session, { maxRetries: 0, timeout: 30000 });
    await service.ensureSession();
    const name = 'Nhận thông báo bài Term Test sẵn sàng';
    const guard = 'Kiểm tra thông báo, không nhận bài từ Webhook';
    if (live.nodes.filter(n => n.name === name && n.type === 'n8n-nodes-base.webhook').length !== 1 ||
      live.nodes.filter(n => n.name === guard && n.type === 'n8n-nodes-base.code').length !== 1)
      throw Error('NOTIFICATION_GRAPH_CHANGED');
    const response = await service.req({ method: 'POST', url: '/workflows/' + live.id + '/run', data: {
      workflowData: live, startNodes: [{ name: guard }], triggerToStartFrom: { name, data: {
        startTime: Date.now(), executionTime: 0, executionIndex: 0, source: [],
        data: { main: [[{ json: { body: { kind: 'term_test_writing_ready' }, query: {} } }]] }
      } }
    } });
    if (!/^[0-9]+$/.test(String(response.data?.executionId ?? '')) || response.data?.waitingForWebhook)
      throw Error('NOTIFICATION_START_OUTCOME_UNKNOWN');
    return { outcome: 'success', workflowId: live.id, executionId: String(response.data.executionId),
      trigger_input: 'manual_notification_simulation' };
  }
  if (input.operation === 'node-descriptions') {
    // Chỉ đọc schema của parent K67 đã ghim; không trả toàn catalog hoặc secret.
    if (input.profile !== 'default' || !['event', 'poll'].includes(input.role)) throw Error('DESCRIPTION_SCOPE_INVALID');
    requireOwn(input.role, input.profile, input.candidate);
    if (input.candidate.id !== OWN[input.role][1]) throw Error('OWN_ID_MISMATCH');
    const live = await client.get('/workflows/' + input.candidate.id);
    requireOwn(input.role, input.profile, live);
    if (live.versionId !== input.expectedVersion || hash(body(live)) !== hash(body(input.candidate)))
      throw Error('LIVE_CHANGED_NO_OVERWRITE');
    const { resolveSession } = await import(pathToFileURL(base + 'auth.js'));
    const { N8nSessionClient } = await import(pathToFileURL(base + 'session-api.js'));
    const session = await resolveSession({ profile: input.profile });
    if (session.host.replace(/\/$/, '') !== hosts[input.profile]) throw Error('PROFILE_HOST_MISMATCH');
    const catalog = await new N8nSessionClient(session, { maxRetries: 0, timeout: 30000 }).getRootJson('/types/nodes.json');
    if (!Array.isArray(catalog)) throw Error('NODE_CATALOG_INVALID');
    const descriptions = catalog.filter(d => input.candidate.nodes.some(n => n.type === d.name &&
      (Array.isArray(d.version) ? d.version.includes(n.typeVersion) : d.version === n.typeVersion)));
    for (const n of input.candidate.nodes) if (descriptions.filter(d => n.type === d.name &&
      (Array.isArray(d.version) ? d.version.includes(n.typeVersion) : d.version === n.typeVersion)).length !== 1)
      throw Error('NODE_DESCRIPTION_NOT_UNIQUE');
    return { outcome: 'success', descriptions, descriptions_sha256: hash(descriptions) };
  }
  if (input.operation === 'variable') {
    if (input.profile !== 'izone-ai' || input.key !== 'K67_ERP_SYNC_SECRET'
      || !/^[A-Za-z0-9_-]{40,100}$/.test(input.value)) throw Error('VARIABLE_SCOPE_INVALID');
    const matches = [];
    for await (const row of client.paginate('/variables', { limit: 100 })) if (row.key === input.key) matches.push(row);
    if (matches.length > 1 || matches.some(r => r.value !== input.value)) throw Error('VARIABLE_COLLISION');
    if (!matches.length && input.create === true) {
      await client.post('/variables', { key: input.key, value: input.value });
      const read = [];
      for await (const row of client.paginate('/variables', { limit: 100 })) if (row.key === input.key) read.push(row);
      if (read.length !== 1 || read[0].value !== input.value) throw Error('VARIABLE_READBACK_UNKNOWN');
      return { outcome: 'success', matched: true, id: read[0].id };
    }
    return { outcome: 'success', matched: matches.length === 1, id: matches[0]?.id ?? null };
  }
  if (input.operation === 'source-versions') {
    if (!Array.isArray(input.sources) || input.sources.length < 1) throw Error('SOURCE_INVENTORY_INVALID');
    const result = {};
    for (const pin of input.sources) {
      diagnostic.source_id = pin.id;
      const w = await client.get('/workflows/' + encodeURIComponent(pin.id));
      if (w.id !== pin.id || w.name !== pin.name) throw Error('SOURCE_IDENTITY_CHANGED');
      result[input.profile + ':' + w.id] = { id: w.id, name: w.name, versionId: w.versionId, active: w.active };
    }
    return { outcome: 'success', versions: result };
  }
  if (input.operation === 'inspect' || input.operation === 'active') {
    // Nhận candidate đã ghim của workflow thuộc task; không trả node hay credential.
    // Chỉ writer được bật để gọi Webhook Portal giả, parent luôn giữ inactive.
    const [profile, id] = OWN[input.role] ?? [];
    if (profile !== input.profile || id !== input.candidate?.id) throw Error('OWN_ID_MISMATCH');
    requireOwn(input.role, profile, input.candidate);
    let live = await client.get('/workflows/' + id);
    requireOwn(input.role, profile, { ...live, active: false });
    if (hash(body(live)) !== hash(body(input.candidate))) throw Error('LIVE_CHANGED_NO_OVERWRITE');
    if (input.expectedVersion && input.expectedVersion !== live.versionId) throw Error('LIVE_VERSION_CHANGED');
    if (input.operation === 'active') {
      if (input.role !== 'writer' || typeof input.active !== 'boolean') throw Error('ACTIVATION_NOT_ALLOWED');
      if (live.active !== input.active) {
        await client.post('/workflows/' + id + (input.active ? '/activate' : '/deactivate'));
        live = await client.get('/workflows/' + id);
      }
      if (live.active !== input.active || hash(body(live)) !== hash(body(input.candidate)))
        throw Error('ACTIVATION_READBACK_UNKNOWN');
    }
    return { outcome: 'success', id, name: live.name, versionId: live.versionId, active: live.active,
      body_sha256: hash(body(live)) };
  }
  if (input.operation === 'workflow') {
    const [profile, id] = OWN[input.role] ?? [];
    if (profile !== input.profile || id !== input.before?.id || id !== input.candidate?.id) throw Error('OWN_ID_MISMATCH');
    requireOwn(input.role, profile, input.before); requireOwn(input.role, profile, input.candidate);
    const live = await client.get('/workflows/' + id);
    const classification = classifyLive(live, input.before, input.candidate, input.role, profile);
    if (input.update && classification === 'before') {
      await client.put('/workflows/' + id, body(input.candidate));
      const after = await client.get('/workflows/' + id);
      if (classifyLive(after, input.before, input.candidate, input.role, profile) !== 'candidate')
        throw Error('WORKFLOW_UPDATE_READBACK_UNKNOWN');
      return { outcome: 'success', classification: 'candidate', versionId: after.versionId, body_sha256: hash(body(after)) };
    }
    return { outcome: 'success', classification, versionId: live.versionId, body_sha256: hash(body(live)) };
  }
  throw Error('SDK_OPERATION_NOT_ALLOWED');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = ''; for await (const part of process.stdin) { raw += part; if (raw.length > 4 * 1024 * 1024) throw Error('INPUT_TOO_LARGE'); }
    const input = JSON.parse(raw);
    const result = input.operation === 'overlay' ? overlay(input.workflow, input.options)
      : input.operation === 'repair-writer-readback' ? repairWriterReadback(input.workflow)
      : input.operation === 'hash-body' ? { body_sha256: hash(body(input.workflow)) } : await sdk(input);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    // Không in exception HTTP vì nó có thể chứa header, cookie hoặc bài viết.
    process.stderr.write(JSON.stringify({ outcome: 'failure', code: /^[A-Z_]+$/.test(e.message) ? e.message : 'SDK_OPERATION_FAILED',
      error_type: e.name, http_status: Number.isInteger(e.status) ? e.status : Number.isInteger(e.statusCode) ? e.statusCode : null,
      ...diagnostic }) + '\n');
    process.exitCode = 1;
  }
}
