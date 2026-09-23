import { z } from 'zod';
import crypto, { createHash } from 'node:crypto';
import { buildK56PortalGrades, isK56PortalPilot } from './k56-portal-pilot.js';

const syncResponseSchema = z.object({
  ok: z.literal(true),
  status: z.literal('synced'),
  attemptToken: z.string().uuid()
});

function numericBand(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === '<2.5') return 2;
  return null;
}

function syncFingerprint(payload) {
  const grades = Object.fromEntries(Object.entries(payload.grades || {}).sort(([left], [right]) => left.localeCompare(right)));
  return crypto.createHash('sha256').update(JSON.stringify({
    version: payload.version,
    attemptToken: payload.attemptToken,
    testSlug: payload.testSlug,
    classId: payload.classId,
    studentId: payload.studentId,
    grades
  })).digest('hex');
}

function isTimeoutError(error) {
  return ['AbortError', 'TimeoutError'].includes(String(error?.name || ''))
    || /timeout|timed out/i.test(String(error?.message || ''));
}

async function claimK56SyncState(pool, payload, fingerprint) {
  if (!pool) return { claimed: true };
  const inserted = await pool.query(`INSERT INTO assessment.term_test_portal_sync_state (
      attempt_id, payload_fingerprint, test_slug, grade_fields, status, attempted_at, updated_at
    ) VALUES ($1::uuid, $2, $3, $4::text[], 'processing', now(), now())
    ON CONFLICT (attempt_id, payload_fingerprint) DO NOTHING
    RETURNING status;`, [
    payload.attemptToken,
    fingerprint,
    payload.testSlug,
    Object.keys(payload.grades || {}).sort()
  ]);
  if (inserted.rowCount === 1) return { claimed: true };
  const existing = await pool.query(`UPDATE assessment.term_test_portal_sync_state
    SET status = CASE
          WHEN status = 'processing' AND attempted_at < now() - interval '45 seconds' THEN 'unknown'
          ELSE status
        END,
        error_code = CASE
          WHEN status = 'processing' AND attempted_at < now() - interval '45 seconds' THEN 'ERP_SYNC_PROCESS_INTERRUPTED'
          ELSE error_code
        END,
        completed_at = CASE
          WHEN status = 'processing' AND attempted_at < now() - interval '45 seconds' THEN now()
          ELSE completed_at
        END,
        updated_at = now()
    WHERE attempt_id = $1::uuid
      AND payload_fingerprint = $2
    RETURNING status;`, [payload.attemptToken, fingerprint]);
  return { claimed: false, status: existing.rows[0]?.status || 'unknown' };
}

async function markK56SyncFinished(pool, payload, fingerprint, status, details) {
  if (!pool) return;
  await pool.query(`UPDATE assessment.term_test_portal_sync_state
    SET status = $3,
        http_status = $4::int,
        error_code = $5,
        duration_ms = $6::int,
        completed_at = now(),
        updated_at = now()
    WHERE attempt_id = $1::uuid
      AND payload_fingerprint = $2;`, [
    payload.attemptToken,
    fingerprint,
    status,
    details.httpStatus ?? null,
    details.errorCode || null,
    details.durationMs
  ]);
}

export function buildErpGradePayload(attempt, combinedResult, extraGrades = {}) {
  const listening = numericBand(combinedResult?.listening?.band);
  const reading = numericBand(combinedResult?.reading?.band);
  const writing = numericBand(extraGrades.writing);
  const grades = {};
  if (listening !== null) grades.listening = listening;
  if (reading !== null) grades.reading = reading;
  if (writing !== null) grades.writing = writing;

  return {
    version: 1,
    attemptToken: String(attempt.attempt_token),
    testSlug: String(attempt.test_slug || attempt.slug),
    classId: String(attempt.class_id),
    studentId: String(attempt.student_id),
    grades: String(attempt.test_slug || attempt.slug).endsWith('-k56')
      ? buildK56PortalGrades(attempt, combinedResult, extraGrades)
      : grades
  };
}

// Gửi Band sang n8n; n8n giữ credential ERP và tự kiểm tra chống ghi đè.
export function createErpGradeSync({ config, pool = null, fetchImpl = globalThis.fetch, logger = console }) {
  if (config.demoIsolatedMode || !config.erpSyncUrl) return async () => ({ status: 'disabled' });

  return async function syncErpGrades(payload) {
    const isK56 = String(payload.testSlug).endsWith('-k56');
    if (config.k56PortalPilotEnabled && !isK56) return { status: 'disabled' };
    if (isK56) {
      if (!config.k56PortalPilotEnabled || !isK56PortalPilot({
        test_slug: payload.testSlug,
        class_id: payload.classId,
        student_id: payload.studentId
      }) || !Object.keys(payload.grades || {}).length) return { status: 'disabled' };

      const fingerprint = syncFingerprint(payload);
      const claim = await claimK56SyncState(pool, payload, fingerprint);
      if (!claim.claimed) {
        logger.info?.(`ERP grade sync skipped final_status=${claim.status} fingerprint=${fingerprint.slice(0, 12)}`);
        return { status: claim.status, skipped: true };
      }
      const startedAt = Date.now();
      let response;
      try {
        response = await fetchImpl(config.erpSyncUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-term-test-sync': config.erpSyncSecret
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(config.erpSyncTimeoutMs)
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const status = isTimeoutError(error) ? 'unknown' : 'failed_response';
        const errorCode = isTimeoutError(error) ? 'ERP_SYNC_TIMEOUT' : 'ERP_SYNC_NETWORK_ERROR';
        await markK56SyncFinished(pool, payload, fingerprint, status, { errorCode, durationMs });
        logger.error?.(`ERP grade sync communication_error status=${status} code=${errorCode} duration_ms=${durationMs} fingerprint=${fingerprint.slice(0, 12)}`);
        return { status, errorCode, durationMs };
      }
      const durationMs = Date.now() - startedAt;
      if (!response.ok) {
        await markK56SyncFinished(pool, payload, fingerprint, 'failed_response', {
          errorCode: 'ERP_SYNC_HTTP_ERROR',
          httpStatus: response.status,
          durationMs
        });
        return { status: 'failed_response', errorCode: 'ERP_SYNC_HTTP_ERROR', httpStatus: response.status, durationMs };
      }
      let parsed;
      try {
        parsed = syncResponseSchema.safeParse(await response.json());
      } catch {
        parsed = { success: false };
      }
      if (!parsed.success || parsed.data.attemptToken !== payload.attemptToken) {
        await markK56SyncFinished(pool, payload, fingerprint, 'unknown', {
          errorCode: 'ERP_SYNC_INVALID_RESPONSE',
          httpStatus: response.status,
          durationMs
        });
        return { status: 'unknown', errorCode: 'ERP_SYNC_INVALID_RESPONSE', httpStatus: response.status, durationMs };
      }
      await markK56SyncFinished(pool, payload, fingerprint, 'synced', {
        httpStatus: response.status,
        durationMs
      });
      return { ...parsed.data, durationMs };
    }

    // Chỉ ghi mã băm để nối log cùng lượt nộp, không ghi bài làm, điểm hoặc danh tính.
    // Khi timeout, Portal có thể vẫn đang ghi: báo trạng thái chưa rõ, không tự gửi lặp tại đây.
    const started = Date.now();
    const correlation = createHash('sha256').update(String(payload.attemptToken)).digest('hex').slice(0, 16);
    let httpStatus = null;
    try {
      const response = await fetchImpl(config.erpSyncUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-term-test-sync': config.erpSyncSecret
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.erpSyncTimeoutMs)
      });
      httpStatus = response.status || null;
      if (!response.ok) throw new Error('ERP_SYNC_HTTP_ERROR');
      let body;
      try { body = await response.json(); }
      catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
        throw new Error('ERP_SYNC_INVALID_JSON');
      }
      const parsed = syncResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.attemptToken !== payload.attemptToken) {
        throw new Error('ERP_SYNC_INVALID_RESPONSE');
      }
      logger.info(JSON.stringify({ event: 'erp_grade_sync', correlation, status: 'synced', httpStatus, elapsedMs: Date.now() - started }));
      return parsed.data;
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const code = timeout ? 'ERP_SYNC_TIMEOUT' : ['ERP_SYNC_HTTP_ERROR', 'ERP_SYNC_INVALID_JSON', 'ERP_SYNC_INVALID_RESPONSE'].includes(error?.message)
        ? error.message : 'ERP_SYNC_NETWORK_ERROR';
      logger.error(JSON.stringify({ event: 'erp_grade_sync', correlation, status: 'unknown', code, httpStatus, elapsedMs: Date.now() - started, timeoutMs: config.erpSyncTimeoutMs }));
      const failure = new Error(code);
      failure.code = code;
      throw failure;
    }
  };
}
