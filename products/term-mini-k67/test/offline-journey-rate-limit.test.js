import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { examRateIdentity, examRateKey } from '../src/exam-rate-limit.js';

test('two classes sharing an IP can reconnect while unknown sessions keep the IP budget', async t => {
  const sessions = new Map(Array.from({ length: 64 }, (_, i) => [randomUUID(), i < 32 ? 'term-test-1' : 'term-test-2']));
  const queries = [];
  const pool = { query: async (_sql, [id, slug, generation]) => {
    queries.push([id, slug, generation]);
    return { rows: sessions.get(id) === slug && generation === 4 ? [{ id }] : [] };
  } };
  const app = express();
  app.use(express.json(), examRateIdentity(pool));
  const burstLimit = rateLimit({ windowMs: 60_000, limit: 120, keyGenerator: examRateKey });
  const received = new Map();
  const receive = (req, res) => {
    const identity = req.examRateIdentity || 'shared-ip';
    received.set(identity, (received.get(identity) ?? 0) + 1);
    res.sendStatus(200);
  };
  app.post('/api/term-tests/:slug/paper-journey/seal', burstLimit, receive);
  app.post('/api/term-tests/:slug/cbt-journey/begin', burstLimit, receive);
  app.post('/api/term-tests/:slug/cbt-journey/status', burstLimit, receive);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const client = request(server);
  const submit = (slug, examSessionToken, generation = 4, path = 'paper-journey/seal') => client
    .post(`/api/term-tests/${slug}/${path}`).send({ examSessionToken, generation });
  const routes = ['paper-journey/seal', 'cbt-journey/begin', 'cbt-journey/status'];
  const results = await Promise.all([...sessions].flatMap(([token, slug]) =>
    routes.map(route => submit(slug, token, 4, route))));
  assert.equal(results.length, 192);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(received.size, 64);
  for (const examSessionToken of sessions.keys()) assert.equal(received.get(`session:${examSessionToken}`), 3);

  const [known, slug] = sessions.entries().next().value;
  const wrongSlug = slug === 'term-test-1' ? 'term-test-2' : 'term-test-1';
  assert.equal((await submit(wrongSlug, known)).status, 200);
  assert.equal((await submit(slug, known, 3)).status, 200);
  assert.ok(queries.some(([id, testedSlug]) => id === known && testedSlug === wrongSlug));
  for (let i = 0; i < 118; i++) assert.equal((await submit(slug, randomUUID())).status, 200);
  assert.equal((await submit(slug, randomUUID())).status, 429);
  assert.equal(received.get('shared-ip'), 120);
  assert.equal((await submit(slug, known)).status, 200);
});
