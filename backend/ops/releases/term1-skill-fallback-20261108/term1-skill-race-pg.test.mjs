import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const pgUrl = process.env.TERM2_TEST_PG_URL;
test('Two PostgreSQL connections race the original exam and a Reading fallback', { skip: !pgUrl, timeout: 25000 }, async t => {
  const db = new URL(pgUrl);
  assert.equal(db.hostname, '127.0.0.1');
  assert.equal(db.pathname, '/term1_fallback_race');
  assert.equal(db.username, 'term1_fixture');
  assert.equal(db.searchParams.get('application_name'), 'term1-fallback-race');
  process.env.K56_TEST_PRODUCT = '1';
  process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
  const { fixture, op } = await import('../term1-offline-20261107/test.mjs');
  const { registerTerm1SkillRoutes } = await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT + '/src/term1-skill-routes.mjs'));
  const require = createRequire(process.env.TERM2_DEPS_PACKAGE);
  const express = require('express');
  let release, held, opToHold;
  const gate = new Promise(resolve => { release = resolve; });
  const holding = new Promise(resolve => { held = resolve; });
  const f = await fixture('read_first', { beforeReceipt: async ([id]) => {
    if (id === opToHold) { held(); await gate; }
  } });
  t.after(f.close);
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
  assert.equal((await f.request('/offline/operation', start)).receipt.status, 'accepted');
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
  opToHold = accepted.operationId;
  const losing = op(f, 'reading', 'seal', { startedAt: start.payload.startedAt, revision: 1 });
  losing.payload.answers = { '1': 'wrong' };
  const send = async body => {
    const response = await fetch(f.base + '/offline/operation', { method: 'POST',
      headers: { 'content-type': 'application/json', ...header }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  const first = send(accepted);
  let second;
  try {
    await Promise.race([holding, first.then(result => assert.fail('Seal returned before acquiring the held transaction: ' + JSON.stringify(result))),
      delay(5000, undefined, { ref: false }).then(() => assert.fail('Seal did not reach the held transaction'))]);
    second = f.request('/offline/operation', losing);
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
  assert.equal((await send({ ...accepted, operationId: randomUUID() })).status, 409);
  const { rows: seals } = await f.db.query("SELECT operation_id FROM assessment.term1_offline_operation WHERE kind='seal' AND section='reading'");
  assert.deepEqual(seals, [{ operation_id: accepted.operationId }]);
  const { rows: grades } = await f.db.query('SELECT field,grade FROM assessment.k56_portal_field_dispatch');
  assert.deepEqual(grades.map(({ field, grade }) => [field, Number(grade)]), [['reading', 1]]);
  const row = await f.load(f.pool, 'term-test-1-k56', f.a);
  assert.deepEqual(row.reading_answers, { '1': 'A' });
});
