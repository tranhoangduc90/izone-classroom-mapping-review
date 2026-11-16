import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonical } from '../exam-journal-runtime/src/contract.mjs';
import { termOwnerResolver } from '../exam-journal-runtime/adapters/term.mjs';
import { mountK67PilotContext } from './k67-pilot-native-context.mjs';
import { createK67PilotTicket } from './k67-pilot-ticket.mjs';

const hex = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

function mountJournalCloud(app, { pool, journal, allowedOrigins, env }, testSlug, name) {
  const root = '/api/term-tests/' + testSlug;
  const configPath = env[name + '_PILOT_FILE'];
  const pilotId = env[name + '_PILOT_ID'];
  const keyPath = env[name + '_APPEND_KEY_FILE'];
  const keyValue = env[name + '_APPEND_KEY'];
  const rawKey = keyPath ? readFileSync(keyPath, 'utf8').trim() : keyValue;
  if (!configPath || !/^[a-zA-Z0-9_-]{1,40}$/.test(pilotId ?? '') || !rawKey) throw Error('TERM1_JOURNAL_PILOT_CONFIG_INVALID');
  const codec = createK67PilotTicket({ keys: { pilot: Buffer.from(rawKey, 'base64') }, currentKeyId: 'pilot', pilotId });
  const getPilot = async () => {
    try {
      const { enabled, classCode, opensAt, closesAt, renewUntil } = JSON.parse(await readFile(configPath, 'utf8'));
      return { enabled, classCode, opensAt, closesAt, renewUntil, pilotId };
    } catch {
      return { enabled: false };
    }
  };
  const query = pool.query.bind(pool);
  mountK67PilotContext(app, {
    query, resolveOwner: termOwnerResolver({ query, schema: 'assessment' }),
    scopeForOwner: journal.scopeForOwner, allowedOrigins, getPilot, testSlug,
    ticketFor(id) {
      if (id !== pilotId) throw Error('TERM1_JOURNAL_PILOT_ID_DENIED');
      return codec;
    },
  });
  app.post(root + '/journal-collector-sealed', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!allowedOrigins.has(req.get('origin'))) return res.status(403).json({ error: 'ORIGIN_DENIED' });
    const { bindingId, batchId, eventPayloadSha256, events } = req.body ?? {};
    if (!hex.test(bindingId ?? '') || !hex.test(batchId ?? '') || !hex.test(eventPayloadSha256 ?? '')
      || !Array.isArray(events) || events.length === 0 || events.length > 100 || !events.every(row => typeof row?.id === 'string')
      || hash(events) !== eventPayloadSha256 || hash([bindingId, events.map(row => row?.id).sort()]) !== batchId) {
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

export function mountTerm1JournalCloud(app, options) {
  return mountJournalCloud(app, options, 'term-test-1', 'K67_TERM1_JOURNAL');
}

export function mountMiniJournalCloud(app, options) {
  return mountJournalCloud(app, options, 'mini-test-lesson-5', 'K67_MINI_JOURNAL');
}
