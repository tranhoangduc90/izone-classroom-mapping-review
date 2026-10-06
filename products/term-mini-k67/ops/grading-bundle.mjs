// Nhận snapshot đã ghim và bảng đích K67; dựng định nghĩa mới trong bộ nhớ.
// Không gọi API, không bật workflow, không ghi điểm. Thiếu/sai đích làm dừng bằng mã K67_BUNDLE_*.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import infrastructure from './shared-infrastructure-bindings.json' with { type: 'json' };

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OLD_BACKEND = 'https://ducizone.ddns.net/mapping-api/api/term-tests/writing-grading/jobs';
export const K67_BACKEND = 'https://ducizone.ddns.net/term-mini-k67-api/api/term-tests/writing-grading/jobs';
export const K67_PRODUCTION_API = 'https://ducizone.ddns.net:18869/term-mini-k67-api';
export const OLD_CACHE = 'termtest:writing:direct:';
export const K67_CACHE = 'termmini:k67:writing:direct:';
const OLD_SECRET_KEY = 'writing:test:sync_secret';
const K67_SECRET_KEY = 'termmini:k67:sync_secret';
const WRITER = 'NFgOTzvfzfjwqY9x';
const fail = code => { throw new Error('K67_BUNDLE_' + code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function pinnedInfrastructure(profile, source, node, kind, credential, binding) {
  // Chỉ dùng lại đúng quyền gọi AI/Portal đã ghim; không nhận allowlist từ caller.
  return infrastructure.schema_version === 1 && infrastructure.product_id === 'PRODUCT-TERM-MINI-K67'
    && infrastructure.bindings.some(pin => pin.profile === profile && pin.workflowId === source.id
      && pin.sourceVersionId === source.versionId && pin.nodeId === node.id && pin.nodeType === node.type
      && pin.url === node.parameters.url && pin.kind === kind
      && pin.credential.id === credential.id && pin.credential.name === credential.name
      && binding.id === credential.id && binding.name === credential.name);
}

export async function loadPinnedWorkflows(lock) {
  if (lock?.schema_version !== 1 || lock.product_id !== 'PRODUCT-TERM-MINI-K67'
    || !Array.isArray(lock.workflows) || !lock.workflows.length) fail('LOCK_INVALID');
  const seen = new Set();
  const sources = [];
  for (const pin of lock.workflows) {
    if (!ID.test(pin.id) || seen.has(pin.id) || !['default', 'izone-ai'].includes(pin.profile)) fail('PIN_ID_INVALID');
    seen.add(pin.id);
    const bytes = await readFile(pin.path);
    if (sha256(bytes) !== pin.sha256) fail('SOURCE_HASH_MISMATCH');
    const workflow = JSON.parse(bytes.toString('utf8'));
    if (workflow.id !== pin.id || workflow.name !== pin.name || workflow.versionId !== pin.versionId) fail('SOURCE_IDENTITY_MISMATCH');
    sources.push({ profile: pin.profile, workflow });
  }
  return sources;
}

function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, transform));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]));
  return value;
}

function changeWriterAuthorization(code) {
  const required = [
    ['String($vars.TERM_TEST_ERP_SYNC_SECRET ?? \'\')', 'String($vars.K67_ERP_SYNC_SECRET ?? \'\')'],
    ['String($vars.WRITING_TEST_SYNC_SECRET ?? \'\')', "String('')"],
    ['String($vars.WRITING_TEST_MAPPING_SYNC_SECRET ?? \'\')', "String('')"],
  ];
  for (const [before, after] of required) {
    if (code.split(before).length !== 2) fail('WRITER_AUTH_BASELINE_CHANGED');
    code = code.replace(before, after);
  }
  return code;
}

export function changeWriterReadback(code) {
  // Đọc đúng ô đã ghi: không ép ô trống/boolean/array thành điểm 0.
  // Giữ điểm số hoặc chuỗi số có nội dung; khác baseline thì dừng dựng.
  const before = 'if (!classTest || !gradeRow || Number(gradeRow.grade) !== Number(expectedGrade)) {';
  const after = `const readbackGrade = gradeRow?.grade;
  const hasNumericGrade = (typeof readbackGrade === 'number' ||
    (typeof readbackGrade === 'string' && readbackGrade.trim() !== '')) &&
    Number.isFinite(Number(readbackGrade));
  if (!classTest || !gradeRow || !hasNumericGrade || Number(readbackGrade) !== Number(expectedGrade)) {`;
  if (typeof code !== 'string' || code.split(before).length !== 2) fail('WRITER_READBACK_BASELINE_CHANGED');
  return code.replace(before, after);
}

export function buildGradingBundle(sources, target) {
  if (!Array.isArray(sources) || !sources.length || !target?.workflowIds) fail('INPUT_INVALID');
  // Bản production dùng HTTPS/cổng riêng; mặc định cũ giữ cho artifact diễn tập
  // đã ghim. Không nhận URL tùy ý để tránh gửi bài/khóa sang đích ngoài K67.
  if (target.apiBaseUrl !== undefined && target.apiBaseUrl !== K67_PRODUCTION_API) fail('BACKEND_TARGET_INVALID');
  const backend = target.apiBaseUrl ? target.apiBaseUrl + '/api/term-tests/writing-grading/jobs' : K67_BACKEND;
  const oldIds = new Set(sources.map(s => s.workflow.id));
  if (oldIds.size !== sources.length) fail('DUPLICATE_SOURCE');
  const newIds = new Set();
  const profileById = new Map(sources.map(s => [s.workflow.id, s.profile]));
  const oldCredentials = new Set(sources.flatMap(({ profile, workflow }) =>
    workflow.nodes.flatMap(node => Object.entries(node.credentials ?? {})
      .map(([kind, credential]) => profile + ':' + kind + ':' + credential.id))));
  for (const { workflow } of sources) {
    const nextId = target.workflowIds[workflow.id];
    if (!ID.test(nextId ?? '') || oldIds.has(nextId) || newIds.has(nextId)) fail('DESTINATION_ID_INVALID');
    newIds.add(nextId);
  }
  const webhookPaths = new Set();
  const webhookIds = new Set();
  const result = [];
  for (const { profile, workflow: before } of sources) {
    const errorId = target.errorWorkflowIds?.[profile];
    if (!ID.test(errorId ?? '') || oldIds.has(errorId) || newIds.has(errorId)
      || errorId === before.settings?.errorWorkflow) fail('ERROR_WORKFLOW_INVALID');
    if (!Array.isArray(before.nodes) || !before.nodes.length || !before.connections) fail('SOURCE_SHAPE_INVALID');
    const workflow = {
      id: target.workflowIds[before.id], name: 'K67 · ' + before.name,
      active: false, nodes: structuredClone(before.nodes), connections: structuredClone(before.connections),
      settings: { ...before.settings, errorWorkflow: errorId, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', saveManualExecutions: true },
    };
    for (const node of workflow.nodes) {
      // Chỉ đổi các địa chỉ/khóa hạ tầng đã xác minh, giữ nguyên tên node và liên kết item.
      node.parameters = mapStrings(node.parameters, value => value
        .replaceAll(OLD_BACKEND, backend)
        .replaceAll(OLD_CACHE, K67_CACHE)
        .replaceAll('termtest:writing:parity:', 'termmini:k67:writing:parity:')
        .replaceAll(OLD_SECRET_KEY, K67_SECRET_KEY)
        .replaceAll('gemini:api_key', 'termmini:k67:ai:gemini:api_key')
        .replaceAll('term-test-writing-event:', 'term-mini-k67-writing-event:'));
      if (node.type === 'n8n-nodes-base.executeWorkflow') {
        const ref = node.parameters.workflowId;
        const oldId = typeof ref === 'string' ? ref : ref?.value;
        if (!oldIds.has(oldId) || profileById.get(oldId) !== profile) fail('CHILD_OUTSIDE_PINNED_GRAPH');
        const id = target.workflowIds[oldId];
        node.parameters.workflowId = typeof ref === 'string' ? id : { __rl: true, value: id, mode: 'id' };
      }
      if (node.type === 'n8n-nodes-base.redis') {
        const key = node.parameters.key;
        // Khóa động chỉ lấy từ hai kết quả đã giữ identity; không nhận biểu thức tùy ý.
        const dynamicKeys = ['={{ $json.cacheKey }}', '={{ $json.checkpointKey }}', "={{ '" + K67_CACHE + "' + $json.runKey }}"];
        if (typeof key !== 'string' || (!key.startsWith('termmini:k67:') && !dynamicKeys.includes(key))) fail('REDIS_KEY_OUTSIDE_K67');
      }
      for (const [kind, credential] of Object.entries(node.credentials ?? {})) {
        const binding = target.credentials?.[profile + ':' + kind + ':' + credential.id];
        if (!ID.test(binding?.id ?? '') || typeof binding?.name !== 'string' || !binding.name.trim()
          || (oldCredentials.has(profile + ':' + kind + ':' + binding.id)
            && !pinnedInfrastructure(profile, before, node, kind, credential, binding))) fail('CREDENTIAL_BINDING_MISSING');
        node.credentials[kind] = { id: binding.id, name: binding.name };
      }
      if (node.type === 'n8n-nodes-base.webhook') {
        const hook = target.webhooks?.[before.id + ':' + node.id];
        if (!hook || !UUID.test(hook.webhookId ?? '') || hook.webhookId === node.webhookId
          || !/^term-mini-k67-[a-z0-9-]{8,100}$/.test(hook.path ?? '')
          || webhookPaths.has(profile + ':' + hook.path) || webhookIds.has(hook.webhookId)) fail('WEBHOOK_TARGET_INVALID');
        webhookPaths.add(profile + ':' + hook.path);
        webhookIds.add(hook.webhookId);
        node.webhookId = hook.webhookId;
        node.parameters.path = hook.path;
      }
      if (before.id === WRITER && node.name === 'Xác thực và chuẩn bị dữ liệu') {
        node.parameters.jsCode = changeWriterAuthorization(node.parameters.jsCode);
      }
      if (before.id === WRITER && node.name === 'Kiểm tra kết quả ghi') {
        node.parameters.jsCode = changeWriterReadback(node.parameters.jsCode);
      }
    }
    const serialized = JSON.stringify(workflow);
    if ([...oldIds].some(id => serialized.includes(id))) fail('OLD_WORKFLOW_REFERENCE_REMAINS');
    if ([OLD_BACKEND, 'termtest:writing:', OLD_SECRET_KEY, '/mapping-api/', '$vars.TERM_TEST_ERP_SYNC_SECRET',
      '$vars.WRITING_TEST_SYNC_SECRET', '$vars.WRITING_TEST_MAPPING_SYNC_SECRET'].some(value => serialized.includes(value))) fail('SHARED_REFERENCE_REMAINS');
    result.push({ profile, sourceId: before.id, sourceVersionId: before.versionId, workflow });
  }
  return result;
}
