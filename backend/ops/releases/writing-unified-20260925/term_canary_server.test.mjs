import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import request from 'supertest';
import { createTermCanary, redisCommand } from './term_canary_server.mjs';
import { verifyTermCanaryBrowserResult } from './term_canary_browser.mjs';

const WRITER_TRIAL_URL = 'https://n8n-ai.izone.edu.vn/webhook/term-k56-writer-bridge-00000000-0000-4000-8000-000000000321';

test('cổng thử từ chối URL ghi điểm không thuộc webhook thử và Mini', async () => {
  await assert.rejects(createTermCanary({ writerBridgeUrl: 'https://n8n-ai.izone.edu.vn/webhook/production' }),
    /CANARY_WRITER_ROUTE_INVALID/u);
  await assert.rejects(createTermCanary({ profileName: 'mini', writerBridgeUrl: WRITER_TRIAL_URL }),
    /CANARY_WRITER_TERM_ONLY/u);
});

test('Term K56 gọi adapter thật đúng một lần, lưu biên nhận và không gửi lặp', async () => {
  for (const profileName of ['term1', 'term']) {
    const redis = new Map();
    const requests = [];
    const canary = await createTermCanary({ profileName,
      writerBridgeUrl: WRITER_TRIAL_URL,
      writerFetchImpl: async (url, options) => {
        assert.equal(url, WRITER_TRIAL_URL);
        const payload = JSON.parse(options.body);
        requests.push(payload);
        return new Response(JSON.stringify({ ok: true, status: 'synced',
          attemptToken: payload.attemptToken }), { status: 200,
          headers: { 'content-type': 'application/json' } });
      },
      setRedis: async (key, value) => {
        if (redis.has(key)) return null;
        redis.set(key, value);
        return 'OK';
      },
      deleteRedis: async key => Number(redis.delete(key)),
    });
    try {
      const fixture = fakeCache({ testSlug: profileName === 'term1'
        ? 'term-test-1-k56' : 'term-test-2-k56',
      taskNumber: profileName === 'term1' ? 2 : 1 });
      assert.equal((await request(canary.app).post('/__canary/seed')
        .send({ cacheValue: fixture.value })).status, 200);
      const pending = await request(canary.app).get('/__canary/result');
      assert.equal(pending.status, 202);
      assert.deepEqual(pending.body, { ok: true, state: 'pending' });
      const secret = redis.get(canary.syncKey);
      const claimed = await request(canary.app)
        .post('/api/term-tests/writing-grading/jobs/claim')
        .set('x-writing-test-sync', secret)
        .send({ workerId: 'writer-bridge-unit', limit: 1 });
      assert.equal(claimed.body.jobs.length, 1);
      const job = claimed.body.jobs[0];
      const callback = () => request(canary.app)
        .post('/api/term-tests/writing-grading/jobs/result')
        .set('x-writing-test-sync', secret)
        .send({ jobId: job.jobId, workerId: 'writer-bridge-unit',
          runKey: fixture.runKey, result: JSON.parse(fixture.value).result });
      const first = await callback();
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.portalSyncStatus, 'synced');
      await callback();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].testSlug, fixture.runKey.split(':')[0]);
      assert.equal(requests[0].classId, profileName === 'term1' ? '99000001' : '99000002');
      assert.equal(requests[0].studentId, '9002');
      assert.deepEqual(requests[0].grades, { listening: 20, reading: profileName === 'term1' ? 13 : 20,
        writing: 6 });
      const audit = await request(canary.app).get('/__canary/audit');
      assert.equal(audit.body.portalSyncMode, 'writer_bridge');
      assert.deepEqual(audit.body.portalSyncStates, [{ status: 'synced', total: 1 }]);
      const result = await request(canary.app).get('/__canary/result');
      assert.equal(result.status, 200);
      assert.equal(result.body.testSlug, fixture.runKey.split(':')[0]);
      assert.equal(result.body.writing.grading.ready, true);
      assert.equal(result.body.writing.grading.tasks.length, 1);
      assert.equal(result.body.writing.grading.tasks[0].taskNumber,
        profileName === 'term1' ? 2 : 1);
      assert.equal(result.body.writing.grading.tasks[0].report, 'Báo cáo giả');
      assert.equal(result.body.portalSyncStatus, 'synced');
      assert.equal(result.body.attemptToken, requests[0].attemptToken);
      assert.equal(result.body.className, 'CODEX-CANARY');
      assert.equal(result.body.studentName, 'Học viên giả');
      assert.equal(profileName === 'term1' ? result.body.writing.task2
        : result.body.writing.task1, profileName === 'term1'
          ? 'Đoạn văn giả cho phép thử callback' : 'Bài giả cho phép thử callback');
      assert.equal(profileName === 'term1' ? result.body.writing.task1
        : result.body.writing.task2, '');
      const reopened = await request(canary.app).get('/__canary/result');
      assert.deepEqual(reopened.body, result.body);
      if (process.env.K56_PAGES_ROOT) {
        const browser = await verifyTermCanaryBrowserResult({
          result: result.body, pagesRoot: process.env.K56_PAGES_ROOT
        });
        assert.equal(browser.passed, true);
        assert.equal(browser.externalRequests, 0);
        if (profileName === 'term1') {
          const cli = spawnSync(process.execPath,
            ['backend/ops/releases/writing-unified-20260925/term_canary_browser_check.mjs'],
            { input: JSON.stringify(result.body), encoding: 'utf8',
              env: process.env, timeout: 45_000 });
          assert.equal(cli.status, 0, 'CANARY_BROWSER_CLI_FAILED');
          const output = JSON.parse(cli.stdout);
          assert.equal(output.businessOutcome, 'browser_result_verified');
          assert.equal(output.externalRequests, 0);
        }
      }
    } finally {
      await canary.close();
    }
    assert.equal(redis.size, 0);
  }
});

test('hai đề Term K56 seed một job dispatch đúng prompt/ảnh và không ghi Portal', async () => {
  for (const profileName of ['term1', 'term']) {
    const redis = new Map();
    const canary = await createTermCanary({ profileName,
      setRedis: async (key, value) => {
        if (redis.has(key)) return null;
        redis.set(key, value);
        return 'OK';
      },
      deleteRedis: async key => Number(redis.delete(key)),
    });
    try {
      const seeded = await request(canary.app).post('/__canary/seed-dispatch');
      assert.equal(seeded.status, 200);
      assert.equal(seeded.body.jobType, 'dispatch');
      const again = await request(canary.app).post('/__canary/seed-dispatch');
      assert.equal(again.status, 409);
      const claimed = await request(canary.app)
        .post('/api/term-tests/writing-grading/jobs/claim')
        .set('x-writing-test-sync', redis.get(canary.syncKey))
        .send({ workerId: 'canary-dispatch-test', limit: 1 });
      assert.equal(claimed.status, 200);
      assert.equal(claimed.body.jobs.length, 1);
      const job = claimed.body.jobs[0];
      assert.equal(job.jobType, 'dispatch');
      assert.equal(job.source, 'k56_web');
      assert.equal(job.testSlug, profileName === 'term1' ? 'term-test-1-k56' : 'term-test-2-k56');
      assert.equal(job.taskNumber, profileName === 'term1' ? 2 : 1);
      assert.equal(createHash('sha256').update(job.prompt.normalize('NFC')
        .replace(/\s+/gu, ' ').trim()).digest('hex'),
        profileName === 'term1'
          ? '23161a3ecea18085daa41b02336292839eb4b57536d9cf590efc2e29881007fb'
          : '869873a419079aba3a6d145c8700eddfc609c3865b1935d49fa698b7614d7c51');
      assert.equal(job.imageUrl, profileName === 'term1' ? ''
        : 'https://ducizone.ddns.net/writing-assets/v1/4a6b19c91981dbabf3bc559c7764a04ffb28ac4e1b61f9a954147c7712b337b1.png');
      assert.ok(job.essay.startsWith('This is a synthetic writing sample'));
      const audit = await request(canary.app).get('/__canary/audit');
      assert.equal(audit.body.portalMockCalls, 0);
      assert.equal(audit.body.attemptCount, 1);
    } finally {
      await canary.close();
    }
    assert.equal(redis.size, 0);
  }
});

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

function fakeCache({ testSlug = 'term-test-2-k56', taskNumber = 1 } = {}) {
  const runKey = `${testSlug}:canary-unit-test`;
  const codes = taskNumber === 1 ? ['TA', 'CC', 'LR', 'GRA']
    : ['TR', 'CC', 'LR', 'GRA'];
  return { runKey, value: JSON.stringify({ schemaVersion: 1, runKey,
    taskNumber, result: { taskScore: 6, report: 'Báo cáo giả',
      criteria: codes.map(code => ({ code, bandScore: 6,
        feedback: `Nhận xét giả ${code}`, components: [{
          code: `${code.toLowerCase()}_detail`, label: code,
          summary: 'Tóm tắt giả', feedback: 'Chi tiết giả' }] })) } }) };
}

test('Term Test 2 K56 giữ đúng lượt callback và chỉ gọi Portal giả một lần', async () => {
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
    assert.equal(claim.body.jobs[0].testSlug, 'term-test-2-k56');
    assert.equal(claim.body.jobs[0].taskNumber, 1);
    assert.equal(claim.body.jobs[0].rubricVersion, 'ielts-writing-v1');
    assert.equal(claim.body.jobs[0].operationId, claim.body.jobs[0].jobId);
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
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
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

test('hai tiến trình cùng nhận Term 2 chỉ chốt một việc và một lần ghi Portal giả', async () => {
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
    // Dữ liệu vào là một bài giả; hai request nhận việc và callback chạy đồng thời.
    // Kết quả cần giữ đúng một job hoàn tất và một tác động Portal giả.
    const fixture = fakeCache();
    const seeded = await request(canary.app).post('/__canary/seed')
      .send({ cacheValue: fixture.value });
    assert.equal(seeded.status, 200);
    const secret = redis.get(canary.syncKey);
    const workers = ['canary-worker-a', 'canary-worker-b'];
    const claims = await Promise.all(workers.map(workerId => request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/claim')
      .set('x-writing-test-sync', secret)
      .send({ workerId, limit: 1 })));
    assert.deepEqual(claims.map(item => item.status), [200, 200]);
    assert.equal(claims.reduce((total, item) => total + item.body.jobs.length, 0), 1);
    const winnerIndex = claims.findIndex(item => item.body.jobs.length === 1);
    const jobId = claims[winnerIndex].body.jobs[0].jobId;
    const resultBody = { jobId, workerId: workers[winnerIndex],
      runKey: fixture.runKey, result: JSON.parse(fixture.value).result };
    const callbacks = await Promise.all([0, 1].map(() => request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/result')
      .set('x-writing-test-sync', secret)
      .send(resultBody)));
    assert.ok(callbacks.some(item => item.status === 200));
    assert.ok(callbacks.every(item => [200, 409].includes(item.status)));
    const audit = await request(canary.app).get('/__canary/audit');
    assert.equal(audit.status, 200);
    assert.equal(audit.body.portalMockCalls, 1);
    assert.deepEqual(audit.body.jobs.map(item => [item.job_type, item.status, item.total]),
      [['collect', 'complete', 1], ['dispatch', 'complete', 1]]);
  } finally {
    await canary.close();
  }
  assert.equal(redis.size, 0);
});

test('Term Test 1 K56 Task 2 lưu đúng lượt và chỉ đồng bộ Portal giả một lần', async () => {
  const redis = new Map();
  const canary = await createTermCanary({ profileName: 'term1',
    setRedis: async (key, value) => {
      if (redis.has(key)) return null;
      redis.set(key, value);
      return 'OK';
    },
    deleteRedis: async key => Number(redis.delete(key)),
  });
  try {
    const fixture = fakeCache({ testSlug: 'term-test-1-k56', taskNumber: 2 });
    const seeded = await request(canary.app).post('/__canary/seed')
      .send({ cacheValue: fixture.value });
    assert.equal(seeded.status, 200);
    const secret = redis.get(canary.syncKey);
    const claimed = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/claim')
      .set('x-writing-test-sync', secret)
      .send({ workerId: 'term1-canary-worker', limit: 1 });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.jobs.length, 1);
    assert.equal(claimed.body.jobs[0].testSlug, 'term-test-1-k56');
    assert.equal(claimed.body.jobs[0].taskNumber, 2);
    const saved = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/result')
      .set('x-writing-test-sync', secret)
      .send({ jobId: claimed.body.jobs[0].jobId, workerId: 'term1-canary-worker',
        runKey: fixture.runKey, result: JSON.parse(fixture.value).result });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.portalSyncStatus, 'synced');
    const audit = await request(canary.app).get('/__canary/audit');
    assert.equal(audit.body.profileName, 'term1');
    assert.deepEqual(audit.body.runStates, [{ status: 'complete', task_number: 2 }]);
    assert.equal(audit.body.portalMockCalls, 1);
  } finally {
    await canary.close();
  }
  assert.equal(redis.size, 0);
});

test('Mini K56 giữ callback cũ và không nhận metadata adapter Term', async () => {
  const redis = new Map();
  const canary = await createTermCanary({ profileName: 'mini',
    setRedis: async (key, value) => {
      if (redis.has(key)) return null;
      redis.set(key, value);
      return 'OK';
    },
    deleteRedis: async key => Number(redis.delete(key)),
  });
  try {
    const fixture = fakeCache({ testSlug: 'mini-test-k56', taskNumber: 2 });
    const seeded = await request(canary.app).post('/__canary/seed')
      .send({ cacheValue: fixture.value });
    assert.equal(seeded.status, 200);
    assert.equal((await request(canary.app).get('/__canary/result')).status, 404);
    const claimed = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/claim')
      .set('x-writing-test-sync', redis.get(canary.syncKey))
      .send({ workerId: 'mini-canary-worker', limit: 1 });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.jobs.length, 1);
    assert.equal(claimed.body.jobs[0].testSlug, 'mini-test-k56');
    assert.equal(claimed.body.jobs[0].taskNumber, 2);
    // Phát hành Term không chuyển Mini sang contract chấm hợp nhất.
    for (const field of ['source', 'classId', 'attemptId', 'operationId', 'rubricVersion']) {
      assert.equal(Object.hasOwn(claimed.body.jobs[0], field), false);
    }
    const saved = await request(canary.app)
      .post('/api/term-tests/writing-grading/jobs/result')
      .set('x-writing-test-sync', redis.get(canary.syncKey))
      .send({ jobId: claimed.body.jobs[0].jobId, workerId: 'mini-canary-worker',
        runKey: fixture.runKey, result: JSON.parse(fixture.value).result });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.portalSyncStatus, 'not_applicable');
    const audit = await request(canary.app).get('/__canary/audit');
    assert.equal(audit.body.profileName, 'mini');
    assert.deepEqual(audit.body.runStates, [{ status: 'complete', task_number: 2 }]);
    assert.deepEqual(audit.body.jobs.map(item => [item.job_type, item.status]),
      [['collect', 'complete'], ['dispatch', 'complete']]);
    assert.equal(audit.body.portalMockCalls, 0);
  } finally {
    await canary.close();
  }
  assert.equal(redis.size, 0);
});
