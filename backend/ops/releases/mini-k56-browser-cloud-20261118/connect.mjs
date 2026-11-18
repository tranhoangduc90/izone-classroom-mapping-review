import { readFileSync } from 'node:fs';
import { canonical, JournalError } from '../exam-journal-runtime/src/contract.mjs';
import { termOwnerResolver } from '../exam-journal-runtime/adapters/term.mjs';
import { createK67PilotTicket } from '../term1-journal-cloud/k67-pilot-ticket.mjs';
import { mountMiniK56BrowserCloud, pilotId } from './mount.mjs';

export function connectMiniK56BrowserCloud(app, { pool, journal, allowedOrigins, env }) {
  const raw = readFileSync(env.K56_MINI_CBT_BROWSER_APPEND_KEY_FILE, 'utf8').trim();
  if (!/^[a-zA-Z0-9+/]{43}=$/.test(raw)) throw Error('K56_MINI_BROWSER_APPEND_KEY_INVALID');
  const tickets = createK67PilotTicket({ keys: { pilot: Buffer.from(raw, 'base64') }, currentKeyId: 'pilot', pilotId });
  const query = pool.query.bind(pool);
  const resolveOwner = termOwnerResolver({ query, schema: 'assessment_k56' });
  mountMiniK56BrowserCloud(app, { query, resolveOwner, journal, tickets, allowedOrigins, canonical, JournalError,
    policyFile: env.K56_MINI_CBT_BROWSER_POLICY_FILE });
}
