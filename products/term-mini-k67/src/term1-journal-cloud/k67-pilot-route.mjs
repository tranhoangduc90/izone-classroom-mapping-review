const scopeHash = /^[a-f0-9]{64}$/;
const classCode = /^[A-Z0-9._-]{2,32}$/;
const legacy = reason => ({ destination: 'collector', reason });
export const isK67TermPilot = slug => ['term-test-1','term-test-2','mini-test-lesson-5'].includes(slug);

// Inputs come from the native owner query and the server-owned pilot configuration.
// preparedAt is the first preparation time of the session, not a client timestamp.
export function selectNewK67JournalRoute(owner, pilot, now, testSlug = 'term-test-2') {
  if (pilot?.enabled !== true) return legacy('pilot_disabled');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(pilot.opensAt)
    || !Number.isSafeInteger(pilot.closesAt) || !Number.isSafeInteger(pilot.renewUntil)
    || pilot.opensAt >= pilot.closesAt || pilot.closesAt >= pilot.renewUntil
    || typeof pilot.pilotId !== 'string' || pilot.pilotId.length === 0
    || (pilot.classCode !== '*' && !classCode.test(pilot.classCode ?? ''))) return legacy('pilot_invalid');
  if (now < pilot.opensAt || now >= pilot.closesAt) return legacy('outside_pilot_window');
  if (!isK67TermPilot(testSlug) || owner?.verified !== true || owner.product !== 'term-mini-k67' || owner.testSlug !== testSlug
    || !classCode.test(owner.classCode ?? '') || (pilot.classCode !== '*' && owner.classCode !== pilot.classCode)
    || owner.mode !== 'cbt' || owner.superseded !== false || !scopeHash.test(owner.scopeId)) {
    return legacy('owner_outside_pilot');
  }
  if (!Number.isSafeInteger(owner.preparedAt) || owner.preparedAt < pilot.opensAt || owner.preparedAt > now) {
    return legacy('existing_or_unknown_session');
  }
  return { destination: 'pubsub-v1', pilotId: pilot.pilotId, scopeId: owner.scopeId, renewUntil: pilot.renewUntil };
}

// Persisted enrollment is written only for a previously eligible scope. Rollback
// switches newly sealed batches; this path exists solely to drain a sealed batch.
export function validateK67DrainRenewal(owner, enrollment, sealed, now) {
  if (owner?.verified !== true || !scopeHash.test(owner.scopeId) || enrollment?.destination !== 'pubsub-v1'
    || owner.scopeId !== enrollment.scopeId || owner.scopeId !== sealed?.scopeId
    || sealed.destination !== enrollment.destination || sealed.pilotId !== enrollment.pilotId) {
    return { allowed: false, reason: 'original_scope_unverified' };
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(enrollment.renewUntil) || now >= enrollment.renewUntil) {
    return { allowed: false, reason: 'renewal_window_expired' };
  }
  if (!scopeHash.test(sealed.batchId) || !scopeHash.test(sealed.eventPayloadSha256)) {
    return { allowed: false, reason: 'sealed_identity_missing' };
  }
  return { allowed: true, scopeId: owner.scopeId, batchId: sealed.batchId,
    eventPayloadSha256: sealed.eventPayloadSha256, renewUntil: enrollment.renewUntil };
}
