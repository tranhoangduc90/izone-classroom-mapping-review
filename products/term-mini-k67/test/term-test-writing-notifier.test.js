import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const backendRoot = resolve(process.env.BACKEND_UNDER_TEST || fileURLToPath(new URL('..', import.meta.url)));
const notifierModuleUrl = pathToFileURL(resolve(backendRoot, 'src/term-test-writing-notifier.js')).href;
const {
  createTermTestWritingNotifier,
  fallbackSweepMs,
  withTermTestWritingNotifications
} = await import(notifierModuleUrl);

function makeTimerHarness() {
  const timers = [];
  const recurring = [];
  const cleared = [];
  return {
    timers,
    recurring,
    cleared,
    setTimer(callback, delay) {
      const timer = { kind: 'once', callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      cleared.push(timer);
    },
    setRecurringTimer(callback, delay) {
      const timer = { kind: 'recurring', callback, delay, unref() {} };
      recurring.push(timer);
      return timer;
    },
    clearRecurringTimer(timer) {
      cleared.push(timer);
    }
  };
}

test('bộ thông báo chỉ đánh thức số execution còn thiếu để giữ trần bốn job', async () => {
  const calls = [];
  const logs = [];
  const timers = makeTimerHarness();
  const notifier = createTermTestWritingNotifier({
    pool: {
      async query() {
        return {
          rows: [{
            active: 1,
            due: 6,
            next_at: new Date(Date.now() + 60_000),
            next_lease: null,
            server_now: new Date()
          }]
        };
      }
    },
    url: 'https://example.test/webhook/term-test-writing',
    secret: 's'.repeat(32),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, body: { async cancel() {} } };
    },
    log: message => logs.push(JSON.parse(message)),
    ...timers
  });

  await notifier.pump();

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['x-term-test-notify'], 's'.repeat(32));
    assert.deepEqual(JSON.parse(call.options.body), { kind: 'term_test_writing_ready' });
  }
  assert.deepEqual(logs.at(-1), { event: 'term_test_notify_sent', count: 3 });
  assert.equal(timers.recurring[0].delay, fallbackSweepMs);
  assert.equal(timers.timers.at(-1).delay, 30000);
  notifier.close();
  assert(timers.cleared.includes(timers.recurring[0]));
});

test('hàng trống không gọi webhook và lịch dự phòng chỉ kiểm mỗi năm phút', async () => {
  let fetchCount = 0;
  const timers = makeTimerHarness();
  const notifier = createTermTestWritingNotifier({
    pool: {
      async query() {
        return { rows: [{ active: 0, due: 0, next_at: null, next_lease: null, server_now: new Date() }] };
      }
    },
    url: 'https://example.test/webhook/term-test-writing',
    secret: 's'.repeat(32),
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, status: 200 };
    },
    log() {},
    ...timers
  });

  await notifier.pump();

  assert.equal(fetchCount, 0);
  assert.equal(timers.timers.length, 0);
  assert.equal(timers.recurring.length, 1);
  assert.equal(timers.recurring[0].delay, 300000);
  notifier.close();
});

test('lỗi webhook không làm mất job và chỉ hẹn thử lại sau 30 giây', async () => {
  const logs = [];
  const timers = makeTimerHarness();
  const notifier = createTermTestWritingNotifier({
    pool: {
      async query() {
        return { rows: [{ active: 0, due: 1, next_at: new Date(), next_lease: null, server_now: new Date() }] };
      }
    },
    url: 'https://example.test/webhook/term-test-writing',
    secret: 's'.repeat(32),
    fetchImpl: async () => ({ ok: false, status: 503, body: { async cancel() {} } }),
    log: message => logs.push(JSON.parse(message)),
    ...timers
  });

  await notifier.pump();

  assert.deepEqual(logs.at(-1), { event: 'term_test_notify_failed', retrySeconds: 30 });
  assert.equal(timers.timers.at(-1).delay, 30000);
  notifier.close();
});

test('chỉ đánh thức sau khi thao tác nghiệp vụ đã hoàn tất', async () => {
  const events = [];
  const service = {
    async ensureSubmission() {
      events.push('committed');
      return { ready: false };
    },
    async claimJobs() { return []; },
    async completeDispatch() { return {}; },
    async completeResult() { return {}; },
    async failJob() { return {}; }
  };
  const wrapped = withTermTestWritingNotifications(service, {
    kick() {
      events.push('notified');
    }
  });

  assert.deepEqual(await wrapped.ensureSubmission(), { ready: false });
  assert.deepEqual(events, ['committed', 'notified']);
  assert.throws(
    () => createTermTestWritingNotifier({
      pool: {},
      url: 'http://example.test/insecure',
      secret: 's'.repeat(32)
    }),
    /TERM_TEST_NOTIFY_CONFIG_INVALID/
  );
});

test('thao tác nghiệp vụ rollback thì không gửi tín hiệu', async () => {
  let notified = false;
  const failure = new Error('ROLLBACK');
  const wrapped = withTermTestWritingNotifications({
    async ensureSubmission() { throw failure; },
    async claimJobs() { return []; },
    async completeDispatch() { return {}; },
    async completeResult() { return {}; },
    async failJob() { return {}; }
  }, {
    kick() { notified = true; }
  });

  await assert.rejects(wrapped.ensureSubmission(), error => error === failure);
  assert.equal(notified, false);
});
