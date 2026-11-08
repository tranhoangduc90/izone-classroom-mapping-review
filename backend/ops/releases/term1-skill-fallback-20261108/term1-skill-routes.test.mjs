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

test('Teacher link → learner activation → isolated Reading content and result → original exam receipt', async t => {
  const f = await fixture('lis_first', { skipPrepare: true });
  t.after(f.close);
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const studentRef = randomUUID();
  const ownerId = randomUUID();
  let canIssue = true;
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
    prepare: async (_slug, _identity, _create, db) => f.load(db, 'term-test-1-k56', f.a),
    load: f.load,
    findStudent: async (_db, input) => input.studentRef === studentRef && input.classCode === 'FIXTURE'
      ? { class_id: '5601', student_id: '5602' } : null,
    assets: {},
    policy: 'term1-offline-v1',
    limiter: (_req, _res, next) => next(),
    readLimiter: (_req, _res, next) => next(),
    allowNew: () => canIssue
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
  assert.equal((await post('/issue', scope, { 'x-fixture-teacher': 'wrong-class' })).status, 403);
  assert.equal((await post('/issue', { ...scope, section: 'writing' }, teacher)).status, 400);
  const issued = await post('/issue', scope, teacher);
  assert.equal(issued.status, 200);
  assert.match(issued.activationCode, /^[A-F0-9]{16}$/);
  assert.ok(issued.token.startsWith(issued.grantId + '.'));
  assert.equal((await post('/issue', scope, teacher)).status, 409);

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
  const seal = { ...op(f, 'reading', 'seal', { startedAt: start.payload.startedAt, revision: 1 }), ...publicScope };
  const saved = await post('/offline/operation', seal, header, f.base);
  const restored = await post('/offline/status', { ...publicScope, operationId: seal.operationId }, header, f.base);
  assert.deepEqual(saved.receipt, restored.receipt);
  const result = await post('/result', { grantId: issued.grantId, ownerId }, header);
  assert.equal(result.result.correct, 1);
  assert.equal(result.result.total, 26);
  assert.equal((await post('/result', { grantId: issued.grantId, ownerId: randomUUID() }, header)).status, 403);

  // The fallback-created run did not take ownership of the regular exam.
  const main = await f.request('/offline/prepare', { ...f.scope, classCode: 'FIXTURE', studentRef, mode: 'lis_first' });
  assert.equal(main.status, 200);
  const listening = await f.request('/offline/operation', op(f, 'listening', 'start'), main.offline.permit);
  assert.equal(listening.receipt.status, 'accepted');
  const dispatch = await f.db.query('SELECT field, grade FROM assessment.k56_portal_field_dispatch WHERE attempt_id=$1', [f.a]);
  assert.deepEqual(dispatch.rows.map(row => [row.field, Number(row.grade)]), [['reading', 1]]);
  assert.equal((await post('/revoke', { ...scope, grantId: issued.grantId }, teacher)).status, 200);
  assert.equal((await post('/result', { grantId: issued.grantId, ownerId }, header)).status, 403);
});
