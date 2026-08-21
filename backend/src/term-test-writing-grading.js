// Module này điều phối việc chấm Writing của bài thi máy bằng PostgreSQL.
// Dữ liệu nhận vào: bài Task 1/2 đã nộp, việc n8n nhận xử lý và kết quả chấm có cấu trúc.
// Việc chính: tạo việc chống trùng, cho worker thuê việc có thời hạn, lưu từng tiêu chí và chỉ mở điểm khi đủ hai Task.
// Kết quả: giao diện học viên chỉ đọc một bản kết quả hoàn chỉnh; việc lỗi được giữ lại để thử lại hoặc giáo viên kiểm tra.
// Khi lỗi: transaction rollback toàn bộ thay đổi của bước hiện tại và trả mã lỗi không chứa nội dung bài viết.

import crypto from 'node:crypto';
import { buildErpGradePayload } from './erp-sync.js';

const GRADING_VERSION = 1;
const TASK_CRITERIA = Object.freeze({
  1: Object.freeze(['TA', 'CC', 'LR', 'GRA']),
  2: Object.freeze(['TR', 'CC', 'LR', 'GRA'])
});
const WRITING_IMAGE_MAX_BYTES = 600 * 1024;
const WRITING_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/;

export function buildTermTestWritingImageToken(secret, jobId) {
  return crypto.createHmac('sha256', String(secret || '')).update(String(jobId || ''), 'utf8').digest('hex');
}

export function verifyTermTestWritingImageToken(secret, jobId, suppliedToken) {
  const expected = Buffer.from(buildTermTestWritingImageToken(secret, jobId), 'utf8');
  const supplied = Buffer.from(String(suppliedToken || ''), 'utf8');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function decodeTermTestWritingImageDataUrl(dataUrl) {
  const match = WRITING_IMAGE_DATA_URL.exec(String(dataUrl || ''));
  if (!match) {
    throw new TermTestWritingGradingError(
      'WRITING_GRADING_IMAGE_INVALID',
      'Ảnh đề Writing không hợp lệ.',
      422
    );
  }
  const compactBase64 = match[2].replace(/\s+/g, '');
  const body = Buffer.from(compactBase64, 'base64');
  const canonicalInput = compactBase64.replace(/=+$/, '');
  const canonicalOutput = body.toString('base64').replace(/=+$/, '');
  if (!body.length || body.length > WRITING_IMAGE_MAX_BYTES || canonicalInput !== canonicalOutput) {
    throw new TermTestWritingGradingError(
      'WRITING_GRADING_IMAGE_INVALID',
      'Ảnh đề Writing không hợp lệ.',
      422
    );
  }
  return { mimeType: match[1], body };
}

export class TermTestWritingGradingError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.name = 'TermTestWritingGradingError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value, maximum = 120_000) {
  return String(value ?? '').replace(/\u0000/g, '').slice(0, maximum);
}

function validateBand(value, field = 'score') {
  const band = Number(value);
  if (!Number.isFinite(band) || band < 0 || band > 9 || Math.round(band * 2) !== band * 2) {
    throw new TermTestWritingGradingError(
      'WRITING_GRADING_INVALID_BAND',
      `${field} phải từ 0 đến 9 và theo bước 0,5.`,
      400
    );
  }
  return band;
}

export function calculateWritingTaskScore(criteria) {
  if (!Array.isArray(criteria) || criteria.length !== 4) {
    throw new TermTestWritingGradingError(
      'WRITING_GRADING_MISSING_CRITERIA',
      'Mỗi Task phải có đủ bốn tiêu chí.',
      400
    );
  }
  const average = criteria.reduce((sum, criterion) => sum + validateBand(criterion.bandScore), 0) / 4;
  return Math.floor((average * 2) + 1e-9) / 2;
}

export function calculateTermTestWritingOverall(task1Score, task2Score) {
  const task1 = validateBand(task1Score, 'Task 1');
  const task2 = validateBand(task2Score, 'Task 2');
  return Math.ceil((((task1 + (2 * task2)) / 3) * 2) - 1e-9) / 2;
}

function countWords(value) {
  const normalized = cleanText(value).trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function normalizeComponent(component, index) {
  const code = cleanText(component?.code || `component_${index + 1}`, 80).trim();
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(code)) {
    throw new TermTestWritingGradingError(
      'WRITING_GRADING_INVALID_COMPONENT',
      'Mã khía cạnh chấm không hợp lệ.',
      400
    );
  }
  return {
    code,
    label: cleanText(component?.label || code, 200).trim(),
    summary: cleanText(component?.summary, 30_000),
    feedback: cleanText(component?.feedback, 80_000)
  };
}

function normalizeTaskResult(taskNumber, input) {
  const expectedCodes = TASK_CRITERIA[taskNumber];
  if (!expectedCodes) {
    throw new TermTestWritingGradingError('WRITING_GRADING_INVALID_TASK', 'Task Writing không hợp lệ.', 400);
  }
  const criteria = Array.isArray(input?.criteria) ? input.criteria : [];
  const uniqueCodes = new Set(criteria.map(item => cleanText(item?.code, 10).trim().toUpperCase()));
  if (criteria.length !== 4 || uniqueCodes.size !== 4 || expectedCodes.some(code => !uniqueCodes.has(code))) {
    throw new TermTestWritingGradingError(
      'WRITING_GRADING_MISSING_CRITERIA',
      `Task ${taskNumber} chưa đủ đúng bốn tiêu chí bắt buộc.`,
      400
    );
  }

  const normalizedCriteria = expectedCodes.map(code => {
    const source = criteria.find(item => cleanText(item?.code, 10).trim().toUpperCase() === code);
    const components = Array.isArray(source?.components)
      ? source.components.slice(0, 20).map(normalizeComponent)
      : [];
    return {
      code,
      name: cleanText(source?.name || code, 200).trim(),
      bandScore: validateBand(source?.bandScore, code),
      feedback: cleanText(source?.feedback, 120_000),
      components
    };
  });
  const taskScore = calculateWritingTaskScore(normalizedCriteria);
  if (input?.taskScore !== undefined && input?.taskScore !== null) {
    const reported = validateBand(input.taskScore, `Task ${taskNumber} overall`);
    if (Math.abs(reported - taskScore) > 0.001) {
      throw new TermTestWritingGradingError(
        'WRITING_GRADING_SCORE_MISMATCH',
        `Điểm tổng Task ${taskNumber} không khớp bốn tiêu chí.`,
        400
      );
    }
  }
  return {
    taskNumber,
    taskScore,
    criteria: normalizedCriteria,
    report: cleanText(input?.report, 180_000)
  };
}

async function inTransaction(pool, handler) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Giữ lại lỗi gốc. */ }
    throw error;
  } finally {
    if (client !== pool && typeof client.release === 'function') client.release();
  }
}

function buildRunKey(testSlug, attemptToken, taskNumber) {
  return `${testSlug}:${attemptToken}:task${taskNumber}:v${GRADING_VERSION}`;
}

function taskSource(taskDefinitions, taskNumber) {
  const taskId = `task${taskNumber}`;
  const task = Array.isArray(taskDefinitions)
    ? taskDefinitions.find(item => String(item?.id || '').toLowerCase() === taskId)
    : null;
  if (!task) {
    throw new TermTestWritingGradingError(
      'WRITING_GRADING_PROMPT_NOT_FOUND',
      `Không tìm thấy đề Writing ${taskId}.`,
      500
    );
  }
  const prompt = [task.prompt, task.followUp].map(value => cleanText(value, 40_000).trim()).filter(Boolean).join('\n\n');
  const rawImage = task.image && typeof task.image === 'object' ? task.image.src : task.image;
  return {
    prompt,
    imageUrl: cleanText(rawImage, 250_000).trim()
  };
}

function serializePending(runs) {
  const taskStates = Object.fromEntries([1, 2].map(taskNumber => {
    const run = runs.find(item => Number(item.task_number) === taskNumber);
    return [`task${taskNumber}`, run?.status || 'queued'];
  }));
  const terminal = runs.some(run => run.status === 'review_required' || run.status === 'failed');
  return {
    status: terminal ? 'review_required' : (runs.length ? 'processing' : 'not_started'),
    ready: false,
    taskStates,
    task1Score: null,
    task2Score: null,
    writingScore: null,
    tasks: []
  };
}

async function readStatus(client, attemptToken) {
  const result = await client.query(`SELECT
    final.status AS final_status,
    final.task_1_score,
    final.task_2_score,
    final.writing_score,
    final.ready_at,
    run.task_number,
    run.status,
    run.task_score,
    run.word_count,
    run.result_json,
    run.completed_at
  FROM assessment.term_test_writing_grading_run AS run
  LEFT JOIN assessment.term_test_writing_grading_final AS final
    ON final.attempt_id = run.attempt_id
  WHERE run.attempt_id = $1::uuid
    AND run.grading_version = $2
  ORDER BY run.task_number;`, [attemptToken, GRADING_VERSION]);
  const runs = result.rows;
  if (!runs.length || runs[0].final_status !== 'ready') return serializePending(runs);
  return {
    status: 'ready',
    ready: true,
    taskStates: { task1: 'complete', task2: 'complete' },
    task1Score: numericOrNull(runs[0].task_1_score),
    task2Score: numericOrNull(runs[0].task_2_score),
    writingScore: numericOrNull(runs[0].writing_score),
    readyAt: runs[0].ready_at,
    tasks: runs.map(run => ({
      ...(run.result_json || {}),
      taskNumber: Number(run.task_number),
      taskScore: numericOrNull(run.task_score),
      wordCount: Number(run.word_count || 0),
      completedAt: run.completed_at
    }))
  };
}

async function refreshFinal(client, attemptId) {
  const runsResult = await client.query(`SELECT id::text, task_number, task_score
  FROM assessment.term_test_writing_grading_run
  WHERE attempt_id = $1::uuid
    AND grading_version = $2
    AND status = 'complete'
  ORDER BY task_number;`, [attemptId, GRADING_VERSION]);
  const task1 = runsResult.rows.find(row => Number(row.task_number) === 1);
  const task2 = runsResult.rows.find(row => Number(row.task_number) === 2);
  if (!task1 || !task2) {
    await client.query(`INSERT INTO assessment.term_test_writing_grading_final (
      attempt_id, grading_version, status
    ) VALUES ($1::uuid, $2, 'waiting')
    ON CONFLICT (attempt_id) DO NOTHING;`, [attemptId, GRADING_VERSION]);
    return null;
  }
  const writingScore = calculateTermTestWritingOverall(task1.task_score, task2.task_score);
  await client.query(`INSERT INTO assessment.term_test_writing_grading_final (
    attempt_id, grading_version, task_1_run_id, task_2_run_id,
    task_1_score, task_2_score, writing_score, status, ready_at, updated_at
  ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::numeric, 'ready', now(), now())
  ON CONFLICT (attempt_id) DO UPDATE SET
    grading_version = EXCLUDED.grading_version,
    task_1_run_id = EXCLUDED.task_1_run_id,
    task_2_run_id = EXCLUDED.task_2_run_id,
    task_1_score = EXCLUDED.task_1_score,
    task_2_score = EXCLUDED.task_2_score,
    writing_score = EXCLUDED.writing_score,
    status = 'ready',
    ready_at = COALESCE(assessment.term_test_writing_grading_final.ready_at, now()),
    updated_at = now();`, [
    attemptId,
    GRADING_VERSION,
    task1.id,
    task2.id,
    task1.task_score,
    task2.task_score,
    writingScore
  ]);
  return writingScore;
}

export function createTermTestWritingGradingService({ pool, syncErpGrades = null }) {
  async function ensureSubmission({ attemptToken, testSlug, task1, task2, taskDefinitions }) {
    return inTransaction(pool, async client => {
      const attemptResult = await client.query(`SELECT id::text, test_slug
      FROM assessment.term_test_attempt
      WHERE id = $1::uuid
        AND test_slug = $2
        AND completed_at IS NOT NULL
        AND writing_submitted_at IS NOT NULL
      FOR UPDATE;`, [attemptToken, testSlug]);
      if (attemptResult.rows.length !== 1) {
        throw new TermTestWritingGradingError(
          'WRITING_GRADING_ATTEMPT_NOT_READY',
          'Bài Writing chưa được máy chủ xác nhận nộp.',
          409
        );
      }

      const essays = { 1: cleanText(task1, 120_000), 2: cleanText(task2, 180_000) };
      for (const taskNumber of [1, 2]) {
        const source = taskSource(taskDefinitions, taskNumber);
        const runKey = buildRunKey(testSlug, attemptToken, taskNumber);
        await client.query(`INSERT INTO assessment.term_test_writing_grading_run (
          attempt_id, task_number, grading_version, run_key,
          prompt_text, prompt_image_url, essay_text, word_count, status
        ) VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6, ''), $7, $8, 'queued')
        ON CONFLICT (attempt_id, task_number, grading_version) DO NOTHING;`, [
          attemptToken,
          taskNumber,
          GRADING_VERSION,
          runKey,
          source.prompt,
          source.imageUrl,
          essays[taskNumber],
          countWords(essays[taskNumber])
        ]);
        const runResult = await client.query(`SELECT id::text
        FROM assessment.term_test_writing_grading_run
        WHERE attempt_id = $1::uuid AND task_number = $2 AND grading_version = $3;`, [
          attemptToken,
          taskNumber,
          GRADING_VERSION
        ]);
        await client.query(`INSERT INTO assessment.term_test_writing_grading_job (
          run_id, job_type, idempotency_key, status, max_attempts, next_attempt_at
        ) VALUES ($1::uuid, 'dispatch', $2, 'queued', 8, now())
        ON CONFLICT (idempotency_key) DO NOTHING;`, [
          runResult.rows[0].id,
          `${runKey}:dispatch`
        ]);
      }
      await client.query(`INSERT INTO assessment.term_test_writing_grading_final (
        attempt_id, grading_version, status
      ) VALUES ($1::uuid, $2, 'waiting')
      ON CONFLICT (attempt_id) DO NOTHING;`, [attemptToken, GRADING_VERSION]);
      return readStatus(client, attemptToken);
    });
  }

  async function claimJobs({ workerId, limit = 4 }) {
    const safeWorkerId = cleanText(workerId, 100).trim();
    const safeLimit = Math.max(1, Math.min(10, Number(limit) || 4));
    if (!/^[A-Za-z0-9_.:-]{3,100}$/.test(safeWorkerId)) {
      throw new TermTestWritingGradingError('WRITING_GRADING_INVALID_WORKER', 'Mã tiến trình không hợp lệ.', 400);
    }
    return inTransaction(pool, async client => {
      const claimed = await client.query(`WITH candidates AS (
        SELECT job.id
        FROM assessment.term_test_writing_grading_job AS job
        WHERE (
          job.status IN ('queued', 'retry_wait')
          OR (job.status = 'processing' AND job.lease_until < now())
        )
          AND job.next_attempt_at <= now()
        ORDER BY job.next_attempt_at, job.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      ), updated AS (
        UPDATE assessment.term_test_writing_grading_job AS job
        SET status = 'processing',
            worker_id = $1,
            leased_at = now(),
            lease_until = now() + interval '10 minutes',
            attempt_count = attempt_count + 1,
            updated_at = now()
        FROM candidates
        WHERE job.id = candidates.id
        RETURNING job.*
      )
      SELECT
        updated.id::text AS job_id,
        updated.job_type,
        updated.attempt_count,
        updated.max_attempts,
        run.run_key,
        run.task_number,
        run.prompt_text,
        run.prompt_image_url,
        run.essay_text,
        run.word_count,
        run.lark_record_id
      FROM updated
      JOIN assessment.term_test_writing_grading_run AS run ON run.id = updated.run_id
      ORDER BY updated.created_at;`, [safeWorkerId, safeLimit]);
      return claimed.rows.map(row => ({
        jobId: row.job_id,
        jobType: row.job_type,
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
        runKey: row.run_key,
        taskNumber: Number(row.task_number),
        prompt: row.job_type === 'dispatch' ? row.prompt_text : '',
        imageUrl: row.job_type === 'dispatch' ? (row.prompt_image_url || '') : '',
        essay: row.job_type === 'dispatch' ? row.essay_text : '',
        wordCount: Number(row.word_count || 0),
        sourceRecordId: row.lark_record_id || null
      }));
    });
  }

  async function completeDispatch({ jobId, workerId, sourceRecordId = null }) {
    return inTransaction(pool, async client => {
      const jobResult = await client.query(`SELECT
        job.id::text, job.status, job.job_type, job.worker_id,
        run.id::text AS run_id, run.run_key
      FROM assessment.term_test_writing_grading_job AS job
      JOIN assessment.term_test_writing_grading_run AS run ON run.id = job.run_id
      WHERE job.id = $1::uuid
      FOR UPDATE;`, [jobId]);
      if (jobResult.rows.length !== 1) {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_NOT_FOUND', 'Không tìm thấy việc chấm.', 404);
      }
      const job = jobResult.rows[0];
      if (job.job_type !== 'dispatch') {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_TYPE_MISMATCH', 'Sai loại việc chấm.', 409);
      }
      if (job.status === 'complete') return { status: 'duplicate', runKey: job.run_key };
      if (job.status !== 'processing' || job.worker_id !== workerId) {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_LEASE_MISMATCH', 'Việc chấm không thuộc tiến trình này.', 409);
      }
      await client.query(`UPDATE assessment.term_test_writing_grading_job
      SET status = 'complete', completed_at = now(), lease_until = NULL, updated_at = now()
      WHERE id = $1::uuid;`, [jobId]);
      await client.query(`UPDATE assessment.term_test_writing_grading_run
      SET status = 'grading',
          lark_record_id = COALESCE(NULLIF($2, ''), lark_record_id),
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = $1::uuid;`, [job.run_id, cleanText(sourceRecordId, 100)]);
      await client.query(`INSERT INTO assessment.term_test_writing_grading_job (
        run_id, job_type, idempotency_key, status, max_attempts, next_attempt_at
      ) VALUES ($1::uuid, 'collect', $2, 'retry_wait', 120, now() + interval '45 seconds')
      ON CONFLICT (idempotency_key) DO NOTHING;`, [job.run_id, `${job.run_key}:collect`]);
      return { status: 'accepted', runKey: job.run_key };
    });
  }

  async function completeResult({ jobId, workerId, runKey, sourceRecordId = null, result }) {
    const stored = await inTransaction(pool, async client => {
      const jobResult = await client.query(`SELECT
        job.id::text, job.status, job.job_type, job.worker_id,
        run.id::text AS run_id, run.run_key, run.task_number, run.attempt_id::text AS attempt_id
      FROM assessment.term_test_writing_grading_job AS job
      JOIN assessment.term_test_writing_grading_run AS run ON run.id = job.run_id
      WHERE job.id = $1::uuid
      FOR UPDATE;`, [jobId]);
      if (jobResult.rows.length !== 1) {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_NOT_FOUND', 'Không tìm thấy việc thu kết quả.', 404);
      }
      const job = jobResult.rows[0];
      if (job.job_type !== 'collect' || job.run_key !== runKey) {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_TYPE_MISMATCH', 'Kết quả không khớp lượt chấm.', 409);
      }
      if (job.status === 'complete') {
        return { status: 'duplicate', grading: await readStatus(client, job.attempt_id), portalSyncRequired: false };
      }
      if (job.status !== 'processing' || job.worker_id !== workerId) {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_LEASE_MISMATCH', 'Việc thu kết quả không thuộc tiến trình này.', 409);
      }
      const normalized = normalizeTaskResult(Number(job.task_number), result);

      for (const criterion of normalized.criteria) {
        await client.query(`INSERT INTO assessment.term_test_writing_grading_criterion (
          run_id, criterion_code, status, band_score, feedback, completed_at, updated_at
        ) VALUES ($1::uuid, $2, 'complete', $3::numeric, $4, now(), now())
        ON CONFLICT (run_id, criterion_code) DO UPDATE SET
          status = 'complete', band_score = EXCLUDED.band_score,
          feedback = EXCLUDED.feedback, completed_at = now(), updated_at = now();`, [
          job.run_id,
          criterion.code,
          criterion.bandScore,
          criterion.feedback
        ]);
        for (const component of criterion.components) {
          await client.query(`INSERT INTO assessment.term_test_writing_grading_component (
            run_id, criterion_code, component_code, status, label, summary, feedback, completed_at, updated_at
          ) VALUES ($1::uuid, $2, $3, 'complete', $4, $5, $6, now(), now())
          ON CONFLICT (run_id, component_code) DO UPDATE SET
            criterion_code = EXCLUDED.criterion_code,
            status = 'complete', label = EXCLUDED.label,
            summary = EXCLUDED.summary, feedback = EXCLUDED.feedback,
            completed_at = now(), updated_at = now();`, [
            job.run_id,
            criterion.code,
            component.code,
            component.label,
            component.summary,
            component.feedback
          ]);
        }
      }

      await client.query(`UPDATE assessment.term_test_writing_grading_run
      SET status = 'complete',
          lark_record_id = COALESCE(NULLIF($2, ''), lark_record_id),
          task_score = $3::numeric,
          result_json = $4::jsonb,
          last_error_code = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1::uuid;`, [
        job.run_id,
        cleanText(sourceRecordId, 100),
        normalized.taskScore,
        JSON.stringify(normalized)
      ]);
      await refreshFinal(client, job.attempt_id);
      const grading = await readStatus(client, job.attempt_id);
      const portalSyncRequired = grading.ready && typeof syncErpGrades === 'function';
      if (!portalSyncRequired) {
        await client.query(`UPDATE assessment.term_test_writing_grading_job
        SET status = 'complete', completed_at = now(), lease_until = NULL,
            last_error_code = NULL, updated_at = now()
        WHERE id = $1::uuid;`, [jobId]);
      }
      return {
        status: 'accepted',
        grading,
        portalSyncRequired,
        attemptId: job.attempt_id
      };
    });

    if (!stored.portalSyncRequired) {
      return { status: stored.status, grading: stored.grading, portalSyncStatus: 'not_applicable' };
    }

    const attemptResult = await pool.query(`SELECT
      id::text AS attempt_token,
      test_slug,
      erp_course_class_id::text AS class_id,
      erp_student_contact_id::text AS student_id,
      class_name_snapshot AS class_name,
      combined_result
    FROM assessment.term_test_attempt
    WHERE id = $1::uuid
      AND completed_at IS NOT NULL
      AND writing_submitted_at IS NOT NULL;`, [stored.attemptId]);
    if (attemptResult.rows.length !== 1) {
      throw new TermTestWritingGradingError(
        'WRITING_PORTAL_ATTEMPT_NOT_FOUND',
        'Không tìm thấy bài đã hoàn tất để ghi điểm Writing.',
        500
      );
    }

    const attempt = attemptResult.rows[0];
    const isDemo = String(attempt.class_name || '').trim().toUpperCase() === 'CODEXDEMO806';
    let portalSyncStatus = 'not_applicable';
    if (!isDemo && /^term-test-[1-9][0-9]*$/.test(String(attempt.test_slug || ''))) {
      try {
        const syncResult = await syncErpGrades(buildErpGradePayload(
          attempt,
          attempt.combined_result,
          { writing: stored.grading.writingScore }
        ));
        portalSyncStatus = syncResult?.status === 'synced' ? 'synced' : 'not_applicable';
      } catch {
        // Giữ job ở trạng thái processing để n8n gọi /fail và đưa lại vào hàng chờ.
        // Kết quả chấm đã được lưu; chỉ riêng bước ghi Portal sẽ tự thử lại.
        throw new TermTestWritingGradingError(
          'WRITING_PORTAL_SYNC_FAILED',
          'Portal đang bận; hệ thống sẽ tự thử ghi lại điểm Writing.',
          503
        );
      }
    }

    await inTransaction(pool, async client => {
      const finalized = await client.query(`UPDATE assessment.term_test_writing_grading_job
      SET status = 'complete', completed_at = now(), lease_until = NULL,
          last_error_code = NULL, updated_at = now()
      WHERE id = $1::uuid
        AND status = 'processing'
        AND worker_id = $2
      RETURNING id::text;`, [jobId, workerId]);
      if (finalized.rows.length !== 1) {
        throw new TermTestWritingGradingError(
          'WRITING_GRADING_JOB_LEASE_MISMATCH',
          'Việc ghi điểm Portal không còn thuộc tiến trình này.',
          409
        );
      }
    });
    return { status: 'accepted', grading: stored.grading, portalSyncStatus };
  }

  async function failJob({ jobId, workerId, errorCode }) {
    const safeCode = cleanText(errorCode || 'WRITING_GRADING_WORKER_FAILED', 100).trim().toUpperCase();
    if (!/^[A-Z0-9_:-]{3,100}$/.test(safeCode)) {
      throw new TermTestWritingGradingError('WRITING_GRADING_INVALID_ERROR', 'Mã lỗi không hợp lệ.', 400);
    }
    return inTransaction(pool, async client => {
      const jobResult = await client.query(`SELECT
        job.id::text, job.status, job.worker_id, job.job_type,
        job.attempt_count, job.max_attempts, job.run_id::text,
        run.run_key
      FROM assessment.term_test_writing_grading_job AS job
      JOIN assessment.term_test_writing_grading_run AS run ON run.id = job.run_id
      WHERE job.id = $1::uuid
      FOR UPDATE;`, [jobId]);
      if (jobResult.rows.length !== 1) {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_NOT_FOUND', 'Không tìm thấy việc lỗi.', 404);
      }
      const job = jobResult.rows[0];
      if (job.status === 'complete') return { status: 'already_complete' };
      if (job.status !== 'processing' || job.worker_id !== workerId) {
        throw new TermTestWritingGradingError('WRITING_GRADING_JOB_LEASE_MISMATCH', 'Việc lỗi không thuộc tiến trình này.', 409);
      }
      const terminal = Number(job.attempt_count) >= Number(job.max_attempts);
      const delaySeconds = job.job_type === 'collect'
        ? Math.min(300, 45 * Math.max(1, Number(job.attempt_count)))
        : Math.min(3600, 30 * (2 ** Math.min(6, Number(job.attempt_count) - 1)));
      await client.query(`UPDATE assessment.term_test_writing_grading_job
      SET status = $2,
          next_attempt_at = CASE WHEN $2 = 'failed' THEN next_attempt_at ELSE now() + ($3 * interval '1 second') END,
          lease_until = NULL,
          last_error_code = $4,
          completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
          updated_at = now()
      WHERE id = $1::uuid;`, [jobId, terminal ? 'failed' : 'retry_wait', delaySeconds, safeCode]);
      await client.query(`UPDATE assessment.term_test_writing_grading_run
      SET status = $2,
          last_error_code = $3,
          updated_at = now()
      WHERE id = $1::uuid
        AND status <> 'complete';`, [job.run_id, terminal ? 'review_required' : (job.job_type === 'collect' ? 'grading' : 'retry_wait'), safeCode]);
      return {
        status: terminal ? 'review_required' : 'retry_wait',
        runKey: job.run_key,
        retryAfterSeconds: terminal ? null : delaySeconds
      };
    });
  }

  async function getStatus(attemptToken) {
    return readStatus(pool, attemptToken);
  }

  async function getJobImage(jobId) {
    const result = await pool.query(`SELECT run.prompt_image_url
    FROM assessment.term_test_writing_grading_job AS job
    JOIN assessment.term_test_writing_grading_run AS run ON run.id = job.run_id
    WHERE job.id = $1::uuid
      AND run.task_number = 1;`, [jobId]);
    return result.rows[0]?.prompt_image_url || null;
  }

  return { ensureSubmission, claimJobs, completeDispatch, completeResult, failJob, getStatus, getJobImage };
}
