import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import request from 'supertest';
import { createContextSourceApp } from '../src/context-source.js';

const secret = 's'.repeat(32);
const capturedAt = new Date('2026-11-12T12:00:00Z');
const snapshotPath = '/v1/snapshot';

function fixture({ connectError, classesQuery, onLog } = {}) {
  const logs = [];
  let time = 0, calls = 0;
  const pool = {
    async connect() {
      calls++;
      time += 7;
      if (connectError) throw connectError;
      return {
        async query(sql) {
          time += 3;
          if (sql.includes('transaction_timestamp')) return { rows: [{ captured: capturedAt }] };
          if (sql.includes('.classes ') && classesQuery) return classesQuery();
          return { rows: [] };
        },
        release() {}
      };
    },
    async query() { time += 11; return { rows: [] }; }
  };
  const app = createContextSourceApp({ pool, secret, log: row => { logs.push(row); onLog?.(row); }, now: () => time });
  return { app, logs, calls: () => calls };
}

test('logs end-to-end response and individual snapshot stages; rejection never opens the pool', async () => {
  const { app, logs, calls } = fixture();
  await request(app).get(snapshotPath).set('x-k67-context-key', 'wrong').expect(401);
  assert.equal(calls(), 0);
  const response = await request(app).get(snapshotPath).set('x-k67-context-key', secret).expect(200);
  assert.equal(response.body.capturedAt, capturedAt.toISOString());
  assert.equal(logs.length, 2);
  assert.equal(logs[0].errorCode, 'UNAUTHORIZED');
  assert.equal(logs[0].stage, 'authorize');
  assert.equal(logs[1].event, 'k67_context_request');
  assert.equal(logs[1].version, 1);
  assert.equal(logs[1].requestId, response.headers['x-request-id']);
  assert.equal(logs[1].durationMs, 34);
  assert.equal(logs[1].stageMs.pool_wait, 7);
  assert.equal(logs[1].stageMs.memberships, 3);
  assert.equal(logs[1].status, 200);
  assert.equal(logs[1].errorCode, null);
});

test('distinguishes pool timeout from SQL timeout without recording private driver text', async () => {
  const timeout = new Error('timeout exceeded when trying to connect');
  const sqlError = Object.assign(new Error('canceling statement due to statement timeout; private database detail'), { code: '57014' });
  for (const [options, code, stage] of [
    [{ connectError: timeout }, 'DB_POOL_TIMEOUT', 'pool_wait'],
    [{ classesQuery: () => { throw sqlError; } }, 'DB_STATEMENT_TIMEOUT', 'classes']
  ]) {
    const { app, logs } = fixture(options);
    const response = await request(app).get(snapshotPath).set('x-k67-context-key', secret).expect(503);
    assert.deepEqual(response.body, { ok: false, error: 'CONTEXT_SOURCE_UNAVAILABLE' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 503);
    assert.equal(logs[0].errorCode, code);
    assert.equal(logs[0].failureStage, stage);
    assert.doesNotMatch(JSON.stringify(logs), /private database detail|trying to connect/);
  }
});

test('records a client disconnect once with the stage in progress', { timeout: 3000 }, async t => {
  let entered, release, observed;
  const inQuery = new Promise(resolve => { entered = resolve; });
  const finishQuery = new Promise(resolve => { release = resolve; });
  const logged = new Promise(resolve => { observed = resolve; });
  const { app, logs } = fixture({ classesQuery: () => { entered(); return finishQuery; }, onLog: observed });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { release({ rows: [] }); server.close(); });
  await once(server, 'listening');
  const req = http.get({ host: '127.0.0.1', port: server.address().port, path: snapshotPath,
    headers: { 'x-k67-context-key': secret } });
  req.on('error', () => {});
  await inQuery;
  req.destroy();
  await logged;
  release({ rows: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 499);
  assert.equal(logs[0].errorCode, 'CLIENT_DISCONNECTED');
  assert.equal(logs[0].stage, 'classes');
});

test('the two Homework routes keep their live response shape and emit timing', async () => {
  const { app, logs } = fixture();
  const routes = [
    ['/v1/homework/class-scope', body => body.classes],
    ['/v1/homework/erp-students', body => body.students]
  ];
  for (const [path, read] of routes) {
    const response = await request(app).get(path).set('x-k67-context-key', secret).expect(200);
    assert.deepEqual(read(response.body), []);
    assert.equal(logs.at(-1).route, path);
    assert.equal(logs.at(-1).stageMs.query, 11);
  }
});
