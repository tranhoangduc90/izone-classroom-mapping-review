import crypto from 'node:crypto';
import { buildErpGradePayload } from './erp-sync.js';

const enqueueSql = `INSERT INTO assessment.term_test_portal_sync_job (
  attempt_id, request_version, writing_score, status, available_at, requested_at, updated_at
)
SELECT
  attempt.id, 1, $2::numeric, 'pending', now(), now(), now()
FROM assessment.term_test_attempt AS attempt
WHERE attempt.id = $1::uuid
  AND (
    (
      attempt.test_slug ~ '^term-test-[1-9][0-9]*$'
      AND upper(btrim(attempt.class_name_snapshot)) <> 'CODEXDEMO806'
    )
    OR (
      attempt.test_slug ~ '^term-test-[1-9][0-9]*-k56$'
      AND attempt.erp_course_class_id = 1252
    )
  )
ON CONFLICT (attempt_id) DO UPDATE
SET
  request_version = assessment.term_test_portal_sync_job.request_version + 1,
  writing_score = coalesce(EXCLUDED.writing_score, assessment.term_test_portal_sync_job.writing_score),
  status = 'pending',
  available_at = now(),
  lease_until = NULL,
  worker_id = NULL,
  last_error_code = NULL,
  requested_at = now(),
  completed_at = NULL,
  updated_at = now()
RETURNING attempt_id::text AS attempt_token, request_version, status;`;

const claimSql = `WITH candidates AS (
  SELECT job.attempt_id
  FROM assessment.term_test_portal_sync_job AS job
  WHERE (
      job.status IN ('pending', 'retry') AND job.available_at <= now()
    ) OR (
      job.status = 'processing' AND job.lease_until < now()
    )
  ORDER BY job.available_at, job.requested_at
  FOR UPDATE SKIP LOCKED
  LIMIT $2::int
)
UPDATE assessment.term_test_portal_sync_job AS job
SET
  status = 'processing',
  claimed_version = job.request_version,
  worker_id = $1,
  lease_until = now() + make_interval(secs => $3::int),
  attempts = job.attempts + 1,
  updated_at = now()
FROM candidates
WHERE job.attempt_id = candidates.attempt_id
RETURNING
  job.attempt_id::text AS attempt_token,
  job.claimed_version,
  job.writing_score,
  job.attempts;`;

const readAttemptSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.test_slug,
  attempt.erp_course_class_id::text AS class_id,
  attempt.erp_student_contact_id::text AS student_id,
  attempt.combined_result,
  attempt.listening_result
FROM assessment.term_test_attempt AS attempt
WHERE attempt.id = $1::uuid;`;

const completeSql = `UPDATE assessment.term_test_portal_sync_job
SET
  processed_version = greatest(processed_version, $3::bigint),
  status = CASE WHEN request_version > $3::bigint THEN 'pending' ELSE 'complete' END,
  available_at = CASE WHEN request_version > $3::bigint THEN now() ELSE available_at END,
  completed_at = CASE WHEN request_version > $3::bigint THEN NULL ELSE now() END,
  lease_until = NULL,
  worker_id = NULL,
  last_error_code = NULL,
  updated_at = now()
WHERE attempt_id = $1::uuid
  AND worker_id = $2
  AND status = 'processing';`;

const failSql = `UPDATE assessment.term_test_portal_sync_job
SET
  status = CASE WHEN attempts >= $4::int THEN 'failed' ELSE 'retry' END,
  available_at = now() + make_interval(secs => LEAST(300, power(2, LEAST(attempts, 8))::int)),
  lease_until = NULL,
  worker_id = NULL,
  last_error_code = $3,
  updated_at = now()
WHERE attempt_id = $1::uuid
  AND worker_id = $2
  AND status = 'processing';`;

const statusSql = `SELECT status
FROM assessment.term_test_portal_sync_job
WHERE attempt_id = $1::uuid;`;

function safeErrorCode(error) {
  const value = String(error?.code || error?.message || 'PORTAL_SYNC_FAILED').toUpperCase();
  return /^[A-Z0-9_:-]{3,80}$/.test(value) ? value : 'PORTAL_SYNC_FAILED';
}

function correlationFor(attemptToken) {
  return crypto.createHash('sha256').update(String(attemptToken)).digest('hex').slice(0, 16);
}

// Dữ liệu vào: attempt token và điểm Writing mới nhất nếu đã có.
// Việc chính: upsert một job theo đúng attempt; mỗi yêu cầu mới tăng version để worker không làm mất cập nhật đến muộn.
// Kết quả: API trả ngay trạng thái queued sau một lần ghi PostgreSQL ngắn.
// Khi lỗi: request gọi hàm nhận lỗi DB rõ ràng; không gọi Portal ở đường nộp bài.
export function createTermTestPortalSyncService({ pool, syncErpGrades, enabled = true, logger = console }) {
  async function enqueue({ attemptToken, writingScore = null }) {
    if (!enabled) return 'not_applicable';
    const result = await pool.query(enqueueSql, [attemptToken, writingScore]);
    return result.rows.length === 1 ? 'queued' : 'not_applicable';
  }

  async function getStatus(attemptToken) {
    if (!enabled) return 'not_applicable';
    const result = await pool.query(statusSql, [attemptToken]);
    const status = String(result.rows[0]?.status || '');
    if (!status) return 'not_applicable';
    return status === 'complete' ? 'synced' : status === 'failed' ? 'pending' : 'queued';
  }

  async function claim({ workerId, limit, leaseSeconds }) {
    if (!enabled) return [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(claimSql, [workerId, limit, leaseSeconds]);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function processJob(workerId, job, maxAttempts) {
    const attemptResult = await pool.query(readAttemptSql, [job.attempt_token]);
    const attempt = attemptResult.rows[0];
    if (!attempt) {
      await pool.query(failSql, [job.attempt_token, workerId, 'ATTEMPT_NOT_FOUND', maxAttempts]);
      return { status: 'failed', attemptToken: job.attempt_token };
    }
    try {
      const result = attempt.combined_result || { listening: attempt.listening_result || null, reading: null };
      const syncResult = await syncErpGrades(buildErpGradePayload(attempt, result, { writing: job.writing_score }));
      if (syncResult?.status !== 'synced') {
        const failure = new Error(`PORTAL_${String(syncResult?.status || 'UNKNOWN').toUpperCase()}`);
        failure.code = safeErrorCode(failure);
        throw failure;
      }
      await pool.query(completeSql, [job.attempt_token, workerId, job.claimed_version]);
      logger.info(JSON.stringify({
        event: 'term_test_portal_job',
        correlation: correlationFor(job.attempt_token),
        status: 'synced',
        requestVersion: Number(job.claimed_version) || 0
      }));
      return { status: 'synced', attemptToken: job.attempt_token };
    } catch (error) {
      const code = safeErrorCode(error);
      await pool.query(failSql, [job.attempt_token, workerId, code, maxAttempts]);
      logger.error(JSON.stringify({
        event: 'term_test_portal_job',
        correlation: correlationFor(job.attempt_token),
        status: 'retry',
        code
      }));
      return { status: 'retry', attemptToken: job.attempt_token, code };
    }
  }

  async function runBatch({ workerId, limit = 10, leaseSeconds = 90, maxAttempts = 8 } = {}) {
    const safeWorkerId = String(workerId || '').trim();
    if (!safeWorkerId) throw new Error('Thiếu mã tiến trình xử lý Portal.');
    const jobs = await claim({ workerId: safeWorkerId, limit, leaseSeconds });
    return Promise.all(jobs.map(job => processJob(safeWorkerId, job, maxAttempts)));
  }

  return { enqueue, getStatus, runBatch };
}

// Dữ liệu vào: service hàng đợi đã kết nối database và hàm đồng bộ Portal.
// Việc chính: quét job theo nhịp ngắn; khóa chống chạy chồng trong cùng tiến trình.
// Kết quả: Portal được cập nhật ngoài request của học viên và tự thử lại khi lỗi tạm thời.
// Khi lỗi: chỉ ghi mã lỗi không chứa danh tính hoặc nội dung bài; vòng quét sau tiếp tục chạy.
export function startTermTestPortalSyncWorker(service, {
  intervalMs = 1_000,
  workerId = `term-test-portal-${crypto.randomUUID()}`,
  logger = console
} = {}) {
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      await service.runBatch({ workerId });
    } catch (error) {
      logger.error(JSON.stringify({ event: 'term_test_portal_worker', status: 'failed', code: safeErrorCode(error) }));
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
}
