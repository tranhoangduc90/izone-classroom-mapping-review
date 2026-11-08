import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { bindSkillGrant, issueSkillGrant, revokeSkillGrant } from './term1-skill-grant.mjs';

process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
process.env.K56_TEST_PRODUCT = '1';
const { fixture, op } = await import('../term1-offline-20261107/test.mjs');

async function request(f, path, body, token) {
  const response = await fetch(f.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-term1-skill-grant': token },
    body: JSON.stringify(body)
  });
  return { status: response.status, ...(await response.json()) };
}

test('Reading fallback completes outside lis_first order without leaking full exam permit or creating a second official result', async t => {
  const f = await fixture('lis_first');
  t.after(f.close);
  const ownerId = randomUUID();
  const scope = { attemptId: f.a, sessionId: f.s, generation: 0, classId: '5601',
    studentRef: randomUUID(), section: 'reading' };
  const { grant, token } = await issueSkillGrant(f.db, scope);
  const publicScope = { ...f.scope, attemptToken: grant.id, examSessionToken: grant.id, ownerId };
  const start = op(f, 'reading', 'start');
  assert.equal((await f.request('/offline/operation', start)).error, 'OFFLINE_DEPENDENCY');
  assert.equal((await request(f, '/offline/operation', { ...start, ...publicScope }, token)).status, 403);
  await bindSkillGrant(f.db, scope, token, ownerId);
  assert.equal((await f.request('/offline/operation', start)).error, 'TERM1_SKILL_OWNED_BY_FALLBACK');
  const listeningStart = op(f, 'listening', 'start');
  assert.equal((await request(f, '/offline/operation', { ...listeningStart, ...publicScope }, token)).status, 403);
  assert.equal((await f.request('/offline/operation', listeningStart)).receipt.status, 'accepted');
  const listeningStatus = await request(f, '/offline/status', {
    ...publicScope, operationId: listeningStart.operationId
  }, token);
  assert.equal(listeningStatus.persisted, false);

  const restrictedStart = { ...start, ...publicScope };
  assert.equal((await request(f, '/offline/operation', { ...restrictedStart, dependency: listeningStart.operationId }, token)).status, 403);
  assert.equal((await request(f, '/offline/operation', { ...restrictedStart, attemptToken: f.a }, token)).status, 403);
  assert.equal((await f.request('/offline/operation', restrictedStart)).status, 404);
  assert.equal((await request(f, '/offline/operation', restrictedStart, token)).receipt.status, 'accepted');
  const seal = { ...op(f, 'reading', 'seal', { startedAt: start.payload.startedAt, revision: 1 }), ...publicScope };
  assert.equal((await f.request('/offline/operation', { ...seal, ...f.scope })).error, 'TERM1_SKILL_OWNED_BY_FALLBACK');
  const saved = await request(f, '/offline/operation', seal, token);
  assert.equal(saved.receipt.status, 'accepted');
  assert.equal(saved.receipt.attemptToken, grant.id);
  assert.equal(saved.receipt.examSessionToken, grant.id);
  const status = await request(f, '/offline/status', { ...publicScope, operationId: seal.operationId }, token);
  assert.deepEqual(status.receipt, saved.receipt);
  assert.deepEqual((await request(f, '/offline/operation', seal, token)).receipt, saved.receipt);
  const grades = (await f.db.query('SELECT field, grade FROM assessment.k56_portal_field_dispatch WHERE attempt_id=$1', [f.a])).rows;
  assert.deepEqual(grades.map(row => [row.field, Number(row.grade)]), [['reading', 1]]);
  const native = await f.load(f.pool, 'term-test-1-k56', f.a);
  assert.ok(native.reading_submitted_at);
  assert.equal(native.listening_submitted_at, null);
  assert.equal(native.reading_result.correct, 1);
  await revokeSkillGrant(f.db, scope, grant.id);
  assert.equal((await request(f, '/offline/operation', seal, token)).status, 403);

  const listening = await f.request('/offline/operation', op(f, 'listening', 'seal', {
    startedAt: listeningStart.payload.startedAt, revision: 1
  }));
  assert.equal(listening.receipt.status, 'accepted');
  const duplicate = await f.request('/offline/operation', op(f, 'reading', 'seal', {
    startedAt: start.payload.startedAt, revision: 2, dependency: listening.receipt.operationId
  }));
  assert.equal(duplicate.error, 'OFFLINE_SECTION_LOCKED');
  const writing = await f.request('/offline/operation', op(f, 'writing', 'start', {
    dependency: saved.receipt.operationId
  }));
  assert.equal(writing.receipt.status, 'accepted');
});

test('Reading fallback preserves a score already sealed by the online path', async t => {
  const f = await fixture('read_first');
  t.after(f.close);
  const ownerId = randomUUID();
  const scope = { attemptId: f.a, sessionId: f.s, generation: 0, classId: '5601',
    studentRef: randomUUID(), section: 'reading' };
  const original = { correct: 0, total: 26, marker: 'previous-native-result' };
  await f.db.query('UPDATE assessment.term_test_attempt SET reading_submitted_at=now(), reading_result=$2 WHERE id=$1',
    [f.a, original]);
  const { token, grant } = await issueSkillGrant(f.db, scope);
  await bindSkillGrant(f.db, scope, token, ownerId);
  const start = { ...op(f, 'reading', 'start'), attemptToken: grant.id, examSessionToken: grant.id, ownerId };
  const response = await request(f, '/offline/operation', start, token);
  assert.equal(response.error, 'OFFLINE_SECTION_LOCKED');
  assert.deepEqual((await f.load(f.pool, 'term-test-1-k56', f.a)).reading_result, original);
  assert.equal((await f.db.query('SELECT field FROM assessment.k56_portal_field_dispatch WHERE attempt_id=$1', [f.a])).rows.length, 0);
});
