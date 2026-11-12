import { createK56HoldStore, holdEnabled, submissionHoldPolicy } from './term1-submission-hold.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function createSubmissionRecovery({ profile, record, fail, transaction, admitted, previousReceipt, validateSeal, pool }) {
  const product = profile.tablePrefix;
  const policy = submissionHoldPolicy(product);
  const store = createK56HoldStore(product);
  const enablePaper = process.env.K56_MINI_HOLD_PAPER === 'true';
  let shouldExpire = policy.configured;

  function enabled(run) {
    const configured = holdEnabled(run);
    if (configured) shouldExpire = true;
    return configured;
  }

  function note(...args) {
    try { Promise.resolve(record?.(...args)).catch(() => {}); } catch {}
  }

  function meta(req, body) {
    const requestId = req.get('x-exam-journal-request-id');
    return {
      section: body?.section, operationId: body?.operationId, revision: body?.revision,
      requestId: uuid.test(requestId || '') ? requestId.toLowerCase() : undefined
    };
  }

  function enrollment(attempt, classCode) {
    if (attempt.attempt_mode === 'answer_sheet' && !enablePaper) return [];
    return policy.admits(attempt.class_name_snapshot || classCode) ? [policy.hours, policy.limit] : [];
  }

  function checkScope(attempt, section) {
    if (attempt.superseded_at || attempt.session_superseded_at)
      throw fail('OFFLINE_SCOPE_CONFLICT', 'Lượt thi đã thay đổi. Hãy giữ bản trên thiết bị.', 403);
    if (attempt.attempt_mode === 'answer_sheet' && section === 'writing')
      throw fail('MODE_CONFLICT', 'Phiếu giấy chỉ nhận Listening và Reading.', 403);
  }

  async function retain(req, body, hash, { required = false } = {}) {
    if (body.kind !== 'seal') {
      if (required) throw fail('OFFLINE_HOLD_NOT_ALLOWED', 'Chỉ giữ bản đã chốt.', 403);
      return;
    }
    const trace = meta(req, body);
    let observation;
    let retention;
    try {
      retention = await transaction(async client => {
        const { a, run } = await admitted(client, body, req.get('x-term2-permit'));
        if (!enabled(run)) {
          if (required) throw fail('OFFLINE_HOLD_NOT_ALLOWED', 'Lượt này chưa có quyền lưu để đối soát.', 403);
          return;
        }
        checkScope(a, body.section);
        if (await previousReceipt(client, a, body, hash)) return;
        validateSeal(a, body);
        const p = body.payload;
        observation = {
          generation: body.generation, definitionVersion: Number(a.definition_version), policyVersion: profile.policy,
          previousOperationId: body.dependency, startedAtMs: Date.parse(p.startedAt),
          capturedAtMs: Date.parse(body.occurredAt), deadlineAtMs: p.deadlineAt ? Date.parse(p.deadlineAt) : undefined,
          serverAtMs: Date.parse(a.server_now), automatic: p.reason !== 'manual',
          ...(body.section === 'writing'
            ? { [profile.taskId + 'Length']: p[profile.taskId].length }
            : { answeredCount: Object.values(p.answers).filter(Boolean).length })
        };
        return store.hold(client, a.attempt_token, body, hash, run);
      });
    } catch (error) {
      if (error.status) throw error;
      note('offline_hold_unconfirmed', profile.slug, body.attemptToken, {
        ...trace, phase: 'hold', reason: 'HOLD_TRANSACTION_UNCONFIRMED'
      });
      throw fail('OFFLINE_HOLD_UNAVAILABLE', 'Chưa lưu được bản đối soát. Hãy giữ bản trên thiết bị.', 503);
    }
    if (!retention) return;
    note('offline_submission_held', profile.slug, body.attemptToken, {
      ...trace, phase: 'hold', ...observation, heldAtMs: retention.held.heldAt,
      expiresAtMs: retention.held.expiresAt, replayed: retention.replayed
    });
    return { ...retention, observation };
  }

  async function read(client, req, a, run, body, receipt) {
    if (receipt?.status === 'accepted' || !enabled(run)) return;
    const pending = await store.read(client, a.attempt_token, body);
    if (!pending) return;
    checkScope(a, pending.section);
    note('offline_submission_hold_read', profile.slug, body.attemptToken, {
      ...meta(req, { ...body, section: pending.section }), generation: body.generation,
      phase: 'readback', heldAtMs: pending.held.heldAt, expiresAtMs: pending.held.expiresAt
    });
    return pending.held;
  }

  async function expire() {
    if (shouldExpire) await store.expire(pool).catch(() => {});
  }

  return { enabled, enrollment, retain, read, meta, note, expire, assertIdentity: store.assertIdentity, clear: store.clear };
}
