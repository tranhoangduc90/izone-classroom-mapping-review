import {requireValue, UUID} from '../../src/contract.mjs';

export const miniK67CbtCloudTransport='term-mini-k67-mini-cbt-cloud';
export const miniK67JournalProduct='term-mini-k67';
export const miniK67Slug='mini-test-lesson-5';

function exact(object, keys) {
  return object && Object.getPrototypeOf(object) === Object.prototype
    && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object,key));
}

export function checkMiniK67CbtNativeEvent(event, scope) {
  const {data}=event;
  const state=data?.checkpointState;
  requireValue(scope.product===miniK67JournalProduct && scope.testSlug===miniK67Slug
    && event.source==='server' && event.type==='submission_committed'
    && event.build==='k67-mini-cbt-native-receipt-v1'
    && exact(data,['action','section','outcome','checkpointState'])
    && data.action==='submission_completed' && data.outcome==='accepted'
    && ['listening','reading'].includes(data.section)
    && exact(state,['operationId','generation','delivery','submissionObservationVersion'])
    && typeof state.operationId==='string' && UUID.test(state.operationId)
    && Number.isSafeInteger(state.generation) && state.generation>=0 && state.generation===scope.generation
    && state.delivery==='cbt' && state.submissionObservationVersion===1,
  'PILOT_MINI_K67_CBT_EVENT_DENIED',403);
}
