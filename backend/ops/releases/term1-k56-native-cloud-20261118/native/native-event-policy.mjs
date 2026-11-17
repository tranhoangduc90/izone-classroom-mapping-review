import { requireValue, UUID } from '../../src/contract.mjs';

export const term1K56Product = 'term-mini-k56';
export const term1K56Slug = 'term-test-1-k56';
const sections = new Set(['listening', 'reading', 'writing']);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function checkOfflineReceipt(event, scope) {
  const { data } = event;
  const state = data?.checkpointState;
  requireValue(scope.product === term1K56Product && scope.testSlug === term1K56Slug
    && event.source === 'server' && event.type === 'submission_committed'
    && event.build === 'k56-term1-native-receipt-v1' && event.sequence === 1 && event.pageVisitId === event.id
    && exact(data, ['action', 'section', 'outcome', 'checkpointState'])
    && data.action === 'offline_operation_committed' && sections.has(data.section) && data.outcome === 'accepted'
    && exact(state, ['operationId', 'receiptId', 'generation', 'delivery', 'term1OfflineVersion', 'continuedFromOtherSession'])
    && UUID.test(state.operationId ?? '') && UUID.test(state.receiptId ?? '')
    && state.generation === scope.generation && state.delivery === 'cbt' && state.term1OfflineVersion === 1
    && typeof state.continuedFromOtherSession === 'boolean', 'PILOT_NATIVE_RECEIPT_DENIED', 403);
}

const eventTypes = new Set(['request_received','request_completed','draft_committed','submission_committed',
  'decision_made','score_calculated','job_queued','job_claimed','job_retry','job_completed','job_failed',
  'callback_received','portal_write_started','portal_write_verified','portal_write_unknown']);
const routePrefix = '/api/term-tests/' + term1K56Slug + '/';
const routes = new Set(['session/prepare','session/start','session/recover','session/resume-attempt','session/audio-progress',
  'order/open','attempt/active','listening','listening/draft','listening/audio-progress','listening/audio-preparation',
  'reading','reading/start','reading/draft','writing','resume','submission-status','event','events',
  'offline/prepare','offline/operation','offline/status','offline/hold','listening-report']);
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
  submissionOperationId:uuid,submissionReceiptId:uuid,term1OfflineVersion:value=>value===1,
  generation:count,delivery:value=>value==='cbt',definitionVersion:count,startedAtMs:count,capturedAtMs:count,
  serverAtMs:count,heldAtMs:count,expiresAtMs:count,deadlineAtMs:count,task1Length:count,task2Length:count,
  answeredCount:count,automatic:flag,replayed:flag,policyVersion:label,phase:value=>['api','after_commit','worker_retry','hold','commit','readback'].includes(value),
  durationMs:elapsed,errorCode:label,gradingRunRef:hash,jobType:value=>['dispatch','collect'].includes(value),
  portalSyncStatus:value=>['synced','queued','pending','processing','unknown','review_required','not_applicable','disabled','failed_response'].includes(value),
  portalEvidence:value=>value==='native_status',retryAfterSeconds:count,leaseUntilMs:count,queuedForMs:count,
};
const pick = (value, rules) => Object.fromEntries(Object.entries(rules)
  .filter(([name, valid])=>valid(value?.[name])).map(([name])=>[name,value[name]]));
const permitted = (value, rules) => value && Object.getPrototypeOf(value)===Object.prototype
  && Object.entries(value).every(([name,item])=>Object.hasOwn(rules,name)&&rules[name](item));

export function projectTerm1K56NativeEvent(type, data, generation) {
  if (!eventTypes.has(type) || !count(generation)) return null;
  const projected = { ...pick(data,normal),checkpointState:{ ...pick(data?.checkpointState,stateRules),generation,delivery:'cbt' } };
  if (count(data?.answeredCounts?.total)) projected.answeredCounts={total:data.answeredCounts.total};
  if (type.startsWith('request_') && (!projected.route || !projected.method || !projected.requestId)) return null;
  return projected;
}

export function checkTerm1K56NativeEvent(event, scope) {
  if (event.build === 'k56-term1-native-receipt-v1') return checkOfflineReceipt(event, scope);
  const { checkpointState,answeredCounts,...fields } = event.data ?? {};
  requireValue(scope.product===term1K56Product&&scope.testSlug===term1K56Slug&&eventTypes.has(event.type)
    && permitted(fields,normal)&&permitted(checkpointState,stateRules)
    && checkpointState.generation===scope.generation&&checkpointState.delivery==='cbt'
    && (answeredCounts===undefined||exact(answeredCounts,['total'])&&count(answeredCounts.total))
    && (!event.type.startsWith('request_')||fields.route&&fields.method&&fields.requestId),
  'PILOT_NATIVE_EVENT_DENIED',403);
}
