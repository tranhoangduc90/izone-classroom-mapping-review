import { createHash } from 'node:crypto';
import { canonical, JournalError, requireValue } from '../exam-journal-runtime/src/contract.mjs';
import { isK67TermPilot, selectNewK67JournalRoute, validateK67DrainRenewal } from './k67-pilot-route.mjs';

const scopeHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const legacy = reason => ({ ok: true, destination: 'collector-v1', reason });
// Listening-first CBT can retain attempt_mode=legacy after preparation. The
// native CBT journey at the same generation is the additional proof for it.

export const pilotEnrollmentSchema = `CREATE TABLE assessment.journal_k67_pilot_enrollment (
  pilot_id text NOT NULL,
  scope_id text NOT NULL,
  renew_until_ms bigint NOT NULL,
  PRIMARY KEY (pilot_id, scope_id)
)`;

// Mount beside the old journal context API. The resolver and scope derivation are
// the product's own operations so old and new journals agree on the binding ID.
export function mountK67PilotContext(app, { query, resolveOwner, scopeForOwner, getPilot, ticketFor, allowedOrigins,
  clock = Date.now, testSlug = 'term-test-2' }) {
  requireValue(isK67TermPilot(testSlug), 'PILOT_TEST_INVALID', 500);
  const journey = testSlug === 'mini-test-lesson-5' ? 'assessment.mini_k67_cbt_journey' : 'assessment.term_k67_cbt_journey';
  const verifiedCbt = `(s.attempt_mode='cbt' OR (s.attempt_mode='legacy' AND EXISTS (
    SELECT 1 FROM ${journey} j WHERE j.session_id=s.id AND j.generation=s.generation)))`;
  app.post('/api/term-tests/' + testSlug + '/journal-pilot-context', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      requireValue(allowedOrigins.has(req.get('origin')), 'ORIGIN_DENIED', 403);
      const { examSessionToken, attemptToken, sealed } = req.body ?? {};
      const now = clock();
      const pilot = await getPilot();
      if (!sealed && pilot?.enabled !== true) return res.json(legacy('pilot_disabled'));
      requireValue(examSessionToken || attemptToken, 'JOURNAL_OWNER_DENIED', 401);
      const resolved = await resolveOwner({ examSessionToken, attemptToken }, { testSlug });
      const scope = scopeForOwner(resolved);
      requireValue(scope.testSlug === testSlug && scope.product === 'term-mini-k67', 'PILOT_SCOPE_DENIED', 403);
      const scopeId = scopeHash(scope);
      const owner = { ...scope, verified: resolved.identityConfirmed !== false, scopeId };

      if (sealed) {
        requireValue(typeof sealed.pilotId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(sealed.pilotId), 'PILOT_SEAL_INVALID', 400);
        const { rows: [enrollment] } = await query(`SELECT pilot_id AS "pilotId", scope_id AS "scopeId", renew_until_ms AS "renewUntil"
          FROM assessment.journal_k67_pilot_enrollment WHERE pilot_id=$1 AND scope_id=$2`, [sealed.pilotId, scopeId]);
        const validated = validateK67DrainRenewal(owner, enrollment && { ...enrollment,
          destination: 'pubsub-v1', renewUntil: Number(enrollment.renewUntil) }, sealed, now);
        requireValue(validated.allowed, 'PILOT_DRAIN_' + (validated.reason ?? 'DENIED').toUpperCase(), 403);
        const auth = ticketFor(enrollment.pilotId).issue(scope, validated, validated.renewUntil);
        return res.json({ ok: true, pilotId: enrollment.pilotId, bindingId: scopeId, destination: 'pubsub-v1', ...auth });
      }

      const { rows: [session] } = await query(`SELECT CASE WHEN ${verifiedCbt} THEN 'cbt' ELSE s.attempt_mode END AS mode,
        s.prepared_at AS "preparedAt", s.superseded_at IS NOT NULL AS superseded
        FROM assessment.term_test_exam_session s WHERE s.id=$1 AND s.generation=$2 AND s.test_slug=$3
          AND s.class_name_snapshot=$4 AND s.erp_student_contact_id::text=$5`,
      [resolved.sourceId, scope.generation, scope.testSlug, scope.classCode, scope.studentRef]);
      const preparedAt = session?.preparedAt instanceof Date ? session.preparedAt.getTime() : NaN;
      const route = selectNewK67JournalRoute({ ...owner, mode: session?.mode, superseded: session?.superseded, preparedAt }, pilot, now, testSlug);
      if (route.destination !== 'pubsub-v1') return res.json(legacy(route.reason));
      const enrolled = await query(`WITH eligible AS (
        SELECT 1 FROM assessment.term_test_exam_session s WHERE s.id=$4 AND s.generation=$5 AND s.superseded_at IS NULL
          AND ${verifiedCbt} AND s.test_slug=$6 AND s.class_name_snapshot=$7 AND s.erp_student_contact_id::text=$8
          AND s.prepared_at >= to_timestamp($9::double precision / 1000) AND s.prepared_at <= to_timestamp($10::double precision / 1000)
        ), inserted AS (
          INSERT INTO assessment.journal_k67_pilot_enrollment (pilot_id,scope_id,renew_until_ms)
          SELECT $1,$2,$3 FROM eligible
          ON CONFLICT (pilot_id,scope_id) DO NOTHING
          RETURNING renew_until_ms
        ) SELECT renew_until_ms FROM inserted
        UNION ALL SELECT renew_until_ms FROM assessment.journal_k67_pilot_enrollment
        WHERE pilot_id=$1 AND scope_id=$2 AND EXISTS (SELECT 1 FROM eligible)
        LIMIT 1`, [pilot.pilotId, scopeId, pilot.renewUntil, resolved.sourceId, scope.generation, scope.testSlug,
        scope.classCode, scope.studentRef, pilot.opensAt, now]);
      if (!enrolled.rows.length) return res.json(legacy('owner_changed'));
      const notAfter = Math.min(pilot.closesAt, Number(enrolled.rows[0].renew_until_ms));
      const auth = ticketFor(pilot.pilotId).issue(scope, null, notAfter);
      return res.json({ ok: true, pilotId: pilot.pilotId, bindingId: scopeId, destination: 'pubsub-v1', ...auth });
    } catch (error) {
      return res.status(error instanceof JournalError ? error.status : 503).json({ ok: false,
        error: error instanceof JournalError ? error.code : 'PILOT_CONTEXT_UNAVAILABLE' });
    }
  });
}
