import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

process.env.K56_TEST_PRODUCT = '1';
process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
const { fixture, op } = await import('../term1-offline-20261107/test.mjs');
const { registerTerm1SkillRoutes } = await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT + '/src/term1-skill-routes.mjs'));
const require = createRequire(process.env.TERM2_DEPS_PACKAGE || new URL('../../../package.json', import.meta.url));
const express = require('express');

test('K56 app boots with the real teacher authentication middleware on the fallback route', async () => {
  const source = process.env.TERM2_RUNTIME_ROOT + '/src/';
  const { createApp } = await import(pathToFileURL(source + 'app.js'));
  const { loadConfig } = await import(pathToFileURL(source + 'config.js'));
  const config = loadConfig({ NODE_ENV: 'test', DEPLOYMENT_PROFILE: 'k56-ic2264',
    DATABASE_URL: 'postgres://fixture.invalid/fixture', GOOGLE_CLIENT_ID: 'fixture-client',
    TERM_TEST_ASSET_DIR: process.env.TERM2_RUNTIME_ROOT,
    TERM_TEST_SESSION_SECRET: 'isolated-app-fixture-secret-at-least-32' });
  const pool = { query() { assert.fail('Unauthenticated or invalid requests must not touch the database'); } };
  const app = createApp({ config, pool, journalEnv: {} });
  const request = require('supertest')(app);
  const route = '/api/term-tests/term-test-1-k56/skill-fallback';
  await request.post(route + '/issue').send({}).expect(401);
  const response = await request.post(route + '/open')
    .set('Origin', 'https://tranhoangduc90.github.io').send({}).expect(400);
  assert.equal(response.body.error, 'TERM1_SKILL_INVALID');
  assert.match(response.headers['access-control-allow-headers'], /\bx-term1-skill-grant\b/i);
});

for (const mode of ['lis_first', 'read_first']) {
test(`Teacher link → Reading result → original exam resumes (${mode})`, async t => {
  const f = await fixture(mode, { skipPrepare: true });
  t.after(f.close);
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const studentRef = randomUUID();
  const ownerId = randomUUID();
  let canIssue = true;
  let attemptExists = mode === 'lis_first';
  const audit = [];
  const scope = { classCode: 'FIXTURE', studentRef, section: 'reading' };
  registerTerm1SkillRoutes(router, {
    authenticate(req, res, next) {
      if (req.get('x-fixture-teacher')) return next();
      res.status(401).json({ ok: false });
    },
    readTeacherScope: async (_db, input, req) => {
      if (req.get('x-fixture-teacher') !== 'allowed' || input.student !== studentRef || input.class !== 'FIXTURE')
        throw Object.assign(Error('Fixture scope denied'), { status: 403, code: 'ACCESS_DENIED' });
    },
    transaction: work => f.db.transaction(work),
    prepare: async (_slug, input, create, db) => {
      if (!attemptExists && !create) return null;
      if (!attemptExists) assert.equal(input.mode, mode);
      attemptExists = true;
      return f.load(db, 'term-test-1-k56', f.a);
    },
    load: f.load,
    findStudent: async (_db, input) => input.studentRef === studentRef && input.classCode === 'FIXTURE'
      ? { class_id: '5601', student_id: '5602' } : null,
    assets: {},
    policy: 'term1-offline-v1',
    limiter: (_req, _res, next) => next(),
    readLimiter: (_req, _res, next) => next(),
    allowNew: () => canIssue,
    record(...args) { audit.push(args); return Promise.reject(new Error('Fixture journal unavailable')); }
  });
  app.use('/api/term-tests', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/term-tests/term-test-1-k56/skill-fallback';
  async function post(path, body, headers = {}, url = base) {
    const response = await fetch(url + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
    assert.match(response.headers.get('content-type'), /json/);
    return { status: response.status, ...(await response.json()) };
  }
  const teacher = { 'x-fixture-teacher': 'allowed' };
  assert.equal((await post('/issue', scope)).status, 401);
  assert.equal((await post('/manage', scope)).status, 401);
  assert.equal((await post('/issue', scope, { 'x-fixture-teacher': 'wrong-class' })).status, 403);
  assert.equal((await post('/manage', scope, { 'x-fixture-teacher': 'wrong-class' })).status, 403);
  assert.equal((await post('/issue', { ...scope, section: 'writing' }, teacher)).status, 400);
  const beforeGrant = await post('/manage', scope, teacher);
  assert.equal(beforeGrant.attemptExists, attemptExists);
  assert.equal(beforeGrant.activeGrant, null);
  if (!attemptExists) assert.equal((await post('/issue', scope, teacher)).error, 'TERM1_SKILL_MODE_REQUIRED');
  const issued = await post('/issue', { ...scope, ...attemptExists ? {} : { examMode: mode } }, teacher);
  assert.equal(issued.status, 200);
  assert.match(issued.activationCode, /^[A-F0-9]{16}$/);
  assert.ok(issued.token.startsWith(issued.grantId + '.'));
  assert.equal((await post('/issue', scope, teacher)).status, 409);
  const awaiting = await post('/manage', scope, teacher);
  assert.equal(awaiting.examMode, mode);
  assert.equal(awaiting.activeGrant.state, 'awaiting');
  assert.ok(!JSON.stringify(awaiting).includes(issued.activationCode));
  assert.ok(!JSON.stringify(awaiting).includes(issued.token));

  const header = { 'x-term1-skill-grant': issued.token };
  const input = { ...scope, ownerId };
  assert.equal((await post('/open', input, header)).status, 403);
  assert.equal((await post('/open', { ...input, activationCode: issued.activationCode, studentRef: randomUUID() }, header)).status, 403);
  const opened = await post('/open', { ...input, activationCode: issued.activationCode }, header);
  assert.equal(opened.status, 200);
  assert.match(opened.serverNow, /\d{4}/);
  assert.deepEqual(Object.keys(opened.content), ['reading']);
  for (const secret of [f.a, f.s, issued.token, issued.activationCode, 'audioKey', 'permit']) {
    assert.ok(!JSON.stringify(opened).includes(secret), secret);
  }
  canIssue = false;
  const disabled = await post('/manage', scope, teacher);
  assert.equal(disabled.issueEnabled, false);
  assert.equal(disabled.activeGrant.state, 'bound');
  assert.equal((await post('/issue', scope, teacher)).status, 503);
  assert.equal((await post('/open', { ...input, ownerId: randomUUID(), activationCode: issued.activationCode }, header)).status, 403);
  assert.equal((await post('/open', input, header)).grantId, issued.grantId);
  assert.equal((await post('/result', { grantId: issued.grantId, ownerId }, header)).result, null);

  const publicScope = { ...f.scope, ownerId, attemptToken: issued.grantId, examSessionToken: issued.grantId };
  const start = op(f, 'reading', 'start');
  const first = await post('/offline/operation', { ...start, ...publicScope }, header, f.base);
  assert.equal(first.receipt.status, 'accepted');
  const reopened = await post('/open', input, header);
  assert.equal(reopened.startedAt, start.payload.startedAt);
  const mainInput = { ...f.scope, classCode: 'FIXTURE', studentRef, mode };
  const mainBefore = mode === 'read_first' ? await f.request('/offline/prepare', mainInput) : null;
  if (mainBefore) assert.deepEqual(mainBefore.completedElsewhere, {});
  const seal = { ...op(f, 'reading', 'seal', { startedAt: start.payload.startedAt, revision: 1 }), ...publicScope };
  const saved = await post('/offline/operation', seal, header, f.base);
  const restored = await post('/offline/status', { ...publicScope, operationId: seal.operationId }, header, f.base);
  assert.deepEqual(saved.receipt, restored.receipt);
  const result = await post('/result', { grantId: issued.grantId, ownerId }, header);
  assert.equal(result.result.correct, 1);
  assert.equal(result.result.total, 26);
  assert.equal((await post('/result', { grantId: issued.grantId, ownerId: randomUUID() }, header)).status, 403);

  // The fallback-created run did not take ownership of the regular exam.
  const main = mainBefore ?? await f.request('/offline/prepare', mainInput);
  assert.equal(main.status, 200);
  const marker = { operationId: seal.operationId, startedAt: seal.payload.startedAt,
    deadlineAt: seal.payload.deadlineAt, revision: 1 };
  if (!mainBefore) assert.deepEqual(main.completedElsewhere, { reading: marker });
  const progress = await f.request('/offline/resume', f.scope, main.offline.permit);
  assert.deepEqual(progress.completedElsewhere, { reading: marker });
  assert.equal((await f.request('/offline/resume', f.scope, 'bad-permit')).status, 403);
  assert.equal((await post('/offline/resume', publicScope, header, f.base)).status, 404);
  const mainReceipt = await f.request('/offline/status', { ...f.scope, operationId: seal.operationId }, main.offline.permit);
  assert.equal(mainReceipt.persisted, false);
  const dispatch = await f.db.query('SELECT field, grade FROM assessment.k56_portal_field_dispatch WHERE attempt_id=$1', [f.a]);
  assert.deepEqual(dispatch.rows.map(row => [row.field, Number(row.grade)]), [['reading', 1]]);

  const dependency = mode === 'read_first' ? marker.operationId : null;
  const listenStart = op(f, 'listening', 'start', { dependency });
  const listening = await f.request('/offline/operation', listenStart, main.offline.permit);
  assert.equal(listening.receipt.status, 'accepted');
  const listenSeal = op(f, 'listening', 'seal', { dependency, startedAt: listenStart.payload.startedAt });
  assert.equal((await f.request('/offline/operation', listenSeal, main.offline.permit)).receipt.status, 'accepted');
  const writing = op(f, 'writing', 'start', { dependency: mode === 'read_first' ? listenSeal.operationId : marker.operationId });
  assert.equal((await f.request('/offline/operation', writing, main.offline.permit)).receipt.status, 'accepted');
  assert.equal((await post('/revoke', { ...scope, grantId: issued.grantId }, teacher)).status, 200);
  assert.equal((await post('/manage', scope, teacher)).activeGrant, null);
  assert.equal((await post('/result', { grantId: issued.grantId, ownerId }, header)).status, 403);
  assert.deepEqual(audit.map(([event, slug, attemptId, detail]) => [event, slug, attemptId, detail.operationId]), [
    ['term1_skill_grant_issued', 'term-test-1-k56', f.a, issued.grantId],
    ['term1_skill_grant_bound', 'term-test-1-k56', f.a, issued.grantId],
    ['term1_skill_grant_revoked', 'term-test-1-k56', f.a, issued.grantId]
  ]);
  assert.ok(!JSON.stringify(audit).includes(issued.activationCode) && !JSON.stringify(audit).includes(issued.token));
});
}
