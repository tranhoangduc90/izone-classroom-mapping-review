import { requireValue, UUID } from '../../src/contract.mjs';

export const miniK56CbtProduct = 'term-mini-k56';
export const miniK56CbtSlug = 'mini-test-k56';
const sections = new Set(['listening', 'reading', 'writing']);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function checkOfflineReceipt(event, scope) {
  const { data } = event;
  const state = data?.checkpointState;
  requireValue(scope.product === miniK56CbtProduct && scope.testSlug === miniK56CbtSlug
    && event.source === 'server' && event.type === 'submission_committed'
    && event.build === 'k56-mini-cbt-native-receipt-v1' && event.sequence === 1 && event.pageVisitId === event.id
    && exact(data, ['action', 'section', 'outcome', 'checkpointState'])
    && data.action === 'offline_operation_committed' && sections.has(data.section) && data.outcome === 'accepted'
    && exact(state, ['operationId', 'receiptId', 'generation', 'delivery', 'mini_k56OfflineVersion', 'continuedFromOtherSession'])
    && UUID.test(state.operationId ?? '') && UUID.test(state.receiptId ?? '')
    && state.generation === scope.generation && state.delivery === 'cbt' && state.mini_k56OfflineVersion === 1
    && typeof state.continuedFromOtherSession === 'boolean', 'PILOT_NATIVE_RECEIPT_DENIED', 403);
}

const eventTypes = new Set(['request_received','request_completed','draft_committed','submission_committed',
  'decision_made','score_calculated','job_queued','job_claimed','job_retry','job_completed','job_failed',
  'callback_received','portal_write_started','portal_write_verified','portal_write_unknown']);
const routePrefix = '/api/term-tests/' + miniK56CbtSlug + '/';
const routes = new Set(['session/prepare','session/start','session/recover','session/resume-attempt','session/audio-progress',
  'order/open','attempt/active','attempt/prepare','listening','listening/draft','listening/audio-progress','listening/audio-preparation',
  'reading','reading/start','reading/draft','writing','resume','submission-status','event','events',
  'offline/prepare','offline/operation','offline/status','offline/hold','listening-report','listening/report']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const elapsed = value => Number.isFinite(value) && value >= 0;
const uuid = value => typeof value === 'string' && UUID.test(value);
const label = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const flag = value => typeof value === 'boolean';
const band = value => Number.isFinite(value) && value >= 0 && value <= 100;
const normal = {
  requestId:uuid,action:label,section:value=>sections.has(value),method:value=>['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(value),
  route:value=>typeof value==='string'&&value.startsWith(routePrefix)&&routes.has(value.slice(routePrefix.length)),
  revision:count,durationMs:elapsed,status:value=>Number.isInteger(value)&&value>=100&&value<=599,
  outcome:label,operationStatus:value=>value==='http_response_only',reasonCode:label,cause:label,completed:flag,
  sha256:hash,keyVersion:label,policyVersion:label,rawScore:band,finalScore:band,
  jobId:uuid,task:value=>value===2,errorCode:label,attemptNumber:count,
};
const stateRules = {
  operationId:uuid,receiptId:uuid,requestId:uuid,previousOperationId:value=>value===null||uuid(value),
  submissionOperationId:uuid,submissionReceiptId:uuid,mini_k56OfflineVersion:value=>value===1,
  miniListeningReportVersion:value=>value===1,submissionRecoveryVersion:value=>value===1,incidentId:uuid,
  mode:value=>['offline','online'].includes(value),
  reportStatus:value=>['open','sending','waiting_photo','photo_queued','sent','text_sent','retry_wait','failed','delivery_unknown','expired'].includes(value),
  generation:count,delivery:value=>value==='cbt',definitionVersion:count,startedAtMs:count,capturedAtMs:count,
  serverAtMs:count,heldAtMs:count,expiresAtMs:count,deadlineAtMs:count,task1Length:count,task2Length:count,
  answeredCount:count,automatic:flag,replayed:flag,policyVersion:label,phase:value=>['api','after_commit','worker_retry','hold','commit','readback','enqueue','delivery'].includes(value),
  durationMs:elapsed,errorCode:label,gradingRunRef:hash,jobType:value=>['dispatch','collect'].includes(value),
  portalSyncStatus:value=>['synced','queued','pending','processing','unknown','review_required','not_applicable','disabled','failed_response'].includes(value),
  portalEvidence:value=>value==='native_status',retryAfterSeconds:count,leaseUntilMs:count,queuedForMs:count,
};
const pick = (value, rules) => Object.fromEntries(Object.entries(rules)
  .filter(([name, valid])=>valid(value?.[name])).map(([name])=>[name,value[name]]));
const permitted = (value, rules) => value && Object.getPrototypeOf(value)===Object.prototype
  && Object.entries(value).every(([name,item])=>Object.hasOwn(rules,name)&&rules[name](item));

export function projectMiniK56CbtNativeEvent(type, data, generation) {
  if (!eventTypes.has(type) || !count(generation)) return null;
  if ((type.startsWith('job_') || data?.jobId!==undefined) && (!uuid(data?.jobId) || data?.task!==2)) return null;
  const projected = { ...pick(data,normal),checkpointState:{ ...pick(data?.checkpointState,stateRules),generation,delivery:'cbt' } };
  if (count(data?.answeredCounts?.total)) projected.answeredCounts={total:data.answeredCounts.total};
  if (type.startsWith('request_') && (!projected.route || !projected.method || !projected.requestId)) return null;
  return projected;
}

export function checkMiniK56CbtNativeEvent(event, scope) {
  if (event.build === 'k56-mini-cbt-native-receipt-v1') return checkOfflineReceipt(event, scope);
  const { checkpointState,answeredCounts,...fields } = event.data ?? {};
  requireValue(scope.product===miniK56CbtProduct&&scope.testSlug===miniK56CbtSlug&&eventTypes.has(event.type)
    && permitted(fields,normal)&&permitted(checkpointState,stateRules)
    && (!event.type.startsWith('job_') || uuid(fields.jobId)&&fields.task===2)
    && (!fields.jobId || fields.task===2)
    && checkpointState.generation===scope.generation&&checkpointState.delivery==='cbt'
    && (answeredCounts===undefined||exact(answeredCounts,['total'])&&count(answeredCounts.total))
    && (!event.type.startsWith('request_')||fields.route&&fields.method&&fields.requestId),
  'PILOT_NATIVE_EVENT_DENIED',403);
}
