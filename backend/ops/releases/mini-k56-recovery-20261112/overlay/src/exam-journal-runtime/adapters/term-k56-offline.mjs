import { UUID } from '../src/contract.mjs';

const phases = new Set(['api', 'after_commit', 'worker_retry', 'hold', 'commit', 'readback']);
const recoveryEvents = new Set(['offline_submission_held', 'offline_submission_hold_read',
  'offline_hold_unconfirmed', 'offline_submission_unconfirmed']);
const profiles = new Map([
  ['term-test-1-k56', { prefix: 'term1', task: 2 }],
  ['term-test-2-k56', { prefix: 'term2', task: 1 }],
  ['mini-test-k56', { prefix: 'mini_k56', task: 2 }]
]);

// Compare the canonical payload inside PostgreSQL. Journal receives identifiers only.
export async function k56WritingReceipt(query, product, schema, owner) {
  const profile = profiles.get(owner.test_slug);
  if (product !== 'term-mini-k56' || !['assessment', 'assessment_k56', 'assessment_k56_demo'].includes(schema)
      || !profile || owner.task_number !== profile.task) return {};
  if (profile.prefix !== 'mini_k56') {
    try {
      const { rows: [receipt] } = await query(`SELECT held.operation_id::text AS submission_operation_id,
        held.receipt->>'receiptId' AS submission_receipt_id
        FROM ${schema}.term_online_submission_hold held
        JOIN ${schema}.term_test_attempt a ON a.id=held.attempt_id AND a.generation=held.generation
        WHERE a.id=$1::uuid AND held.writing_grading_run_id=$2::uuid AND a.test_slug=$3
          AND a.superseded_at IS NULL AND held.section='writing'
          AND held.receipt->>'operationId'=held.operation_id::text
          AND held.receipt->>'examSessionToken'=a.exam_session_id::text`, [owner.token, owner.run_id, owner.test_slug]);
      if (UUID.test(receipt?.submission_receipt_id || '')) return receipt;
    } catch {
      // A deployment can still be on the offline-only schema.
    }
  }
  try {
    const { rows: [receipt] } = await query(`SELECT op.operation_id::text AS submission_operation_id,
      op.receipt->>'receiptId' AS submission_receipt_id
      FROM ${schema}.term_test_attempt a
      JOIN ${schema}.term_test_writing_grading_run grade ON grade.attempt_id = a.id
      JOIN ${schema}.${profile.prefix}_offline_run run ON run.attempt_id = a.id AND run.generation = a.generation
        AND run.session_id = a.exam_session_id
      JOIN ${schema}.${profile.prefix}_offline_operation op ON op.attempt_id = run.attempt_id
        AND op.operation_id::text = run.state->'writing'->>'operationId'
      WHERE a.id = $1::uuid AND grade.id = $2::uuid AND grade.task_number = $3
        AND a.test_slug = $4 AND a.superseded_at IS NULL
        AND op.section = 'writing' AND op.kind = 'seal' AND op.receipt->>'status' = 'accepted'
        AND op.receipt->>'operationId' = op.operation_id::text
        AND op.payload->'payload'->>($5::text) = grade.essay_text
        AND op.committed_at <= grade.created_at`, [owner.token, owner.run_id, profile.task, owner.test_slug, 'task' + profile.task]);
    return UUID.test(receipt?.submission_receipt_id || '') ? receipt : {};
  } catch {
    // Older deployments may lack the offline tables or their read grant.
    return {};
  }
}

export function k56OfflineObservation(event, testSlug, input) {
  const profile = profiles.get(testSlug);
  if (!profile) return undefined;
  const output = {};
  for (const key of ['operationId', 'receiptId', 'requestId']) {
    if (UUID.test(input[key] || '')) output[key] = input[key].toLowerCase();
  }
  if (/^[A-Z0-9_:-]{3,100}$/.test(input.errorCode || '')) output.errorCode = input.errorCode;
  if (phases.has(input.phase)) output.phase = input.phase;
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.durationMs <= 86_400_000) {
    output.durationMs = input.durationMs;
  }
  if (recoveryEvents.has(event) || Number.isSafeInteger(input.heldAtMs)) {
    output.submissionRecoveryVersion = 1;
    for (const key of ['generation', 'definitionVersion', 'startedAtMs', 'capturedAtMs', 'deadlineAtMs',
      'serverAtMs', 'heldAtMs', 'expiresAtMs', 'task1Length', 'task2Length', 'answeredCount']) {
      if (Number.isSafeInteger(input[key]) && input[key] >= 0) output[key] = input[key];
    }
    for (const key of ['automatic', 'replayed']) {
      if (typeof input[key] === 'boolean') output[key] = input[key];
    }
    if (UUID.test(input.previousOperationId || '')) output.previousOperationId = input.previousOperationId.toLowerCase();
    if (/^[a-z0-9-]{1,80}$/.test(input.policyVersion || '')) output.policyVersion = input.policyVersion;
  }
  return Object.keys(output).length ? { [profile.prefix + 'OfflineVersion']: 1, ...output } : undefined;
}
