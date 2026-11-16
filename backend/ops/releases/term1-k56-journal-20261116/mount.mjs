import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { canonical, JournalError } from '../exam-journal-runtime/src/contract.mjs';
import { termOwnerResolver } from '../exam-journal-runtime/adapters/term.mjs';
import { createK67PilotTicket } from './k67-pilot-ticket.mjs';

const product = 'term-mini-k56';
const hex = /^[a-f0-9]{64}$/;
const classCode = /^[A-Z0-9._-]{2,32}$/;
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const legacy = reason => ({ ok: true, destination: 'collector-v1', reason });

export function mountK56Term1Cloud(app, options) {
  return mountK56TermCloud(app, options, 1);
}

export function mountK56Term2Cloud(app, options) {
  return mountK56TermCloud(app, options, 2);
}

function mountK56TermCloud(app, { pool, journal, allowedOrigins, env, clock = Date.now }, term) {
  const testSlug = `term-test-${term}-k56`;
  const pilotId = `k56-term${term}-261116`;
  const root = '/api/term-tests/' + testSlug;
  const table = `assessment_k56.journal_term${term}_cloud_enrollment`;
  const path = env[`K56_TERM${term}_JOURNAL_POLICY_FILE`];
  const key = readFileSync(env[`K56_TERM${term}_JOURNAL_APPEND_KEY_FILE`], 'utf8').trim();
  const tickets = createK67PilotTicket({ keys: { pilot: Buffer.from(key, 'base64') },
    currentKeyId: 'pilot', pilotId, clock });
  const query = pool.query.bind(pool);
  const ownerFor = termOwnerResolver({ query, schema: 'assessment_k56' });

  app.post(root + '/journal-pilot-context', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!allowedOrigins.has(req.get('origin'))) return res.status(403).json({ ok: false, error: 'ORIGIN_DENIED' });
    const { examSessionToken, attemptToken, sealed } = req.body ?? {};
    const now = clock();
    try {
      let policy = null;
      if (!sealed) {
        policy = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
        if (policy?.enabled !== true) return res.json(legacy('pilot_disabled'));
        if (![policy.opensAt,policy.closesAt,policy.renewUntil].every(Number.isSafeInteger)
          || now < policy.opensAt || now >= policy.closesAt || policy.closesAt >= policy.renewUntil) {
          return res.json(legacy('outside_pilot_window'));
        }
      }
      if (!examSessionToken && !attemptToken) return res.status(401).json({ ok: false, error: 'JOURNAL_OWNER_DENIED' });
      const owner = await ownerFor({ examSessionToken, attemptToken }, { testSlug });
      const scope = journal.scopeForOwner(owner);
      if (owner.identityConfirmed === false || scope.product !== product || scope.testSlug !== testSlug
        || !classCode.test(scope.classCode)) return res.status(403).json({ ok: false, error: 'PILOT_SCOPE_DENIED' });
      const scopeId = hash(scope);
      let renewUntil;
      if (sealed) {
        if (sealed.destination !== 'pubsub-v1' || sealed.pilotId !== pilotId || sealed.scopeId !== scopeId
          || !hex.test(sealed.batchId ?? '') || !hex.test(sealed.eventPayloadSha256 ?? '')) {
          return res.status(403).json({ ok: false, error: 'PILOT_DRAIN_ORIGINAL_SCOPE_UNVERIFIED' });
        }
        const { rows: [known] } = await query(`SELECT renew_until_ms FROM ${table}
          WHERE pilot_id=$1 AND scope_id=$2 AND renew_until_ms>$3`, [pilotId, scopeId, now]);
        if (!known) return res.status(403).json({ ok: false, error: 'PILOT_DRAIN_ORIGINAL_SCOPE_UNVERIFIED' });
        renewUntil = Number(known.renew_until_ms);
      } else {
        const { rows: [enrolled] } = await query(`WITH eligible AS (
          SELECT 1 FROM assessment_k56.term_test_exam_session s WHERE s.id=$4 AND s.generation=$5
            AND s.superseded_at IS NULL AND s.attempt_mode='cbt' AND s.test_slug=$6
            AND s.class_name_snapshot=$7 AND s.erp_student_contact_id::text=$8
            AND s.prepared_at >= to_timestamp($9::double precision / 1000)
            AND s.prepared_at <= to_timestamp($10::double precision / 1000)
        ), inserted AS (
          INSERT INTO ${table} (pilot_id,scope_id,renew_until_ms)
          SELECT $1,$2,$3 FROM eligible ON CONFLICT (pilot_id,scope_id) DO NOTHING RETURNING renew_until_ms
        ) SELECT renew_until_ms FROM inserted
        UNION ALL SELECT renew_until_ms FROM ${table}
          WHERE pilot_id=$1 AND scope_id=$2 AND EXISTS (SELECT 1 FROM eligible) LIMIT 1`,
        [pilotId, scopeId, policy.renewUntil, owner.sourceId, scope.generation, testSlug,
          scope.classCode, scope.studentRef, policy.opensAt, now]);
        if (!enrolled) return res.json(legacy('owner_outside_pilot'));
        renewUntil = Math.min(policy.closesAt, Number(enrolled.renew_until_ms));
      }
      const grant = tickets.issue(scope, sealed || null, renewUntil);
      return res.json({ ok: true, pilotId, bindingId: scopeId, destination: 'pubsub-v1', ...grant });
    } catch (error) {
      return res.status(error instanceof JournalError ? error.status : 503).json({ ok: false,
        error: error instanceof JournalError ? error.code : 'PILOT_CONTEXT_UNAVAILABLE' });
    }
  });

  app.post(root + '/journal-collector-sealed', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!allowedOrigins.has(req.get('origin'))) return res.status(403).json({ error: 'ORIGIN_DENIED' });
    const { bindingId, batchId, eventPayloadSha256, events } = req.body ?? {};
    if (!hex.test(bindingId ?? '') || !hex.test(batchId ?? '') || !hex.test(eventPayloadSha256 ?? '')
      || !Array.isArray(events) || !events.length || events.length > 100 || !events.every(row => typeof row?.id === 'string')
      || hash(events) !== eventPayloadSha256 || hash([bindingId, events.map(row => row.id).sort()]) !== batchId) {
      return res.status(409).json({ error: 'PILOT_BATCH_HASH_MISMATCH' });
    }
    try {
      const result = await journal.collect({ method: 'POST', headers: { origin: req.get('origin') }, body: req.body }, { testSlug });
      return res.status(result.status).json(result.body?.persisted ? {
        ...result.body, storage: 'collector', scopeId: bindingId, batchId, eventPayloadSha256,
      } : result.body);
    } catch {
      return res.status(503).json({ error: 'COLLECTOR_UNAVAILABLE' });
    }
  });
}
