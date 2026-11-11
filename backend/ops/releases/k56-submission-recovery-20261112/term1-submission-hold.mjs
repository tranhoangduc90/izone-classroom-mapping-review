const holdError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

export function term1HoldPolicy(env = process.env) {
  const integer = (name, max) => {
    const value = env[name] || '0';
    if (!/^\d+$/.test(value) || Number(value) > max) throw Error('Invalid ' + name);
    return Number(value);
  };
  const hours = integer('K56_TERM1_HOLD_HOURS', 72);
  const limit = integer('K56_TERM1_HOLD_LIMIT', 20_000);
  const classes = (env.K56_TERM1_HOLD_CLASSES || '').split(',').filter(Boolean);
  if (classes.some(code => !/^[A-Z0-9._-]{2,32}$/.test(code))) throw Error('Invalid K56_TERM1_HOLD_CLASSES');
  return { hours, limit, configured: hours > 0 && limit > 0,
    admits(classCode) { return hours > 0 && limit > 0 && classes.includes(classCode); } };
}

export function term1HoldEnabled(run) {
  return Number(run.submission_hold_hours) > 0 && Number(run.submission_hold_limit) > 0;
}

const args = (attemptId, operation) => [attemptId, operation.generation, operation.operationId];

async function findHold(db, attemptId, operation) {
  return (await db.query(`SELECT section, payload_hash, held_at, expires_at, payload IS NOT NULL AS has_payload,
    expires_at > statement_timestamp() AS fresh
    FROM assessment.term1_submission_hold WHERE attempt_id=$1 AND generation=$2 AND operation_id=$3`,
  args(attemptId, operation))).rows[0];
}

function metadata(row) {
  return row?.has_payload && row.fresh ? {
    payloadHash: row.payload_hash,
    heldAt: new Date(row.held_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime()
  } : undefined;
}

export async function readTerm1Hold(db, attemptId, operation) {
  const row = await findHold(db, attemptId, operation);
  const held = metadata(row);
  return held ? { section: row.section, held } : undefined;
}

export async function holdTerm1Seal(db, attemptId, operation, payloadHash, run) {
  const existing = await findHold(db, attemptId, operation);
  if (existing) {
    if (existing.payload_hash !== payloadHash || existing.section !== operation.section) {
      throw holdError('OPERATION_CONFLICT', 'Mã gửi đã có bản khác để đối soát.');
    }
    const held = metadata(existing);
    if (!held) throw holdError('OFFLINE_HOLD_EXPIRED', 'Bản trên máy chủ đã hết hạn lưu. Hãy giữ bản trên thiết bị.');
    return { held, replayed: true };
  }
  const { ownerId, ...body } = operation;
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > 490_000) throw holdError('OFFLINE_INVALID', 'Bản bài làm quá lớn.', 400);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('k56.term1.submission-hold',0))");
  const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM assessment.term1_submission_hold
    WHERE payload IS NOT NULL AND expires_at > statement_timestamp()`);
  if (n >= Number(run.submission_hold_limit)) {
    throw holdError('OFFLINE_HOLD_FULL', 'Kho đối soát đang đầy. Hãy giữ bản trên thiết bị.', 503);
  }
  const { rows: [inserted] } = await db.query(`INSERT INTO assessment.term1_submission_hold
    (attempt_id,generation,operation_id,section,payload_hash,payload,held_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,statement_timestamp(),statement_timestamp()+$7::int*interval '1 hour')
    RETURNING payload_hash, held_at, expires_at, true AS has_payload, true AS fresh`,
  [...args(attemptId, operation), operation.section, payloadHash, payload, Number(run.submission_hold_hours)]);
  return { held: metadata(inserted), replayed: false };
}

export async function assertTerm1HoldIdentity(db, attemptId, operation, payloadHash) {
  const existing = await findHold(db, attemptId, operation);
  if (existing && (existing.payload_hash !== payloadHash || existing.section !== operation.section)) {
    throw holdError('OPERATION_CONFLICT', 'Mã gửi đã có bản khác để đối soát.');
  }
}

export async function clearTerm1Hold(db, attemptId, operation) {
  await db.query(`UPDATE assessment.term1_submission_hold SET payload=NULL
    WHERE attempt_id=$1 AND generation=$2 AND operation_id=$3`, args(attemptId, operation));
}

export async function expireTerm1Holds(db) {
  const result = await db.query(`WITH expired AS (
    SELECT attempt_id, generation, operation_id FROM assessment.term1_submission_hold
    WHERE payload IS NOT NULL AND expires_at <= statement_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
  )
  UPDATE assessment.term1_submission_hold AS held SET payload=NULL FROM expired
  WHERE held.attempt_id=expired.attempt_id AND held.generation=expired.generation
    AND held.operation_id=expired.operation_id`);
  return result.rowCount;
}
