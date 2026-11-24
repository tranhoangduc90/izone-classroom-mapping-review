import {createHash} from 'node:crypto';

const resumeLimit = 2;
const maxDeliveryDelayMs = 24 * 60 * 60 * 1000;
const positionJitterMs = 750;
const phases = new Set(['running', 'paused']);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const utcIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const clockSchema = `
CREATE TABLE IF NOT EXISTS assessment.term2_offline_listening_clock (
  attempt_id uuid PRIMARY KEY REFERENCES assessment.term2_offline_run(attempt_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS assessment.term2_offline_listening_clock_operation (
  operation_id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES assessment.term2_offline_run(attempt_id) ON DELETE CASCADE,
  request_sha256 text NOT NULL,
  receipt jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS term2_offline_listening_clock_operation_attempt_idx
  ON assessment.term2_offline_listening_clock_operation(attempt_id);`;

function clockError(code, message, status = 409) {
  return Object.assign(new Error(message), {code, status});
}

export function parseClockOperation(value) {
  const {operationId, playerId, expectedRevision, phase, positionMs, resumeCount, interruptionId, recoverable, observedAt} = value;
  const observedMs = utcIso.test(observedAt) ? Date.parse(observedAt) : NaN;
  if (typeof operationId !== 'string' || !uuid.test(operationId) || typeof playerId !== 'string' || !uuid.test(playerId) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !phases.has(phase) || !Number.isSafeInteger(positionMs) || positionMs < 0 ||
      !Number.isInteger(resumeCount) || resumeCount < 0 || resumeCount > resumeLimit || !Number.isFinite(observedMs) ||
      typeof interruptionId !== 'string' || !uuid.test(interruptionId) ||
      (phase === 'paused' ? typeof recoverable !== 'boolean' : recoverable !== null)) {
    throw clockError('LISTENING_CLOCK_INVALID', 'Mốc Listening không hợp lệ. Bản trên máy vẫn được giữ.', 400);
  }
  return {operationId, playerId, expectedRevision, phase, positionMs, resumeCount, interruptionId, recoverable, observedAt};
}

function nextSnapshot(previous, operation, {durationMs, startedAtMs, serverNowMs}) {
  const {phase, positionMs, resumeCount, interruptionId, recoverable, observedAt} = operation;
  const at = Date.parse(observedAt);
  const priorMs = previous ? Date.parse(previous.observedAt) : startedAtMs;
  const priorPosition = previous?.positionMs ?? 0;
  if (!Number.isFinite(serverNowMs) || at < priorMs || at > serverNowMs + 2000 || serverNowMs - at > maxDeliveryDelayMs ||
    positionMs < priorPosition || positionMs > durationMs ||
    positionMs - priorPosition > at - priorMs + positionJitterMs) {
    throw clockError('LISTENING_CLOCK_TIME_CONFLICT', 'Mốc nghe chưa khớp thời gian của lượt thi.');
  }
  if (recoverable && resumeCount >= resumeLimit) {
    throw clockError('LISTENING_CLOCK_CLOSED', 'Lượt Listening không còn mở để nghe tiếp.');
  }
  let expectedCount = previous?.resumeCount ?? 0;
  if (phase === 'running') {
    if (previous?.phase !== 'paused' || !previous.recoverable || interruptionId !== previous.interruptionId ||
      positionMs - priorPosition > 1500 || positionMs - priorPosition < 70) {
      throw clockError('LISTENING_CLOCK_RESUME_INVALID', 'Chưa xác minh được phát tiếp từ đúng mốc.');
    }
    expectedCount++;
  } else if (previous?.phase === 'paused' || previous?.interruptionId === interruptionId) {
    throw clockError('LISTENING_CLOCK_PAUSED', 'Đợt gián đoạn này đã được ghi nhận.');
  }
  if (resumeCount !== expectedCount || positionMs >= durationMs) {
    throw clockError('LISTENING_CLOCK_SEQUENCE_CONFLICT', 'Trạng thái đồng hồ Listening không khớp lượt.');
  }
  return {phase, positionMs, resumeCount, interruptionId, recoverable, observedAt, remainingMs: durationMs - positionMs};
}

export async function commitListeningClock(client, {run, attempt, durationMs, operation, onDuplicate}) {
  if (run.state?.listeningRecoveryVersion !== 1 || attempt.attempt_mode !== 'cbt') {
    throw clockError('LISTENING_CLOCK_NOT_ENABLED', 'Chế độ này chưa hỗ trợ đồng bộ đồng hồ Listening.', 403);
  }
  const attemptId = attempt.attempt_token;
  const startedAtMs = Date.parse(run.state.listening?.startedAt || '');
  if (!Number.isFinite(startedAtMs)) {
    throw clockError('LISTENING_CLOCK_START_REQUIRED', 'Đang chờ xác nhận thời điểm bắt đầu Listening.');
  }
  const hash = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
  const {rows: [seen]} = await client.query(
    'SELECT attempt_id, request_sha256, receipt FROM assessment.term2_offline_listening_clock_operation WHERE operation_id=$1',
    [operation.operationId]
  );
  if (seen) {
    if (seen.attempt_id !== attemptId || seen.request_sha256 !== hash) {
      throw clockError('LISTENING_CLOCK_OPERATION_CONFLICT', 'Mã đồng bộ đã được dùng cho một mốc khác.');
    }
    onDuplicate?.();
    return seen.receipt;
  }
  const {rows: [saved]} = await client.query(
    'SELECT revision, snapshot FROM assessment.term2_offline_listening_clock WHERE attempt_id=$1 FOR UPDATE',
    [attemptId]
  );
  const revision = saved?.revision ?? 0;
  if (revision !== operation.expectedRevision) {
    throw clockError('LISTENING_CLOCK_REVISION_CONFLICT', 'Bản gửi không khớp trạng thái đồng hồ đã nhận.');
  }
  const clock = nextSnapshot(saved?.snapshot, operation, {durationMs, startedAtMs, serverNowMs:Date.parse(attempt.server_now)});
  const receipt = {ok: true, version: 1, operationId: operation.operationId, attemptToken: attemptId, generation: Number(run.generation),
    playerId: operation.playerId, revision: revision + 1, clock};
  await client.query(
    'INSERT INTO assessment.term2_offline_listening_clock (attempt_id, revision, snapshot) VALUES ($1,$2,$3::jsonb) ' +
    'ON CONFLICT (attempt_id) DO UPDATE SET revision=excluded.revision, snapshot=excluded.snapshot',
    [attemptId, receipt.revision, JSON.stringify(clock)]
  );
  await client.query(
    'INSERT INTO assessment.term2_offline_listening_clock_operation (operation_id, attempt_id, request_sha256, receipt) ' +
    'VALUES ($1,$2,$3,$4::jsonb)', [operation.operationId, attemptId, hash, JSON.stringify(receipt)]
  );
  return receipt;
}

export async function enrollListeningClock(client, run, attempt, enabled) {
  if (!enabled || attempt.attempt_mode !== 'cbt' || run.state?.listeningRecoveryVersion === 1 ||
    run.state?.listening?.startedAt || attempt.listening_started_at || attempt.listening_submitted_at ||
    attempt.listening_interrupted_at) return run;
  const {rows: [enrolled]} = await client.query(
    "UPDATE assessment.term2_offline_run SET state = state || '{\"listeningRecoveryVersion\":1}'::jsonb " +
    'WHERE attempt_id=$1 AND NOT (state ? \'listening\') RETURNING *',
    [run.attempt_id]
  );
  return enrolled ?? run;
}

export function mountListeningClock(router, {onlyThis, draftLimiter, route, parseScope, transaction, admitted, durationMs, note}) {
  router.post('/:testSlug/offline/listening-clock', onlyThis, draftLimiter, route(async (req, res) => {
    const scope = parseScope(req.body);
    const operation = parseClockOperation(req.body);
    let duplicate = false;
    const receipt = await transaction(async client => {
      const {a, run} = await admitted(client, scope, req.get('x-term2-permit'));
      return commitListeningClock(client, {run, attempt:a, durationMs:durationMs(a), operation,
        onDuplicate: () => { duplicate = true; }});
    });
    note?.(req, scope, receipt, duplicate);
    res.json(receipt);
  }));
}
