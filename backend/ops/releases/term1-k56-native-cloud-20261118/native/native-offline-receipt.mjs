import { createHash } from 'node:crypto';
import { canonical, UUID } from '../../src/contract.mjs';

const testSlug = 'term-test-1-k56';
const product = 'term-mini-k56';
const sections = new Set(['listening', 'reading', 'writing']);

function receiptEventId(scope, operationId, section) {
  const bytes = createHash('sha256').update(canonical([testSlug, 'offline-seal', scope, operationId, section]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function createTerm1K56OfflineReceiptProducer({ schema, query, scopeForOwner, useCloud, spool }) {
  if (!['assessment_k56', 'assessment'].includes(schema)) throw new Error('TERM1_K56_RECEIPT_SCHEMA_INVALID');
  const findReceipt = `
    SELECT s.id::text AS source_id, s.class_name_snapshot AS class_code,
      s.erp_student_contact_id::text AS student_ref, s.generation,
      o.receipt->>'serverCommittedAt' AS receipt_time,
      o.receipt ? 'officialAttemptToken' AS continued_from_other_session
    FROM ${schema}.term1_offline_operation o
    JOIN ${schema}.term1_offline_run run ON run.attempt_id=o.attempt_id
    JOIN ${schema}.term_test_attempt a ON a.id=run.attempt_id AND a.generation=run.generation
    JOIN ${schema}.term_test_exam_session s ON s.id=a.exam_session_id AND s.id=run.session_id
      AND s.generation=a.generation AND s.test_slug=a.test_slug
      AND s.erp_course_class_id=a.erp_course_class_id AND s.erp_student_contact_id=a.erp_student_contact_id
    JOIN ${schema}.term_test_attempt official
      ON official.id::text=coalesce(o.receipt->>'officialAttemptToken',a.id::text)
      AND official.test_slug=a.test_slug AND official.generation=a.generation
      AND official.definition_version=a.definition_version AND official.attempt_mode='cbt'
      AND official.erp_course_class_id=a.erp_course_class_id AND official.erp_student_contact_id=a.erp_student_contact_id
    WHERE o.attempt_id=$1::uuid AND o.operation_id=$2::uuid AND o.section=$3::text
      AND a.test_slug='term-test-1-k56' AND a.attempt_mode='cbt' AND s.attempt_mode='cbt'
      AND a.superseded_at IS NULL AND s.superseded_at IS NULL AND official.superseded_at IS NULL
      AND o.kind='seal' AND o.receipt->>'status'='accepted' AND o.receipt->>'kind'=o.kind
      AND o.receipt->>'section'=o.section AND o.receipt->>'receiptId'=$4::text
      AND o.receipt->>'operationId'=o.operation_id::text
      AND o.receipt->>'attemptToken'=a.id::text AND o.receipt->>'examSessionToken'=s.id::text
      AND o.receipt->>'generation'=s.generation::text
      AND CASE o.section WHEN 'listening' THEN official.listening_submitted_at IS NOT NULL
         WHEN 'reading' THEN official.reading_submitted_at IS NOT NULL
         WHEN 'writing' THEN official.writing_submitted_at IS NOT NULL ELSE FALSE END
  `;

  return async function offer(event, slug, attemptId, details, expectedScope) {
    const { section, operationId, receiptId, phase, accepted } = details ?? {};
    if (event !== 'offline_operation_committed' || slug !== testSlug || phase !== 'after_commit' || accepted !== true
      || !sections.has(section) || ![attemptId, operationId, receiptId].every(value => typeof value === 'string' && UUID.test(value))) return null;
    const operation = operationId.toLowerCase();
    const receipt = receiptId.toLowerCase();
    const { rows: [row] } = await query(findReceipt, [attemptId, operation, section, receipt]);
    if (!row) return null;
    const scope = await scopeForOwner({ testSlug, classCode: row.class_code, studentRef: row.student_ref,
      sourceId: row.source_id, generation: Number(row.generation) });
    if (scope.product !== product || scope.testSlug !== testSlug) throw new Error('TERM1_K56_RECEIPT_SCOPE_MISMATCH');
    if (expectedScope && canonical(expectedScope)!==canonical(scope)) throw new Error('TERM1_K56_RECEIPT_SCOPE_MISMATCH');
    if (!await useCloud(scope, row.receipt_time)) return null;

    // The receipt belongs to the submitting session. The official attempt can
    // differ after cross-device continuation. Neither native token is exported.
    const id = receiptEventId(scope, operation, section);
    return spool.append(scope, [{
      id, pageVisitId: id, sequence: 1, schemaVersion: 1, eventVersion: 1, source: 'server',
      type: 'submission_committed', occurredAt: new Date(row.receipt_time).toISOString(), elapsedMs: 0,
      build: 'k56-term1-native-receipt-v1', data: { action: 'offline_operation_committed', section, outcome: 'accepted',
        checkpointState: { operationId: operation, receiptId: receipt, generation: scope.generation,
          delivery: 'cbt', term1OfflineVersion: 1, continuedFromOtherSession: row.continued_from_other_session } },
    }]);
  };
}
