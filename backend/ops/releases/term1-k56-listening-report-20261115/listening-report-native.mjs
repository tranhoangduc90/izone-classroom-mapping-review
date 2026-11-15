import {createHash,timingSafeEqual} from 'node:crypto';

// Read the existing accepted native operation using the same permit as Term 1's offline receiver.
// No write into the attempt, grading queue, log stream or Portal is made here.
export function createTerm1OfflineListeningReportResolver({query, makePermit}) {
  return async (body, permit) => {
    if (body.mode !== 'offline' || typeof permit !== 'string' || !/^[0-9a-f]{64}$/.test(permit)) return null;
    const {rows:[row]}=await query(`
      SELECT run.attempt_id,run.session_id,run.generation,run.owner_id,run.prepared_at,
        a.student_name_snapshot,a.class_name_snapshot,
        op.payload->>'occurredAt' AS reported_at,
        op.payload->'payload'->>'startedAt' AS listening_started_at
      FROM assessment.term1_offline_run run
      JOIN assessment.term_test_attempt a ON a.id=run.attempt_id
        AND a.generation=run.generation AND a.exam_session_id=run.session_id
      JOIN assessment.term_test_exam_session s ON s.id=run.session_id AND s.generation=run.generation
      JOIN assessment.term1_offline_operation op ON op.attempt_id=run.attempt_id AND op.operation_id=$5
      WHERE run.attempt_id=$1 AND run.session_id=$2 AND run.generation=$3 AND run.owner_id=$4
        AND run.policy='term1-offline-v1' AND a.test_slug='term-test-1-k56' AND a.attempt_mode='cbt'
        AND a.superseded_at IS NULL AND s.superseded_at IS NULL AND a.listening_interrupted_at IS NOT NULL
        AND run.state->'listening'->>'operationId'=op.operation_id::text
        AND op.section='listening' AND op.kind='interrupt'
        AND op.receipt->>'status'='accepted'
        AND op.receipt->>'examSessionToken'=run.session_id::text
        AND op.receipt->>'generation'=run.generation::text
        AND op.payload->'payload'->>'interruptionReason'='learner_cannot_hear'`,
      [body.attemptToken,body.examSessionToken,body.generation,body.ownerId,body.operationId]);
    if(!row) return null;
    const expected=makePermit(row);
    if(typeof expected!=='string' || !/^[0-9a-f]{64}$/.test(expected)
      || !timingSafeEqual(Buffer.from(permit,'hex'),Buffer.from(expected,'hex'))) return null;
    return {studentName:row.student_name_snapshot,className:row.class_name_snapshot,
      reportTimeMs:Date.parse(row.reported_at),startedAtMs:Date.parse(row.listening_started_at)};
  };
}

export function createTerm1FallbackListeningReportResolver({query}){
  return async (body,capability)=>{
    if(body.mode!=='fallback'||body.attemptToken!==body.examSessionToken||typeof capability!=='string')return null;
    const [grant,secret,extra]=capability.split('.');
    if(grant!==body.attemptToken||!/^[A-Za-z0-9_-]{43}$/.test(secret||'')||extra!==undefined)return null;
    const secretHash=createHash('sha256').update(secret).digest('hex');
    const {rows:[row]}=await query(`
      SELECT a.id AS attempt_id,a.student_name_snapshot,a.class_name_snapshot,
        op.payload->>'occurredAt' AS reported_at,op.payload->'payload'->>'startedAt' AS listening_started_at
      FROM assessment.term1_skill_grant g
      JOIN assessment.term_test_attempt a ON a.id=g.attempt_id AND a.generation=g.generation
        AND a.exam_session_id=g.session_id AND a.class_id=g.class_id
      JOIN assessment.term_test_exam_session s ON s.id=g.session_id AND s.generation=g.generation
      JOIN assessment.term1_offline_run r ON r.attempt_id=a.id AND r.session_id=s.id AND r.generation=g.generation
      JOIN assessment.term1_offline_operation op ON op.attempt_id=a.id AND op.operation_id=$4
      WHERE g.id=$1 AND g.owner_id=$2 AND g.generation=$3 AND g.secret_hash=$5
        AND g.section='listening' AND g.revoked_at IS NULL AND g.bound_at IS NOT NULL
        AND a.test_slug='term-test-1-k56' AND a.attempt_mode='cbt' AND r.policy='term1-offline-v1'
        AND a.superseded_at IS NULL AND s.superseded_at IS NULL AND a.listening_interrupted_at IS NOT NULL
        AND r.state->'listening'->>'operationId'=op.operation_id::text AND op.section='listening' AND op.kind='interrupt'
        AND op.receipt->>'status'='accepted' AND op.receipt->>'attemptToken'=g.id::text
        AND op.receipt->>'examSessionToken'=g.id::text AND op.receipt->>'generation'=g.generation::text
        AND op.payload->'payload'->>'interruptionReason'='learner_cannot_hear'`,
      [grant,body.ownerId,body.generation,body.operationId,secretHash]);
    if(!row)return null;
    return {attemptId:row.attempt_id,studentName:row.student_name_snapshot,className:row.class_name_snapshot,
      reportTimeMs:Date.parse(row.reported_at),startedAtMs:Date.parse(row.listening_started_at)};
  };
}
