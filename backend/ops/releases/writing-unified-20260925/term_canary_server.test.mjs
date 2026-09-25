import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import request from 'supertest';
import { createTermCanary, redisCommand } from './term_canary_server.mjs';

test('gửi Redis bằng số byte UTF-8, không cắt nhận xét tiếng Việt', async () => {
  let received = Buffer.alloc(0);
  const server = net.createServer(socket => socket.on('data', chunk => {
    received = Buffer.concat([received, chunk]);
    socket.write('+OK\r\n');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const value = 'Nhận xét giả tiếng Việt';
    const reply = await redisCommand(['SET', 'codex:test:key', value, 'EX', 60, 'NX'],
      { host: '127.0.0.1', port: server.address().port });
    assert.equal(reply, 'OK');
    assert.ok(received.includes(Buffer.from(`$${Buffer.byteLength(value, 'utf8')}\r\n${value}\r\n`,
      'utf8')));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function fakeCache() {
  const runKey = 'term-test-2-k56:canary-unit-test';
  const codes = ['TA', 'CC', 'LR', 'GRA'];
  return { runKey, value: JSON.stringify({ schemaVersion: 1, runKey,
    taskNumber: 1, result: { taskScore: 6, report: 'Báo cáo giả',
      criteria: codes.map(code => ({ code, bandScore: 6,
        feedback: `Nhận xét giả ${code}`, components: [{
          code: `${code.toLowerCase()}_detail`, label: code,
          summary: 'Tóm tắt giả', feedback: 'Chi tiết giả' }] })) } }) };
}

test('API Term canary tạo đúng một collect job và không gọi Portal thật', async () => {
  const redis = new Map();
  const canary = await createTermCanary({
    setRedis: async (key, value) => {
      if (redis.has(key)) return null;
      redis.set(key, value);
      return 'OK';
    },
    deleteRedis: async key => Number(redis.delete(key)),
  });
  try {
    const secret = redis.get(canary.syncKey);
    assert.match(secret, /^[0-9a-f]{64}$/u);
    const fixture = fakeCache();
    const first = await request(canary.app).post('/__canary/seed')
      .send({ cacheValue: fixture.value });
    assert.equal(first.status, 200);
    assert.equal(first.body.pendingJobs, 1);
    assert.equal(redis.get(`termtest:writing:direct:${fixture.runKey}`), fixture.value);
    const duplicate = await request(canary.app).post('/__canary/seed')
      .send({ cacheValue: fixture.value });
    assert.equal(duplicate.status, 409);
    const unauthorized = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/claim')
      .send({ workerId: 'canary-worker', limit: 1 });
    assert.equal(unauthorized.status, 401);
    const unrelated = await request(canary.app).get('/api/mapping/reviews');
    assert.equal(unrelated.status, 404);
    assert.equal(unrelated.body.error, 'CANARY_ROUTE_CLOSED');
    const claim = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/claim')
      .set('x-writing-test-sync', secret)
      .send({ workerId: 'canary-worker', limit: 1 });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.jobs.length, 1);
    assert.equal(claim.body.jobs[0].jobType, 'collect');
    assert.equal(claim.body.jobs[0].source, 'k56_web');
    assert.equal(claim.body.jobs[0].runKey, fixture.runKey);
    const claimedJob = claim.body.jobs[0];
    const wrong = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/result')
      .set('x-writing-test-sync', secret)
      .send({ jobId: claimedJob.jobId, workerId: 'canary-worker',
        runKey: 'term-test-2-k56:wrong-run',
        result: JSON.parse(fixture.value).result });
    assert.equal(wrong.status, 409);
    const saved = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/result')
      .set('x-writing-test-sync', secret)
      .send({ jobId: claimedJob.jobId, workerId: 'canary-worker',
        runKey: fixture.runKey, result: JSON.parse(fixture.value).result });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    const audit = await request(canary.app).get('/__canary/audit');
    assert.equal(audit.status, 200);
    assert.equal(audit.body.database, 'embedded_pglite');
    assert.equal(audit.body.portalMockCalls, 1);
    assert.equal(audit.body.attemptCount, 1);
    assert.deepEqual(audit.body.jobs.map(item => [item.job_type, item.status, item.total]),
      [['collect', 'complete', 1], ['dispatch', 'complete', 1]]);
  } finally {
    await canary.close();
  }
  assert.equal(redis.size, 0);
});
