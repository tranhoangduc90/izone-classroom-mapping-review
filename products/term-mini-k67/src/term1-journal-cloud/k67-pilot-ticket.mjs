import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, requireValue } from '../exam-journal-runtime/src/contract.mjs';
import { createTicketCodec } from '../exam-journal-runtime/src/ticket.mjs';

const hex = /^[a-f0-9]{64}$/;
const keyFormat = /^[A-Za-z0-9_-]{1,40}$/;
const ticketDomain = 'izone-k67-pilot-ticket-v1\n';

// Use keys dedicated to one pilot. The base encrypted scope stays opaque to the
// browser. The outer tag binds pilot and any batch restriction to that scope.
export function createK67PilotTicket({ keys, currentKeyId, pilotId, clock = Date.now, lifetimeMs = 20 * 60_000 }) {
  requireValue(typeof pilotId === 'string' && keyFormat.test(pilotId) && typeof currentKeyId === 'string'
    && keyFormat.test(currentKeyId) && keys?.[currentKeyId]?.length === 32
    && Number.isSafeInteger(lifetimeMs) && lifetimeMs > 0 && lifetimeMs <= 30 * 60_000, 'PILOT_TICKET_CONFIG', 503);

  function codec(at, ttl = lifetimeMs) { return createTicketCodec({ keys, currentKeyId, clock: () => at, lifetimeMs: ttl }); }
  function digest(keyId, encoded) { return createHmac('sha256', keys[keyId]).update(ticketDomain + encoded).digest(); }

  function issue(scope, sealedBatch = null, notAfter = null) {
    requireValue(sealedBatch === null || (typeof sealedBatch?.batchId === 'string' && hex.test(sealedBatch.batchId)
      && typeof sealedBatch.eventPayloadSha256 === 'string' && hex.test(sealedBatch.eventPayloadSha256)), 'PILOT_INVALID_SEALED_BATCH', 400);
    const now = clock();
    const ttl = notAfter === null ? lifetimeMs : Math.min(lifetimeMs, notAfter - now);
    requireValue(Number.isSafeInteger(ttl) && ttl > 0, 'PILOT_TICKET_WINDOW_EXPIRED', 403);
    const issued = codec(now, ttl).issue(scope);
    const batch = sealedBatch ? { batchId: sealedBatch.batchId, eventPayloadSha256: sealedBatch.eventPayloadSha256 } : null;
    const envelope = { pilotId, encryptedScope: issued.ticket, sealedBatch: batch };
    const encoded = Buffer.from(canonical(envelope)).toString('base64url');
    return { ...issued, ticket: `${currentKeyId}.${encoded}.${digest(currentKeyId, encoded).toString('base64url')}` };
  }

  function verify(ticket, at = clock()) {
    requireValue(typeof ticket === 'string' && ticket.length <= 8_192, 'PILOT_TICKET_INVALID', 401);
    const [, keyId, encoded, tag] = /^([A-Za-z0-9_-]{1,40})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(ticket) ?? [];
    requireValue(Object.hasOwn(keys, keyId) && keys[keyId]?.length === 32, 'PILOT_TICKET_INVALID', 401);
    const claimed = Buffer.from(tag, 'base64url');
    const actual = digest(keyId, encoded);
    requireValue(claimed.length === actual.length && timingSafeEqual(claimed, actual), 'PILOT_TICKET_INVALID', 401);
    const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    requireValue(envelope.pilotId === pilotId && envelope.encryptedScope.startsWith(keyId + '.'), 'PILOT_TICKET_INVALID', 401);
    return { ...codec(at).verify(envelope.encryptedScope), sealedBatch: envelope.sealedBatch };
  }

  return { issue, verify };
}
