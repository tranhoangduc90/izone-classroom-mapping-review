import { z } from 'zod';

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
    grades
  };
}

// Gửi Band sang n8n; n8n giữ credential ERP và tự kiểm tra chống ghi đè.
export function createErpGradeSync({ config, fetchImpl = globalThis.fetch }) {
  if (!config.erpSyncUrl) return async () => ({ status: 'disabled' });

  return async function syncErpGrades(payload) {
    const response = await fetchImpl(config.erpSyncUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-term-test-sync': config.erpSyncSecret
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.erpSyncTimeoutMs)
    });
    if (!response.ok) throw new Error('ERP_SYNC_HTTP_ERROR');
    const parsed = syncResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.attemptToken !== payload.attemptToken) {
      throw new Error('ERP_SYNC_INVALID_RESPONSE');
    }
    return parsed.data;
  };
}
