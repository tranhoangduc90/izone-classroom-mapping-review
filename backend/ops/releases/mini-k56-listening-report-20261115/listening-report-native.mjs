import {timingSafeEqual} from 'node:crypto';

// Read the existing accepted native operation using the same permit as Mini's offline receiver.
// No write into the attempt, grading queue, log stream or Portal is made here.
export function createMiniOfflineListeningReportResolver({query, makePermit}) {
  return async (body, permit) => {
    if (body.mode !== 'offline' || typeof permit !== 'string' || !/^[0-9a-f]{64}$/.test(permit)) return null;
    const {rows:[row]}=await query(`
      SELECT run.attempt_id,run.session_id,run.generation,run.owner_id,run.prepared_at,
        a.student_name_snapshot,a.class_name_snapshot,
        op.payload->>'occurredAt' AS reported_at,
        op.payload->'payload'->>'startedAt' AS listening_started_at
      FROM assessment.mini_k56_offline_run run
      JOIN assessment.term_test_attempt a ON a.id=run.attempt_id
        AND a.generation=run.generation AND a.exam_session_id=run.session_id
      JOIN assessment.term_test_exam_session s ON s.id=run.session_id AND s.generation=run.generation
      JOIN assessment.mini_k56_offline_operation op ON op.attempt_id=run.attempt_id AND op.operation_id=$5
      WHERE run.attempt_id=$1 AND run.session_id=$2 AND run.generation=$3 AND run.owner_id=$4
        AND run.policy='mini-k56-offline-v1' AND a.test_slug='mini-test-k56' AND a.attempt_mode='cbt'
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
