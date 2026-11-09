import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
process.env.K56_TEST_PRODUCT ||= '1';
const testSlug = `term-test-${process.env.K56_TEST_PRODUCT}-k56`;
const operationTable = `assessment.term${process.env.K56_TEST_PRODUCT}_offline_operation`;
const { fixture, op } = await import('./test.mjs');
const { nextK56Section, registerK56ExamOrder } = await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT + '/src/k56-exam-order.js'));
const express = createRequire(process.env.TERM2_DEPS_PACKAGE || new URL('../../../package.json', import.meta.url))('express');

async function readInterruptedResult(attempt) {
  const app = express();
  app.use(express.json());
  const grading = { ready: true, status: 'ready', writingScore: 6 };
  const pool = { async query(sql, args) {
    assert.match(sql, /^SELECT a\.\*/);
    assert.deepEqual(args, [attempt.attempt_token]);
    return { rows: [{ ...attempt, class_name_snapshot: 'FIXTURE' }] };
  } };
  registerK56ExamOrder(app, {
    pool, profile: { family: 'k56' }, limiter: (_req, _res, next) => next(),
    readPortalSyncStatus: async (_row, result) => { assert.equal(result.listening, null); return 'synced'; },
    readSkillWriting: async (client, row) => {
      assert.equal(client, pool);
      assert.equal(row.attempt_token, attempt.attempt_token);
      return grading;
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/result`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptToken: attempt.attempt_token })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.className, 'FIXTURE');
    assert.equal(result.listeningInterrupted, true);
    assert.equal(result.result.listening, null);
    assert.ok(result.result.reading);
    assert.equal(result.writing?.submitted, true);
    assert.deepEqual(result.writing.grading, grading);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

for (const mode of ['lis_first', 'read_first']) {
  test(`${mode}: gián đoạn mở đúng kỹ năng tiếp theo và không tạo điểm Listening`, async () => {
    const f = await fixture(mode, { listeningInterruption: true });
    try {
      let dependency = null;
      if (mode === 'read_first') {
        const start = op(f, 'reading', 'start');
        assert.equal((await f.request('/offline/operation', start)).receipt?.status, 'accepted');
        const seal = op(f, 'reading', 'seal', { startedAt: start.payload.startedAt });
        assert.equal((await f.request('/offline/operation', seal)).receipt?.status, 'accepted');
        dependency = seal.operationId;
      }
      const start = op(f, 'listening', 'start', { dependency });
      assert.equal((await f.request('/offline/operation', start)).receipt?.status, 'accepted');
      f.advance(1000);
      const interruption = op(f, 'listening', 'interrupt', {
        dependency, startedAt: start.payload.startedAt
      });
      delete interruption.payload.answers;
      interruption.payload.interruptionReason = 'learner_cannot_hear';
      // Turning enrollment off during rollback keeps already-issued permits usable.
      f.setEnrollment(false);
      const result = await f.request('/offline/operation', interruption);
      assert.equal(result.receipt?.status, 'accepted', JSON.stringify(result));
      assert.equal(result.receipt.kind, 'interrupt');
      assert.deepEqual((await f.request('/offline/operation', interruption)).receipt, result.receipt);
      assert.deepEqual((await f.request('/offline/status', {
        ...f.scope, operationId: interruption.operationId
      })).receipt, result.receipt);
      if (process.env.K56_TEST_PRODUCT === '1') {
        const resumed = await f.request('/offline/resume', f.scope);
        assert.equal(resumed.listeningInterruption?.operationId, interruption.operationId);
        assert.equal(resumed.completedElsewhere.listening, undefined);
      }
      const interruptedAttempt = await f.load(f.pool, testSlug, f.a);
      assert.equal(nextK56Section(interruptedAttempt), mode === 'lis_first' ? 'reading' : 'writing');

      const conflictingSeal = op(f, 'listening', 'seal', { dependency, startedAt: start.payload.startedAt });
      assert.equal((await f.request('/offline/operation', conflictingSeal)).error, 'OFFLINE_SECTION_LOCKED');
      dependency = interruption.operationId;
      for (const section of mode === 'lis_first' ? ['reading', 'writing'] : ['writing']) {
        const next = op(f, section, 'start', { dependency });
        const opened = await f.request('/offline/operation', next);
        assert.equal(opened.receipt?.status, 'accepted', JSON.stringify(opened));
        const seal = op(f, section, 'seal', { dependency, startedAt: next.payload.startedAt });
        const submitted = await f.request('/offline/operation', seal);
        assert.equal(submitted.receipt?.status, 'accepted', JSON.stringify(submitted));
        dependency = seal.operationId;
      }
      const attempt = await f.load(f.pool, testSlug, f.a);
      assert.equal(attempt.listening_submitted_at, null);
      assert.equal(attempt.listening_result, null);
      assert.ok(attempt.listening_interrupted_at);
      assert.ok(attempt.reading_submitted_at);
      assert.ok(attempt.writing_submitted_at);
      assert.deepEqual((await f.db.query("SELECT field FROM assessment.k56_portal_field_dispatch WHERE field = 'listening'")).rows, []);
      await readInterruptedResult(attempt);
      const fresh = { attemptToken: randomUUID(), examSessionToken: randomUUID(), generation: 0, ownerId: randomUUID() };
      await f.db.query('INSERT INTO assessment.term_test_attempt(id,test_slug,exam_session_id,exam_mode) VALUES($1,$2,$3,$4)',
        [fresh.attemptToken, testSlug, fresh.examSessionToken, mode]);
      await f.db.query('INSERT INTO assessment.term_test_exam_session(id) VALUES($1)', [fresh.examSessionToken]);
      const denied = await f.request('/offline/prepare', { ...fresh, classCode: 'FIXTURE', studentRef: randomUUID(), mode });
      assert.equal(denied.error, 'OFFLINE_NEW_DISABLED');
    } finally {
      await f.close();
    }
  });
}

test('Đã nộp Listening thì yêu cầu báo gián đoạn đến sau không đổi kết quả', async () => {
  const f = await fixture('lis_first', { listeningInterruption: true });
  try {
    const start = op(f, 'listening', 'start');
    assert.equal((await f.request('/offline/operation', start)).receipt?.status, 'accepted');
    const seal = op(f, 'listening', 'seal', { startedAt: start.payload.startedAt });
    assert.equal((await f.request('/offline/operation', seal)).receipt?.status, 'accepted');
    const interruption = op(f, 'listening', 'interrupt', { startedAt: start.payload.startedAt });
    delete interruption.payload.answers;
    interruption.payload.interruptionReason = 'learner_cannot_hear';
    assert.equal((await f.request('/offline/operation', interruption)).error, 'OFFLINE_SECTION_LOCKED');
    const attempt = await f.load(f.pool, testSlug, f.a);
    assert.ok(attempt.listening_submitted_at);
    assert.ok(attempt.listening_result);
    assert.equal(attempt.listening_interrupted_at, null);
    assert.equal((await f.db.query("SELECT field FROM assessment.k56_portal_field_dispatch WHERE field='listening'")).rows.length, 1);
  } finally { await f.close(); }
});

for (const winner of ['seal', 'interrupt']) {
  test(`PostgreSQL chỉ commit một kết quả khi seal và interrupt đến đồng thời (${winner} tới trước)`, {
    skip: !process.env.TERM2_TEST_PG_URL
  }, async () => {
    const locked = Promise.withResolvers();
    const release = Promise.withResolvers();
    let heldOperation;
    const f = await fixture('lis_first', {
      listeningInterruption: true,
      beforeReceipt: async args => {
        if (args[0] !== heldOperation) return;
        locked.resolve();
        await release.promise;
      }
    });
    try {
      const start = op(f, 'listening', 'start');
      assert.equal((await f.request('/offline/operation', start)).receipt?.status, 'accepted');
      const seal = op(f, 'listening', 'seal', { startedAt: start.payload.startedAt });
      const interrupt = op(f, 'listening', 'interrupt', { startedAt: start.payload.startedAt });
      delete interrupt.payload.answers;
      interrupt.payload.interruptionReason = 'learner_cannot_hear';
      const [first, second] = winner === 'seal' ? [seal, interrupt] : [interrupt, seal];
      heldOperation = first.operationId;
      const firstResponse = f.request('/offline/operation', first);
      await Promise.race([locked.promise, firstResponse.then(() => assert.fail('Giao dịch đầu chưa giữ khóa'))]);
      const secondResponse = f.request('/offline/operation', second);
      const overlap = await Promise.race([secondResponse.then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 100))]);
      assert.equal(overlap, true, 'Giao dịch thứ hai phải chờ giao dịch đang giữ khóa');
      release.resolve();
      const [accepted, rejected] = await Promise.all([firstResponse, secondResponse]);
      assert.equal(accepted.receipt?.status, 'accepted');
      assert.equal(rejected.error, 'OFFLINE_SECTION_LOCKED');
      const attempt = await f.load(f.pool, testSlug, f.a);
      assert.equal(Boolean(attempt.listening_submitted_at), winner === 'seal');
      assert.equal(Boolean(attempt.listening_interrupted_at), winner === 'interrupt');
      const terminal = (await f.db.query(`SELECT kind FROM ${operationTable} WHERE kind IN ('seal','interrupt')`)).rows;
      assert.deepEqual(terminal, [{ kind: winner }]);
    } finally {
      release.resolve();
      await f.close();
    }
  });
}
