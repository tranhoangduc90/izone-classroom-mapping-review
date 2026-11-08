import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const skillGrantSchema = `
CREATE TABLE IF NOT EXISTS assessment.term1_skill_grant (
  id uuid PRIMARY KEY,
  secret_hash text NOT NULL UNIQUE,
  activation_hash text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES assessment.term_test_attempt(id),
  session_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  class_id bigint NOT NULL CHECK (class_id > 0),
  student_ref uuid NOT NULL,
  section text NOT NULL CHECK (section IN ('listening', 'reading', 'writing')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  owner_id uuid,
  bound_at timestamptz,
  revoked_at timestamptz,
  CHECK ((owner_id IS NULL) = (bound_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS term1_skill_grant_one_active
  ON assessment.term1_skill_grant(attempt_id, generation, section)
  WHERE revoked_at IS NULL;
`;

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sectionNames = new Set(['listening', 'reading', 'writing']);
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const activationPattern = /^[A-F0-9]{16}$/;
const scopeWhere = `
  attempt_id=$1 AND session_id=$2 AND generation=$3 AND class_id=$4
  AND student_ref=$5 AND section=$6
`;
const columns = 'id, section, issued_at, expires_at, bound_at, revoked_at';

const sha = value => createHash('sha256').update(value).digest('hex');
function denied() {
  return Object.assign(new Error('Quyền làm kỹ năng này không còn hiệu lực hoặc không khớp lượt thi.'), {
    status: 403, code: 'TERM1_SKILL_GRANT_DENIED'
  });
}

function scopeArgs(scope) {
  const { attemptId, sessionId, generation, classId, studentRef, section } = scope;
  if (![attemptId, sessionId, studentRef].every(value => typeof value === 'string' && uuid.test(value))
      || !Number.isSafeInteger(generation) || generation < 0 || !/^[1-9]\d{0,17}$/.test(String(classId))
      || !sectionNames.has(section)) throw denied();
  return [attemptId, sessionId, generation, String(classId), studentRef, section];
}

function credential(token) {
  const [id, secret, extra] = typeof token === 'string' ? token.split('.', 3) : [];
  if (extra !== undefined || !uuid.test(id ?? '') || !secretPattern.test(secret ?? '')) throw denied();
  return [id, sha(secret)];
}

// The caller resolves this scope from the canonical Term 1 attempt under its lock
// and checks the teacher's class permission before entering this transaction.
export async function issueSkillGrant(client, scope, ttlMinutes = 120) {
  const values = scopeArgs(scope);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw denied();
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  const activationCode = randomBytes(8).toString('hex').toUpperCase();
  const { rows } = await client.query(`
    INSERT INTO assessment.term1_skill_grant
      (attempt_id, session_id, generation, class_id, student_ref, section, id, secret_hash, activation_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp() + $10::integer * interval '1 minute')
    ON CONFLICT (attempt_id, generation, section) WHERE revoked_at IS NULL DO NOTHING
    RETURNING ${columns}
  `, [...values, id, sha(secret), sha(activationCode), ttlMinutes]);
  if (!rows[0]) throw Object.assign(new Error('Kỹ năng này đã có link. Thu hồi link cũ trước khi cấp lại.'), {
    status: 409, code: 'TERM1_SKILL_GRANT_EXISTS'
  });
  return { grant: rows[0], token: id + '.' + secret, activationCode };
}

export async function bindSkillGrant(client, scope, token, ownerId, activationCode) {
  if (typeof ownerId !== 'string' || !uuid.test(ownerId)) throw denied();
  const code = typeof activationCode === 'string' ? activationCode.trim().toUpperCase() : '';
  const activationHash = activationPattern.test(code) ? sha(code) : null;
  const { rows } = await client.query(`
    UPDATE assessment.term1_skill_grant
    SET owner_id=$9, bound_at=coalesce(bound_at, clock_timestamp())
    WHERE ${scopeWhere} AND id=$7 AND secret_hash=$8 AND revoked_at IS NULL
      AND (owner_id=$9 OR (owner_id IS NULL AND clock_timestamp()<expires_at AND activation_hash=$10))
    RETURNING ${columns}
  `, [...scopeArgs(scope), ...credential(token), ownerId, activationHash]);
  if (!rows[0]) throw denied();
  return rows[0];
}

// Hold the grant row during the operation so a revocation cannot race a seal.
// The offline handler still enforces its existing deadline and receipt window.
export async function requireSkillGrant(client, scope, token, ownerId) {
  if (typeof ownerId !== 'string' || !uuid.test(ownerId)) throw denied();
  const { rows } = await client.query(`
    SELECT ${columns} FROM assessment.term1_skill_grant
    WHERE ${scopeWhere} AND id=$7 AND secret_hash=$8 AND owner_id=$9
      AND revoked_at IS NULL
    FOR UPDATE
  `, [...scopeArgs(scope), ...credential(token), ownerId]);
  if (!rows[0]) throw denied();
  return rows[0];
}

export async function revokeSkillGrant(client, scope, grantId) {
  if (typeof grantId !== 'string' || !uuid.test(grantId)) throw denied();
  const { rows } = await client.query(`
    UPDATE assessment.term1_skill_grant
    SET revoked_at=coalesce(revoked_at, clock_timestamp())
    WHERE ${scopeWhere} AND id=$7
    RETURNING ${columns}
  `, [...scopeArgs(scope), grantId]);
  if (!rows[0]) throw denied();
  return rows[0];
}

export async function readActiveSkillGrant(client, scope) {
  const { rows } = await client.query(`SELECT ${columns}, expires_at <= clock_timestamp() AS expired
    FROM assessment.term1_skill_grant WHERE ${scopeWhere} AND revoked_at IS NULL`, scopeArgs(scope));
  const grant = rows[0];
  if (!grant) return null;
  return { grantId: grant.id, section: grant.section, issuedAt: grant.issued_at, expiresAt: grant.expires_at,
    state: grant.bound_at ? 'bound' : grant.expired ? 'expired' : 'awaiting' };
}

function attemptArgs(attempt) {
  return [attempt.attempt_token, attempt.exam_session_token, Number(attempt.generation), attempt.class_id];
}

// Use the locked native attempt rather than identity claims from the request.
// The selected student_ref was checked when the link was bound.
export async function readBoundSkillGrant(client, attempt, token, ownerId, section = null) {
  if (typeof ownerId !== 'string' || !uuid.test(ownerId)) throw denied();
  const { rows } = await client.query(`
    SELECT ${columns} FROM assessment.term1_skill_grant
    WHERE attempt_id=$1 AND session_id=$2 AND generation=$3 AND class_id=$4
      AND id=$5 AND secret_hash=$6 AND owner_id=$7 AND revoked_at IS NULL
      AND ($8::text IS NULL OR section=$8)
    FOR UPDATE
  `, [...attemptArgs(attempt), ...credential(token), ownerId, section]);
  if (!rows[0]) throw denied();
  return rows[0];
}

// A bound link owns writes to its skill until it is revoked or submitted.
export async function rejectMainSkillIfBound(client, attempt, section) {
  const { rows } = await client.query(`
    SELECT id FROM assessment.term1_skill_grant
    WHERE attempt_id=$1 AND session_id=$2 AND generation=$3 AND class_id=$4
      AND section=$5 AND owner_id IS NOT NULL AND revoked_at IS NULL
    FOR UPDATE
  `, [...attemptArgs(attempt), section]);
  if (rows[0]) throw Object.assign(new Error('Kỹ năng này đang làm qua link dự phòng. Hãy mở đúng link để giữ bài đã lưu.'), {
    status: 409, code: 'TERM1_SKILL_OWNED_BY_FALLBACK'
  });
}

// Call while the native listening session is locked. Grant binding takes the same session lock.
export async function rejectListeningSessionIfBound(client, sessionId) {
  const { rows } = await client.query(`SELECT 1 FROM assessment.term1_skill_grant g
    JOIN assessment.term_test_attempt a ON a.id=g.attempt_id AND a.generation=g.generation
    WHERE g.session_id=$1 AND g.section='listening' AND g.owner_id IS NOT NULL AND g.revoked_at IS NULL
      AND a.superseded_at IS NULL AND a.listening_submitted_at IS NULL`, [sessionId]);
  if (rows[0]) throw Object.assign(new Error('Listening đang làm qua link dự phòng. Hãy mở đúng link để giữ bài đã lưu.'), {
    status: 409, code: 'TERM1_SKILL_OWNED_BY_FALLBACK'
  });
}

export async function withMainListeningSession(pool, slug, sessionId, work) {
  if (slug !== 'term-test-1-k56') return work(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM assessment.term_test_exam_session WHERE id=$1 AND test_slug=$2 FOR UPDATE', [sessionId, slug]);
    await rejectListeningSessionIfBound(client, sessionId);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function withMainWritingAttempt(pool, slug, attemptId, work) {
  if (slug !== 'term-test-1-k56') return work(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [attempt] } = await client.query(`SELECT id::text AS attempt_token, exam_session_id::text AS exam_session_token,
      generation, erp_course_class_id::text AS class_id, writing_submitted_at FROM assessment.term_test_attempt
      WHERE id=$1 AND test_slug=$2 AND superseded_at IS NULL FOR UPDATE`, [attemptId, slug]);
    if (attempt && !attempt.writing_submitted_at) await rejectMainSkillIfBound(client, attempt, 'writing');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Used before binding. Return only the attempt key to the server and do not
// reveal that it exists unless the independently supplied activation code matches.
export async function resolveSkillTargetForOpen(client, token, ownerId, activationCode) {
  if (typeof ownerId !== 'string' || !uuid.test(ownerId)) throw denied();
  const code = typeof activationCode === 'string' ? activationCode.trim().toUpperCase() : '';
  const activationHash = activationPattern.test(code) ? sha(code) : null;
  const { rows } = await client.query(`
    SELECT attempt_id, owner_id, issued_at, student_ref, section FROM assessment.term1_skill_grant
    WHERE id=$1 AND secret_hash=$2 AND revoked_at IS NULL
      AND (owner_id=$3 OR (owner_id IS NULL AND clock_timestamp()<expires_at AND activation_hash=$4))
  `, [...credential(token), ownerId, activationHash]);
  if (!rows[0]) throw denied();
  return rows[0];
}

export async function resolveBoundSkillTarget(client, token, ownerId, publicId) {
  if (typeof ownerId !== 'string' || !uuid.test(ownerId)) throw denied();
  const [id, hash] = credential(token);
  if (id !== publicId) throw denied();
  const { rows } = await client.query(`
    SELECT attempt_id, session_id FROM assessment.term1_skill_grant
    WHERE id=$1 AND secret_hash=$2 AND owner_id=$3 AND revoked_at IS NULL
  `, [id, hash, ownerId]);
  if (!rows[0]) throw denied();
  return rows[0];
}
