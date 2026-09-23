import { z } from 'zod';
import { withTransaction } from './db.js';

const jobOutputSchema = z.object({
  entityKey: z.string().min(1).max(200),
  unitKey: z.string().min(1).max(200),
  operationKey: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(300),
  status: z.enum(['complete', 'review_required'])
}).passthrough();

const claimJobsSql = `WITH candidates AS (
  SELECT id
  FROM learning.outbox_job
  WHERE status IN ('queued', 'retry_wait')
    AND ($4::text[] IS NULL OR job_type = ANY($4::text[]))
    AND next_attempt_at <= now()
    AND (lease_until IS NULL OR lease_until < now())
  ORDER BY next_attempt_at, created_at
  LIMIT $2::integer
  FOR UPDATE SKIP LOCKED
)
UPDATE learning.outbox_job AS job
SET status = 'processing',
    attempt_count = job.attempt_count + 1,
    worker_id = $1,
    leased_at = now(),
    lease_until = now() + ($3::integer * interval '1 second'),
    updated_at = now()
FROM candidates
WHERE job.id = candidates.id
RETURNING
  job.id::text,
  job.job_type,
  job.entity_key,
  job.unit_key,
  job.operation_key,
  job.idempotency_key,
  job.payload,
  job.attempt_count,
  job.max_attempts;`;

const completeJobSql = `UPDATE learning.outbox_job
SET status = $7,
    worker_id = NULL,
    leased_at = NULL,
    lease_until = NULL,
    last_error_code = NULL,
    completed_at = CASE WHEN $7 = 'complete' THEN now() ELSE NULL END,
    updated_at = now()
WHERE id = $1::uuid
  AND worker_id = $2
  AND status = 'processing'
  AND entity_key = $3
  AND unit_key = $4
  AND operation_key = $5
  AND idempotency_key = $6;`;

const failJobSql = `UPDATE learning.outbox_job
SET status = CASE WHEN attempt_count >= max_attempts OR $4::boolean THEN 'failed' ELSE 'retry_wait' END,
    worker_id = NULL,
    leased_at = NULL,
    lease_until = NULL,
    last_error_code = $2,
    next_attempt_at = now() + ($3::integer * interval '1 millisecond'),
    updated_at = now()
WHERE id = $1::uuid
  AND status = 'processing';`;

export class LearningJobIdentityError extends Error {
  constructor(message = 'Output không khớp identity của job.') {
    super(message);
    this.name = 'LearningJobIdentityError';
    this.code = 'OUTPUT_IDENTITY_MISMATCH';
  }
}

function normalizeJob(row) {
  return {
    id: row.id,
    jobType: row.job_type,
    entityKey: row.entity_key,
    unitKey: row.unit_key,
    operationKey: row.operation_key,
    idempotencyKey: row.idempotency_key,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts)
  };
}

export function assertLearningJobOutputIdentity(job, outputInput) {
  const output = jobOutputSchema.parse(outputInput);
  const exact = output.entityKey === job.entityKey
    && output.unitKey === job.unitKey
    && output.operationKey === job.operationKey
    && output.idempotencyKey === job.idempotencyKey;
  if (!exact) throw new LearningJobIdentityError();
  return output;
}

export function retryDelayMs(attemptCount) {
  const safeAttempt = Math.max(1, Math.min(12, Number(attemptCount) || 1));
  return Math.min(15 * 60_000, 2 ** (safeAttempt - 1) * 5_000);
}

export async function claimLearningJobs({ pool, workerId, limit = 10, leaseSeconds = 120, jobTypes = null }) {
  return withTransaction(pool, async client => {
    const normalizedJobTypes = Array.isArray(jobTypes) && jobTypes.length ? [...new Set(jobTypes)] : null;
    const result = await client.query(claimJobsSql, [workerId, limit, leaseSeconds, normalizedJobTypes]);
    return result.rows.map(normalizeJob);
  });
}

async function finishJob(pool, workerId, job, output) {
  const result = await pool.query(completeJobSql, [
    job.id,
    workerId,
    output.entityKey,
    output.unitKey,
    output.operationKey,
    output.idempotencyKey,
    output.status
  ]);
  if (result.rowCount !== 1) throw new LearningJobIdentityError('Job đã mất lease hoặc identity đã thay đổi.');
}

async function failJob(pool, job, error) {
  const terminal = error instanceof LearningJobIdentityError;
  const errorCode = terminal ? error.code : String(error?.code || 'HANDLER_FAILED').slice(0, 100);
  await pool.query(failJobSql, [job.id, errorCode, retryDelayMs(job.attemptCount), terminal]);
}

export async function processLearningJob({ pool, workerId, job, handler }) {
  try {
    const output = assertLearningJobOutputIdentity(job, await handler(job));
    await finishJob(pool, workerId, job, output);
    return { jobId: job.id, status: output.status };
  } catch (error) {
    await failJob(pool, job, error);
    return { jobId: job.id, status: 'failed_or_retry', errorCode: error.code || 'HANDLER_FAILED' };
  }
}

export async function runLearningJobBatch({
  pool, workerId, handler, limit = 10, leaseSeconds = 120, jobTypes = null
}) {
  const jobs = await claimLearningJobs({ pool, workerId, limit, leaseSeconds, jobTypes });
  const results = [];
  for (const job of jobs) {
    results.push(await processLearningJob({ pool, workerId, job, handler }));
  }
  return results;
}
