import {createHash} from 'node:crypto';
import {canonical, requireValue, UUID} from '../../src/contract.mjs';

const slug='mini-test-lesson-5';
const receiptQuery=`
  SELECT s.id::text AS source_id, s.class_name_snapshot AS class_code,
         s.erp_student_contact_id::text AS student_ref, s.generation,
         j.sections->$4::text AS receipt,
         CASE $4 WHEN 'listening' THEN a.listening_submitted_at ELSE a.reading_submitted_at END AS committed_at
  FROM assessment.mini_k67_cbt_journey j
  JOIN assessment.term_test_exam_session s ON s.id=j.session_id AND s.generation=j.generation
  JOIN assessment.term_test_attempt a ON a.exam_session_id=s.id AND a.generation=s.generation
    AND a.erp_student_contact_id=s.erp_student_contact_id AND a.erp_course_class_id=s.erp_course_class_id
    AND a.class_name_snapshot=s.class_name_snapshot AND a.superseded_at IS NULL
  WHERE s.id=$1::uuid AND s.test_slug='mini-test-lesson-5' AND s.generation=$2
    AND s.superseded_at IS NULL AND s.attempt_mode IN ('legacy','cbt')
    AND a.exam_delivery IN ('legacy','cbt') AND a.test_slug=s.test_slug
    AND a.id::text=(j.sections->$4::text)->>'attemptToken'
    AND (j.sections->$4::text)->>'examSessionToken'=s.id::text
    AND (j.sections->$4::text)->>'operationId'=$3::text
    AND (j.sections->$4::text)->>'section'=$4
    AND (j.sections->$4::text)->>'generation'=s.generation::text
    AND (j.sections->$4::text)->>'outcome' IS DISTINCT FROM 'interrupted'
    AND CASE $4 WHEN 'listening' THEN a.listening_submitted_at ELSE a.reading_submitted_at END IS NOT NULL`;

function commitEventId(scope, section, operationId) {
  const bytes=createHash('sha256').update(canonical(['mini-k67-cbt-committed',scope,section,operationId])).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|128;
  bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

export function createMiniK67CbtReceiptProducer({query,scopeForOwner,spool}) {
  return async function offer(event,testSlug,sessionId,details,expectedScope) {
    const {section,submission}=details??{};
    if(event!=='submission_completed'||testSlug!==slug||submission?.delivery!=='cbt'
      ||!['listening','reading'].includes(section)||!UUID.test(sessionId??'')
      ||!UUID.test(submission.operationId??'')||!Number.isSafeInteger(submission.generation)||submission.generation<0) return null;
    const {rows:[row]}=await query(receiptQuery,[sessionId,submission.generation,submission.operationId.toLowerCase(),section]);
    if(!row) return null;
    const scope=await scopeForOwner({testSlug:slug,classCode:row.class_code,studentRef:row.student_ref,
      sourceId:row.source_id,generation:Number(row.generation)});
    requireValue(!expectedScope||canonical(scope)===canonical(expectedScope),'MINI_CBT_NATIVE_SCOPE_DENIED',403);
    const time=new Date(row.committed_at).getTime();
    requireValue(Number.isSafeInteger(time)&&time>0,'MINI_CBT_NATIVE_COMMIT_TIME_INVALID',503);
    const operationId=row.receipt.operationId;
    const id=commitEventId(scope,section,operationId);
    return spool.append(scope,[{id,pageVisitId:id,sequence:1,schemaVersion:1,eventVersion:1,
      source:'server',type:'submission_committed',occurredAt:new Date(time).toISOString(),elapsedMs:0,
      build:'k67-mini-cbt-native-receipt-v1',data:{action:'submission_completed',section,outcome:'accepted',
        checkpointState:{operationId,generation:scope.generation,delivery:'cbt',submissionObservationVersion:1}}}]);
  };
}
