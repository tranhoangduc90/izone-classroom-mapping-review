import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.TERM2_TEST_PG_URL || '', '', 'This suite uses isolated PGlite.');
assert.ok(process.env.K56_RECOVERY_FIXTURE, 'Set the local fixture path.');
process.env.K56_TEST_PRODUCT = '1';
process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
process.env.K56_TERM1_HOLD_CLASSES = 'FIXTURE';
process.env.K56_TERM1_HOLD_HOURS = '2';
process.env.K56_TERM1_HOLD_LIMIT = '8';
const { fixture, op } = await import(pathToFileURL(resolve(process.env.K56_RECOVERY_FIXTURE,
  'term1-offline-20261107/test.mjs')));
const migration = await readFile(new URL('./term1-submission-hold.sql', import.meta.url), 'utf8');
const { expireTerm1Holds } = await import(pathToFileURL(resolve(process.env.TERM2_RUNTIME_ROOT,
  'src/term1-submission-hold.mjs'))).catch(() => ({}));
const { issueSkillGrant, bindSkillGrant } = await import(pathToFileURL(resolve(process.env.TERM2_RUNTIME_ROOT,
  'src/term1-skill-grant.mjs')));

async function setup(t, mode, options) {
  const f = await fixture(mode, { skipPrepare: true, ...options });
  t.after(() => f.close());
  await f.db.exec('CREATE ROLE k56_shared_api NOLOGIN');
  await f.db.exec(migration);
  const { scope, permit } = await f.newRun();
  return { ...f, scope, permit, get clock() { return f.clock; },
    request(path, body, auth = permit) { return f.request(path, body, auth); } };
}

async function post(f, body) {
  return f.request('/offline/operation', body);
}

for (const mode of ['lis_first', 'read_first']) {
  test('Term 1 retains an authenticated stale Writing seal · ' + mode, async t => {
    const observations = [];
    let fault = false, drop = null;
    const f = await setup(t, mode, {
      record: (...args) => {
        if (fault) throw Error('fixture journal down');
        observations.push(args);
      },
      dropResponse: (body, response) => body?.operationId === drop && response.receipt?.status === 'accepted'
    });
    let dependency = null;
    for (const section of mode === 'lis_first' ? ['listening', 'reading'] : ['reading', 'listening']) {
      const start = op(f, section, 'start', { dependency });
      assert.equal((await post(f, start)).receipt?.status, 'accepted');
      const seal = op(f, section, 'seal', { dependency, startedAt: start.payload.startedAt });
      assert.equal((await post(f, seal)).receipt?.status, 'accepted');
      dependency = seal.operationId;
    }
    const start = op(f, 'writing', 'start', { dependency });
    assert.equal((await post(f, start)).receipt?.status, 'accepted');
    const draft = op(f, 'writing', 'draft', { dependency, startedAt: start.payload.startedAt,
      revision: 2, task1: 'Bản nháp mới hơn, giữ nguyên trong bài thi.' });
    assert.equal((await post(f, draft)).receipt?.status, 'accepted');
    const stale = op(f, 'writing', 'seal', { dependency, startedAt: start.payload.startedAt,
      revision: 1, task1: 'Bản cần đối soát với dấu tiếng Việt và xuống dòng.\nDòng hai.' });
    const answer = await post(f, stale);
    assert.equal(answer.error, 'OFFLINE_REVISION_STALE');
    assert.equal(answer.status, 409);
    assert.match(answer.held?.payloadHash ?? '', /^[a-f0-9]{64}$/);

    const lookup = { ...f.scope, operationId: stale.operationId };
    const status = await f.request('/offline/status', lookup);
    assert.equal(status.persisted, false);
    assert.equal(status.receipt, null);
    assert.deepEqual(status.held, answer.held);
    assert.equal((await f.request('/offline/status', lookup, 'invalid')).status, 403);
    const wrongGeneration = { ...stale, operationId: randomUUID(), generation: 1 };
    assert.equal((await post(f, wrongGeneration)).status, 403);
    const collision = await post(f, { ...stale, payload: { ...stale.payload, task2: 'other' } });
    assert.equal(collision.error, 'OPERATION_CONFLICT');

    const held = (await f.db.query(`SELECT payload FROM assessment.term1_submission_hold
      WHERE attempt_id=$1 AND payload IS NOT NULL`, [f.scope.attemptToken])).rows;
    const { ownerId, ...expected } = stale;
    assert.deepEqual(held, [{ payload: expected }]);
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM assessment.term1_offline_operation
      WHERE operation_id=$1`, [stale.operationId])).rows[0].n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job')).rows[0].n, 0);
    assert.ok(observations.some(([name,,,meta]) => name === 'offline_submission_held'
      && meta.operationId === stale.operationId && meta.revision === 1));
    assert.ok(!JSON.stringify(observations).includes(stale.payload.task2));
    const same = await post(f, stale);
    assert.deepEqual(same.held, answer.held, 'Retry must not extend the retention deadline');
    const valid = op(f, 'writing', 'seal', { dependency, startedAt: start.payload.startedAt,
      revision: 3, task1: 'Bản Writing hợp lệ đã chốt để gửi chính thức.' });
    fault = true;
    drop = valid.operationId;
    await assert.rejects(() => post(f, valid));
    drop = null;
    const recovered = await f.request('/offline/status', { ...f.scope, operationId: valid.operationId });
    assert.equal(recovered.receipt?.status, 'accepted');
    assert.equal(recovered.held, undefined);
    assert.deepEqual((await post(f, valid)).receipt, recovered.receipt);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job')).rows[0].n, 1);
    const persisted = (await f.db.query(`SELECT writing_task_2 FROM assessment.term_test_attempt WHERE id=$1`,
      [f.scope.attemptToken])).rows[0];
    assert.equal(persisted.writing_task_2, valid.payload.task2);
    assert.equal((await f.db.query(`SELECT payload FROM assessment.term1_submission_hold
      WHERE attempt_id=$1 AND operation_id=$2`, [f.scope.attemptToken, valid.operationId])).rows[0].payload, null);
  });
}


test('Term 1 retries an unchanged seal after the missing start arrives', async t => {
  const f = await setup(t, 'read_first');
  const start = op(f, 'reading', 'start');
  const seal = op(f, 'reading', 'seal', { startedAt: start.payload.startedAt });
  const retained = await post(f, seal);
  assert.equal(retained.error, 'OFFLINE_START_REQUIRED');
  assert.ok(retained.held?.heldAt);
  assert.equal((await post(f, start)).receipt?.status, 'accepted');
  assert.equal((await post(f, seal)).receipt?.status, 'accepted');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.k56_portal_field_dispatch')).rows[0].n, 1);
});

test('Term 1 holds later Writing independently without committing it or queuing a grade', async t => {
  const f = await setup(t, 'read_first');
  const reading = op(f, 'reading', 'seal');
  assert.equal((await post(f, reading)).error, 'OFFLINE_START_REQUIRED');
  const writing = op(f, 'writing', 'seal', { dependency: reading.operationId,
    task1: 'A later Writing answer with no accepted prerequisite.' });
  const retained = await f.request('/offline/hold', writing);
  assert.equal(retained.status, 200);
  assert.ok(retained.held?.payloadHash);
  assert.equal(retained.alreadyRecorded, false);
  assert.deepEqual((await f.request('/offline/hold', writing)).held, retained.held);
  const status = await f.request('/offline/status', { ...f.scope, operationId: writing.operationId });
  assert.deepEqual(status.held, retained.held);
  assert.equal(status.persisted, false);
  assert.equal(status.receipt, null);
  assert.equal((await f.request('/offline/hold', { ...writing, generation: 1 })).status, 403);
  assert.equal((await f.request('/offline/hold', op(f, 'writing', 'draft'))).status, 403);
  const { rows: [row] } = await f.db.query(`SELECT
    (SELECT payload->'payload'->>'task2' FROM assessment.term1_submission_hold WHERE operation_id=$1) AS essay,
    (SELECT count(*)::int FROM assessment.term1_offline_operation) AS receipts,
    (SELECT count(*)::int FROM assessment.term_test_writing_grading_job) AS jobs,
    (SELECT count(*)::int FROM assessment.k56_portal_field_dispatch) AS grades`, [writing.operationId]);
  assert.deepEqual(row, { essay: writing.payload.task2, receipts: 0, jobs: 0, grades: 0 });
});


test('Term 1 keeps a held copy when the receipt transaction fails', async t => {
  let failReceipt;
  const f = await setup(t, 'read_first', { beforeReceipt: params => {
    if (params[0] === failReceipt) throw Error('fixture commit unavailable');
  } });
  const start = op(f, 'reading', 'start');
  assert.equal((await post(f, start)).receipt?.status, 'accepted');
  const seal = op(f, 'reading', 'seal', { startedAt: start.payload.startedAt });
  failReceipt = seal.operationId;
  const rejected = await post(f, seal);
  assert.equal(rejected.error, 'OFFLINE_SUBMISSION_UNAVAILABLE');
  assert.ok(rejected.held?.payloadHash);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.k56_portal_field_dispatch')).rows[0].n, 0);
  assert.equal((await f.request('/offline/status', { ...f.scope, operationId: seal.operationId })).persisted, false);
  failReceipt = null;
  assert.equal((await post(f, seal)).receipt?.status, 'accepted');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.k56_portal_field_dispatch')).rows[0].n, 1);
});

test('Term 1 respects quota and expires the held payload without renewing the same operation', async t => {
  const f = await setup(t, 'read_first');
  await f.db.query('UPDATE assessment.term1_offline_run SET submission_hold_limit=1 WHERE attempt_id=$1',
    [f.scope.attemptToken]);
  const first = op(f, 'reading', 'seal');
  const later = op(f, 'reading', 'seal');
  assert.equal((await post(f, first)).error, 'OFFLINE_START_REQUIRED');
  const full = await post(f, later);
  assert.equal(full.error, 'OFFLINE_HOLD_FULL');
  assert.equal(full.status, 503);
  assert.equal(full.held, undefined);
  await f.db.query(`UPDATE assessment.term1_submission_hold SET
    held_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 hour'
    WHERE attempt_id=$1 AND operation_id=$2`, [f.scope.attemptToken, first.operationId]);
  await expireTerm1Holds(f.db);
  assert.equal((await f.request('/offline/status', { ...f.scope, operationId: first.operationId })).held, undefined);
  assert.equal((await post(f, first)).error, 'OFFLINE_HOLD_EXPIRED');
  assert.equal((await f.db.query('SELECT payload FROM assessment.term1_submission_hold')).rows[0].payload, null);
  assert.ok((await post(f, later)).held?.payloadHash);
});

test('Term 1 main permit cannot retain or read a hold once a skill grant is bound', async t => {
  const f = await setup(t, 'read_first');
  const former = op(f, 'reading', 'seal');
  assert.ok((await post(f, former)).held?.payloadHash);
  const grantScope = { attemptId: f.scope.attemptToken, sessionId: f.scope.examSessionToken,
    generation: 0, classId: '5601', studentRef: randomUUID(), section: 'reading' };
  const { token, activationCode } = await issueSkillGrant(f.db, grantScope);
  await bindSkillGrant(f.db, grantScope, token, randomUUID(), activationCode);
  const blocked = await post(f, op(f, 'reading', 'seal'));
  assert.equal(blocked.error, 'TERM1_SKILL_OWNED_BY_FALLBACK');
  assert.equal(blocked.held, undefined);
  const read = await f.request('/offline/status', { ...f.scope, operationId: former.operationId });
  assert.equal(read.error, 'TERM1_SKILL_OWNED_BY_FALLBACK');
  assert.equal(read.held, undefined);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term1_submission_hold')).rows[0].n, 1);
});
