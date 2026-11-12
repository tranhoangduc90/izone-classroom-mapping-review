import { z } from 'zod';

const offlineTables = new Map([
  ['term-test-1-k56', 'term1_submission_hold'],
  ['term-test-2-k56', 'term2_submission_hold']
]);
const onlineTable = 'term_online_submission_hold';

export async function countActiveTermHolds(db, product, attemptId) {
  const { rows: [attempt] } = await db.query(`SELECT test_slug, erp_course_class_id
    FROM assessment.term_test_attempt WHERE id=$1`, [attemptId]);
  const offlineTable = offlineTables.get(attempt?.test_slug);
  if (!offlineTable || !/^[1-9][0-9]*$/.test(String(attempt.erp_course_class_id))
      || (product !== 'term_online' && offlineTable !== product + '_submission_hold')) {
    throw Error('Missing Term hold class and test scope');
  }
  const key = `k56.term.submission-hold:${attempt.test_slug}:${attempt.erp_course_class_id}`;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  const active = (table) => `SELECT count(*) FROM assessment.${table} held
    JOIN assessment.term_test_attempt a ON a.id=held.attempt_id
    WHERE a.test_slug=$1 AND a.erp_course_class_id=$2 AND held.payload IS NOT NULL
      AND held.expires_at > statement_timestamp()`;
  const { rows: [{ n }] } = await db.query(
    `SELECT ((${active(offlineTable)}) + (${active(onlineTable)}))::int AS n`,
    [attempt.test_slug, attempt.erp_course_class_id]);
  return n;
}

const exportSchema = z.object({
  test: z.enum(['term-test-1-k56', 'term-test-2-k56']),
  classId: z.number().int().positive().safe(),
  attemptId: z.string().uuid(),
  generation: z.number().int().nonnegative().safe(),
  operationId: z.string().uuid(),
  transport: z.enum(['offline', 'online'])
}).strict();

function exportSql(table) {
  return `SELECT held.section, held.payload_hash, held.held_at, held.expires_at,
    held.payload - ARRAY['attemptScopeHash','attemptToken','examSessionToken','ownerId'] AS payload
    FROM assessment.${table} held
    JOIN assessment.term_test_attempt attempt ON attempt.id=held.attempt_id
    WHERE attempt.test_slug=$1 AND attempt.erp_course_class_id=$2
      AND held.attempt_id=$3 AND held.generation=$4 AND held.operation_id=$5
      AND held.payload IS NOT NULL AND held.expires_at > statement_timestamp()
      AND $7::boolean AND EXISTS (
        SELECT 1 FROM mapping.reviewer_account
        WHERE email=$6 AND role='admin' AND status='active'
      )`;
}

export function createTermHoldExport({ queryScoped, record, adminEmail = process.env.K56_TERM_HOLD_EXPORT_ADMIN }) {
  const approvedEmail = (adminEmail || '').trim().toLowerCase();
  return async function exportTermHold(req, res) {
    if (!approvedEmail || !['session', 'google_bearer'].includes(req.authSource)
        || req.reviewer?.email !== approvedEmail || req.reviewer.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'SUBMISSION_HOLD_EXPORT_FORBIDDEN' });
    }
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_SUBMISSION_HOLD_EXPORT' });
    const input = parsed.data;
    const table = input.transport === 'online' ? onlineTable : offlineTables.get(input.test);
    const { rows: [row] } = await queryScoped(req, exportSql(table), [input.test, input.classId,
      input.attemptId, input.generation, input.operationId, approvedEmail, true], 6, 7);
    if (!row) return res.status(404).json({ ok: false, error: 'SUBMISSION_HOLD_NOT_FOUND' });
    try {
      record('offline_submission_hold_read', input.test, input.attemptId, {
        section: row.section, operationId: input.operationId, generation: input.generation,
        phase: 'readback', reason: 'ADMIN_EXPORT', heldAtMs: new Date(row.held_at).getTime(),
        expiresAtMs: new Date(row.expires_at).getTime()
      });
    } catch {}
    res.set('Cache-Control', 'no-store');
    res.attachment('k56-ban-doi-soat.json');
    return res.json({ test: input.test, classId: input.classId, generation: input.generation,
      operationId: input.operationId, transport: input.transport, section: row.section,
      payloadHash: row.payload_hash, heldAt: row.held_at, expiresAt: row.expires_at, payload: row.payload });
  };
}
