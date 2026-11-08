import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { bindSkillGrant, issueSkillGrant, requireSkillGrant, revokeSkillGrant, skillGrantSchema } from './term1-skill-grant.mjs';

const require = createRequire(process.env.TERM2_DEPS_PACKAGE || new URL('../../../package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE SCHEMA assessment; CREATE TABLE assessment.term_test_attempt(id uuid PRIMARY KEY);');
  await db.exec(skillGrantSchema);
  const scope = { attemptId: randomUUID(), sessionId: randomUUID(), generation: 2,
    classId: '123', studentRef: randomUUID(), section: 'reading' };
  await db.query('INSERT INTO assessment.term_test_attempt VALUES ($1)', [scope.attemptId]);
  return { db, scope };
}
const denied = { code: 'TERM1_SKILL_GRANT_DENIED', status: 403 };

test('Reading grant stores only a digest and binds exactly one owner to the canonical scope', async t => {
  const { db, scope } = await fixture(t);
  const owner = randomUUID();
  const { token, grant, activationCode } = await issueSkillGrant(db, scope);
  const stored = (await db.query('SELECT secret_hash FROM assessment.term1_skill_grant')).rows[0];
  assert.match(stored.secret_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(token.split('.')[1]));
  await assert.rejects(requireSkillGrant(db, scope, token, owner), denied);
  for (const changes of [{ classId: '125' }, { studentRef: randomUUID() }, { section: 'writing' },
    { sessionId: randomUUID() }, { generation: 3 }]) {
    await assert.rejects(bindSkillGrant(db, { ...scope, ...changes }, token, owner, activationCode), denied);
  }
  await assert.rejects(bindSkillGrant(db, scope, token.slice(0, -2) + 'x', owner), denied);
  await assert.rejects(bindSkillGrant(db, scope, token, owner), denied);
  await assert.rejects(bindSkillGrant(db, scope, token, owner, '0000000000000000'), denied);
  const bound = await bindSkillGrant(db, scope, token, owner, activationCode);
  assert.equal(bound.id, grant.id);
  assert.ok(bound.bound_at);
  await assert.rejects(bindSkillGrant(db, scope, token, randomUUID()), denied);
  assert.deepEqual(await bindSkillGrant(db, scope, token, owner), bound);
  await db.exec('BEGIN');
  try {
    assert.deepEqual(await requireSkillGrant(db, scope, token, owner), bound);
  } finally {
    await db.exec('ROLLBACK');
  }
});

test('Expiry blocks new owners, revocation blocks existing ones and replacement does not revive the old credential', async t => {
  const { db, scope } = await fixture(t);
  const owner = randomUUID();
  const first = await issueSkillGrant(db, scope);
  await assert.rejects(issueSkillGrant(db, scope), { code: 'TERM1_SKILL_GRANT_EXISTS' });
  await db.query("UPDATE assessment.term1_skill_grant SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.grant.id]);
  await assert.rejects(bindSkillGrant(db, scope, first.token, owner, first.activationCode), denied);
  await assert.rejects(revokeSkillGrant(db, { ...scope, classId: '999' }, first.grant.id), denied);
  assert.ok((await revokeSkillGrant(db, scope, first.grant.id)).revoked_at);
  const replacement = await issueSkillGrant(db, scope, 1);
  const bound = await bindSkillGrant(db, scope, replacement.token, owner, replacement.activationCode);
  await db.query("UPDATE assessment.term1_skill_grant SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [replacement.grant.id]);
  assert.deepEqual((await bindSkillGrant(db, scope, replacement.token, owner)).bound_at, bound.bound_at);
  await assert.rejects(bindSkillGrant(db, scope, first.token, owner, first.activationCode), denied);
  await revokeSkillGrant(db, scope, replacement.grant.id);
  await assert.rejects(requireSkillGrant(db, scope, replacement.token, owner), denied);
});
