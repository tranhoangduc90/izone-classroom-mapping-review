import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const slug = 'mini-test-k56';
const product = 'term-mini-k56';
export const pilotId = 'k56-mini-261116';
const base = '/api/term-tests/' + slug;
const hex = /^[a-f0-9]{64}$/;
const table = 'assessment_k56.journal_mini_cbt_cloud_enrollment';

export function mountMiniK56BrowserCloud(app, {
  query, resolveOwner, journal, tickets, allowedOrigins, canonical, JournalError,
  policyFile, clock = Date.now,
}) {
  const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
  const legacy = reason => ({ ok: true, destination: 'collector-v1', reason });
  const fail = (res, status, error) => res.status(status).json({ ok: false, error });

  app.post(base + '/journal-pilot-context', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!allowedOrigins.has(req.get('origin'))) return fail(res, 403, 'ORIGIN_DENIED');
    const { examSessionToken, attemptToken, sealed } = req.body ?? {};
    const now = clock();
    try {
      let policy;
      if (sealed == null) {
        policy = await readFile(policyFile, 'utf8').then(JSON.parse).catch(() => null);
        if (policy?.enabled !== true) return res.json(legacy('pilot_disabled'));
        if (![policy.opensAt, policy.closesAt, policy.renewUntil].every(Number.isSafeInteger)
          || now < policy.opensAt || now >= policy.closesAt || policy.closesAt >= policy.renewUntil) {
          return res.json(legacy('outside_pilot_window'));
        }
      }
      if (!examSessionToken && !attemptToken) return fail(res, 401, 'JOURNAL_OWNER_DENIED');
      const owner = await resolveOwner({ examSessionToken, attemptToken }, { testSlug: slug });
      if (!owner || owner.identityConfirmed === false || owner.versions?.superseded) {
        return fail(res, 403, 'PILOT_SCOPE_DENIED');
      }
      const scope = journal.scopeForOwner(owner);
      if (scope.product !== product || scope.testSlug !== slug || !/^[A-Z0-9._-]{2,32}$/.test(scope.classCode)) {
        return fail(res, 403, 'PILOT_SCOPE_DENIED');
      }
      const scopeId = digest(scope);
      const ownerParams = [owner.sourceId, scope.generation, slug, scope.classCode, scope.studentRef];
      const ownsCbt = `SELECT 1 FROM assessment_k56.term_test_exam_session s
        WHERE s.id=$1 AND s.generation=$2 AND s.superseded_at IS NULL AND s.attempt_mode='cbt'
          AND s.test_slug=$3 AND s.class_name_snapshot=$4 AND s.erp_student_contact_id::text=$5`;
      let notAfter;
      if (sealed != null) {
        if (sealed.destination !== 'pubsub-v1' || sealed.pilotId !== pilotId || sealed.scopeId !== scopeId
          || !hex.test(sealed.batchId ?? '') || !hex.test(sealed.eventPayloadSha256 ?? '')) {
          return fail(res, 403, 'PILOT_DRAIN_ORIGINAL_SCOPE_UNVERIFIED');
        }
        const { rows: [known] } = await query(`SELECT renew_until_ms FROM ${table}
          WHERE pilot_id=$6 AND scope_id=$7 AND renew_until_ms>$8 AND EXISTS (${ownsCbt})`,
        [...ownerParams, pilotId, scopeId, now]);
        if (!known) return fail(res, 403, 'PILOT_DRAIN_ORIGINAL_SCOPE_UNVERIFIED');
        notAfter = Number(known.renew_until_ms);
      } else {
        // A concurrent first grant may win the insert. Read its durable expiry
        // in a separate statement so a conflict cannot hide a valid enrollment.
        const eligible = `${ownsCbt} AND s.prepared_at BETWEEN
          to_timestamp($6::double precision / 1000) AND to_timestamp($7::double precision / 1000)`;
        const params = [...ownerParams, policy.opensAt, now, pilotId, scopeId];
        const { rows: [inserted] } = await query(`INSERT INTO ${table} (pilot_id,scope_id,renew_until_ms)
          SELECT $8,$9,$10 WHERE EXISTS (${eligible}) ON CONFLICT (pilot_id,scope_id) DO NOTHING
          RETURNING renew_until_ms`, [...params, policy.renewUntil]);
        const enrolled = inserted ?? (await query(`SELECT renew_until_ms FROM ${table}
          WHERE pilot_id=$8 AND scope_id=$9 AND EXISTS (${eligible})`, params)).rows[0];
        if (!enrolled) return res.json(legacy('owner_outside_pilot'));
        notAfter = Math.min(policy.closesAt, Number(enrolled.renew_until_ms));
      }
      return res.json({ ok: true, destination: 'pubsub-v1', pilotId, bindingId: scopeId,
        ...tickets.issue(scope, sealed ?? null, notAfter) });
    } catch (error) {
      return fail(res, error instanceof JournalError ? error.status : 503,
        error instanceof JournalError ? error.code : 'PILOT_CONTEXT_UNAVAILABLE');
    }
  });

  app.post(base + '/journal-collector-sealed', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (!allowedOrigins.has(origin)) return fail(res, 403, 'ORIGIN_DENIED');
    const { bindingId, batchId, eventPayloadSha256, events } = req.body ?? {};
    if (!hex.test(bindingId ?? '') || !hex.test(batchId ?? '') || !hex.test(eventPayloadSha256 ?? '')
      || !Array.isArray(events) || !events.length || events.length > 100
      || !events.every(row => typeof row?.id === 'string') || digest(events) !== eventPayloadSha256
      || digest([bindingId, events.map(row => row.id).sort()]) !== batchId) {
      return fail(res, 409, 'PILOT_BATCH_HASH_MISMATCH');
    }
    try {
      const { status, body } = await journal.collect({ method: 'POST', headers: { origin }, body: req.body }, { testSlug: slug });
      return res.status(status).json(body?.persisted === true ? {
        ...body, storage: 'collector', scopeId: bindingId, batchId, eventPayloadSha256,
      } : body);
    } catch (error) {
      return fail(res, error instanceof JournalError ? error.status : 503,
        error instanceof JournalError ? error.code : 'COLLECTOR_UNAVAILABLE');
    }
  });
}
