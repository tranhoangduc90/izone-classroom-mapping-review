import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const pgUrl = process.env.TERM2_TEST_PG_URL;
const withRecovery = process.env.K56_FALLBACK_RECOVERY_RACE === '1';
test('PostgreSQL serializes the original exam and Reading fallback' + (withRecovery ? ' with recovery' : ''),
  { skip: !pgUrl, timeout: 25000 }, async t => {
  const db = new URL(pgUrl);
  assert.equal(db.hostname, '127.0.0.1');
  assert.equal(db.pathname, '/term1_fallback_race');
  assert.equal(db.username, 'term1_fixture');
  assert.equal(db.searchParams.get('application_name'), 'term1-fallback-race');
  process.env.K56_TEST_PRODUCT = '1';
  process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
  if (withRecovery) {
    process.env.K56_TERM1_HOLD_CLASSES = 'FIXTURE';
    process.env.K56_TERM1_HOLD_HOURS = '2';
    process.env.K56_TERM1_HOLD_LIMIT = '8';
  }
  const { fixture, op } = await import('../term1-offline-20261107/test.mjs');
  const { registerTerm1SkillRoutes } = await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT + '/src/term1-skill-routes.mjs'));
  const require = createRequire(process.env.TERM2_DEPS_PACKAGE);
  const express = require('express');
  let release, held, opToHold;
  const gate = new Promise(resolve => { release = resolve; });
  const holding = new Promise(resolve => { held = resolve; });
  const f = await fixture('read_first', { skipPrepare: withRecovery, beforeReceipt: async ([id]) => {
    if (id === opToHold) { held(); await gate; }
  } });
  t.after(f.close);
  let mainPermit;
  if (withRecovery) {
    const migration = await readFile(new URL('../k56-submission-recovery-20261112/term1-submission-hold.sql', import.meta.url), 'utf8');
    await f.db.exec(migration);
    const prepared = await f.request('/offline/prepare',
      { ...f.scope, classCode: 'FIXTURE', studentRef: randomUUID(), mode: 'read_first' });
    assert.equal(prepared.status, 200);
    mainPermit = prepared.offline.permit;
  }
  const mainRequest = (path, body) => f.request(path, body, mainPermit);
  const studentRef = randomUUID(), owners = [randomUUID(), randomUUID()];
  const scope = { classCode: 'FIXTURE', studentRef, section: 'reading' };
  const app = express(), router = express.Router();
  const noop = (_req, _res, next) => next();
  app.use(express.json());
  registerTerm1SkillRoutes(router, { authenticate: noop, limiter: noop, readLimiter: noop, transaction: f.transaction,
    readTeacherScope: async () => {}, prepare: (slug, _input, _create, client) => f.load(client, slug, f.a, false, true),
    load: f.load, findStudent: async () => ({ class_id: '5601', student_id: '5602' }), assets: {},
    policy: 'term1-offline-v1', allowNew: () => true });
  app.use('/api/term-tests', router);
  const teacher = require('supertest')(app);
  const prefix = '/api/term-tests/term-test-1-k56/skill-fallback/';
  const start = op(f, 'reading', 'start');
  assert.equal((await mainRequest('/offline/operation', start)).receipt.status, 'accepted');
  await teacher.post(prefix + 'issue').send(scope).expect(409);
  const { body: issued } = await teacher.post(prefix + 'issue').send({ ...scope, oldDeviceStopped: true }).expect(200);
  const header = { 'x-term1-skill-grant': issued.token };
  const attempts = await Promise.all(owners.map(ownerId =>
    teacher.post(prefix + 'open').set(header).send({ ...scope, ownerId, activationCode: issued.activationCode })));
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 403], attempts.map(response => response.body.error).join(','));
  const binding = attempts.findIndex(response => response.status === 200);
  const opened = attempts[binding].body, ownerId = owners[binding];
  assert.equal(opened.startedAt, start.payload.startedAt);
  assert.equal(opened.deadlineAt, start.payload.deadlineAt);

  const accepted = { ...op(f, 'reading', 'seal', { startedAt: start.payload.startedAt, revision: 1 }),
    ownerId, attemptToken: issued.grantId, examSessionToken: issued.grantId };
  const losing = op(f, 'reading', 'seal', { startedAt: start.payload.startedAt, revision: 1 });
  losing.payload.answers = { '1': 'wrong' };
  const send = async body => {
    const response = await fetch(f.base + '/offline/operation', { method: 'POST',
      headers: { 'content-type': 'application/json', ...header }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  if (withRecovery) {
    assert.equal(opened.submissionRecoveryVersion, 1);
    const { rows: [run] } = await f.db.query('SELECT state FROM assessment.term1_offline_run WHERE attempt_id=$1', [f.a]);
    // The synthetic start is temporarily unavailable to both requests. Restore the same state before retrying.
    await f.db.query("UPDATE assessment.term1_offline_run SET state=state-'reading' WHERE attempt_id=$1", [f.a]);
    try {
      const heldResponses = await Promise.all([send(accepted), send(accepted)]);
      for (const response of heldResponses) {
        assert.equal(response.status, 409);
        assert.equal(response.error, 'OFFLINE_START_REQUIRED');
        assert.match(response.held?.payloadHash || '', /^[a-f0-9]{64}$/);
      }
      assert.deepEqual(heldResponses[0].held, heldResponses[1].held);
      const { rows: copies } = await f.db.query(`SELECT payload_hash, payload FROM assessment.term1_submission_hold
        WHERE operation_id=$1 AND payload IS NOT NULL`, [accepted.operationId]);
      assert.equal(copies.length, 1);
      assert.equal(copies[0].payload_hash, heldResponses[0].held.payloadHash);
      assert.deepEqual(copies[0].payload.payload.answers, accepted.payload.answers);
      assert.equal((await f.db.query("SELECT operation_id FROM assessment.term1_offline_operation WHERE kind='seal'")).rows.length, 0);
      assert.equal((await f.db.query('SELECT field FROM assessment.k56_portal_field_dispatch')).rows.length, 0);
    } finally {
      await f.db.query('UPDATE assessment.term1_offline_run SET state=$2::jsonb WHERE attempt_id=$1',
        [f.a, JSON.stringify(run.state)]);
    }
  }
  opToHold = accepted.operationId;
  const first = send(accepted);
  let second;
  try {
    await Promise.race([holding, first.then(result => assert.fail('Seal returned before acquiring the held transaction: ' + JSON.stringify(result))),
      delay(5000, undefined, { ref: false }).then(() => assert.fail('Seal did not reach the held transaction'))]);
    second = mainRequest('/offline/operation', losing);
    let blockers = [];
    for (let retries = 0; retries < 100 && !blockers.length; retries++) {
      ({ rows: blockers } = await f.db.query(`SELECT activity.pid, blocker.pid AS blocking_pid
        FROM pg_stat_activity activity CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) blocker(pid)
        WHERE activity.application_name='term1-fallback-race' AND activity.wait_event_type='Lock'`));
      if (!blockers.length) await delay(25);
    }
    assert.ok(blockers.some(({ pid, blocking_pid }) => pid !== blocking_pid), 'The original exam must wait on a different PostgreSQL connection');
  } finally { release(); }
  const [winner, loser] = await Promise.all([first, second]);
  assert.equal(winner.receipt.status, 'accepted');
  assert.equal(loser.status, 409);
  assert.equal(loser.error, 'TERM1_SKILL_OWNED_BY_FALLBACK');
  assert.deepEqual((await send(accepted)).receipt, winner.receipt);
  const distinct = { ...accepted, operationId: randomUUID(), payload: { ...accepted.payload, answers: { '1': 'B' } } };
  const conflict = await send(distinct);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.error, 'OFFLINE_SECTION_LOCKED');
  const { rows: seals } = await f.db.query("SELECT operation_id FROM assessment.term1_offline_operation WHERE kind='seal' AND section='reading'");
  assert.deepEqual(seals, [{ operation_id: accepted.operationId }]);
  const { rows: grades } = await f.db.query('SELECT field,grade FROM assessment.k56_portal_field_dispatch');
  assert.deepEqual(grades.map(({ field, grade }) => [field, Number(grade)]), [['reading', 1]]);
  if (withRecovery) {
    assert.match(conflict.held?.payloadHash || '', /^[a-f0-9]{64}$/);
    const { rows: remaining } = await f.db.query(`SELECT operation_id, payload->'payload'->'answers' AS answers
      FROM assessment.term1_submission_hold WHERE payload IS NOT NULL`);
    assert.deepEqual(remaining, [{ operation_id: distinct.operationId, answers: { '1': 'B' } }]);
  }
  const row = await f.load(f.pool, 'term-test-1-k56', f.a);
  assert.deepEqual(row.reading_answers, { '1': 'A' });
});
