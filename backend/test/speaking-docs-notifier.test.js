import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createSpeakingDocsNotifier, speakingDocsStatusSql } from '../src/speaking-docs-notifier.js';

function timers() {
  const one = [];
  const repeat = [];
  return {
    one, repeat,
    setTimer(callback, delay) { const value = { callback, delay, unref() {} }; one.push(value); return value; },
    clearTimer() {},
    setRecurringTimer(callback, delay) { const value = { callback, delay, unref() {} }; repeat.push(value); return value; },
    clearRecurringTimer() {}
  };
}

test('hàng ghi Docs rỗng không tạo execution n8n; mất tín hiệu vẫn được quét bù', async () => {
  const clock = timers();
  let sends = 0;
  const notifier = createSpeakingDocsNotifier({
    pool: { async query() { return { rows: [{ due: 0, next_at: null, server_now: new Date() }] }; } },
    url: 'https://example.test/webhook/speaking-docs', secret: 's'.repeat(32),
    fetchImpl: async () => { sends += 1; return { ok: true }; },
    log() {}, ...clock
  });
  await notifier.pump();
  assert.equal(sends, 0);
  assert.equal(clock.repeat.length, 1);
  assert.equal(clock.repeat[0].delay, 300_000);
  assert.match(speakingDocsStatusSql, /kind='write_doc'/);
  await notifier.close();
});

test('một job đến hạn đánh thức đúng một lần, lỗi HTTP không làm mất hàng chờ', async () => {
  const clock = timers();
  const calls = [];
  const notifier = createSpeakingDocsNotifier({
    pool: { async query() { return { rows: [{ due: 3, next_at: new Date(), server_now: new Date() }] }; } },
    url: 'https://example.test/webhook/speaking-docs', secret: 's'.repeat(32),
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return { ok: false, status: 503, body: { async cancel() {} } };
    },
    now: () => 20_000, log() {}, ...clock
  });
  await notifier.pump();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Bearer ${'s'.repeat(32)}`);
  assert.equal(clock.one.at(-1).delay, 30_000);
  await notifier.close();
});

test('hai backend chỉ một bên giữ khóa điều phối', async () => {
  let sends = 0;
  const clock = timers();
  const candidate = {
    rows: [],
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: false }] };
      throw new Error('Không được đọc hàng chờ khi không giữ khóa');
    },
    release() {}, on() {}
  };
  const notifier = createSpeakingDocsNotifier({
    pool: { async connect() { return candidate; }, async query() { throw new Error('Không được query'); } },
    url: 'https://example.test/webhook/speaking-docs', secret: 's'.repeat(32),
    fetchImpl: async () => { sends += 1; return { ok: true }; },
    log() {}, ...clock
  });
  assert.equal(await notifier.start(), false);
  assert.equal(sends, 0);
  await notifier.close();
});

test('câu SQL chỉ tính job ghi Docs đủ hạn, không kéo job AI sang n8n', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA speaking_homework;
      CREATE TABLE speaking_homework.outbox (
        kind text, status text, attempts integer, created_at timestamptz, updated_at timestamptz
      );
      INSERT INTO speaking_homework.outbox VALUES
        ('write_doc','pending',0,now(),now()),
        ('write_doc','failed',1,now(),now()-interval '31 seconds'),
        ('write_doc','processing',1,now(),now()-interval '6 minutes'),
        ('write_doc','failed',1,now(),now()),
        ('write_doc','pending',5,now(),now()),
        ('grade_speaking','pending',0,now(),now());`);
    const result = await db.query(speakingDocsStatusSql);
    assert.equal(result.rows[0].due, 3);
  } finally {
    await db.close();
  }
});
