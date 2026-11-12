import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.K56_MINI_FIXTURE_IMPORT_ONLY = '1';
process.env.MINI_K56_CBT_OFFLINE_NEW = 'true';
process.env.MINI_K56_PAPER_OFFLINE_NEW = 'true';
process.env.K56_MINI_HOLD_CLASSES = 'FIXTURE';
process.env.K56_MINI_HOLD_HOURS = '2';
process.env.K56_MINI_HOLD_LIMIT = '8';
process.env.K56_MINI_HOLD_PAPER = 'true';
const { fixture } = await import('../mini-k56-offline-20261107/test.mjs');
const migration = await readFile(new URL('./mini-k56-submission-hold.sql', import.meta.url), 'utf8');

for (const mode of ['lis_first', 'read_first']) {
  for (const paper of [false, true]) {
    test('Mini K56 ' + (paper ? 'paper' : 'CBT') + ' retains a rejected seal and recovers a lost ACK · ' + mode, async t => {
      let drop;
      const f = await fixture(mode, paper, {
        dropResponse: (body, result) => body?.operationId === drop && result.receipt?.status === 'accepted'
      });
      t.after(() => f.close());
      await f.db.exec('CREATE ROLE k56_shared_api NOLOGIN');
      await f.db.exec(migration);
      assert.equal((await f.prepare()).offline?.submissionRecoveryVersion, 1);
      let dependency = null;
      const skills = mode === 'lis_first' ? ['listening', 'reading'] : ['reading', 'listening'];
      function op(section, kind, { revision = 0, startedAt = f.clock(), answers = { '1': 'A' }, task2 = '',
        reason = 'manual' } = {}) {
        const deadlineAt = paper || section === 'listening' ? null
          : new Date(Date.parse(startedAt) + (section === 'reading' ? 25 : 15) * 60000).toISOString();
        return {
          ...f.scope, operationId: randomUUID(), section, kind, revision, dependency, occurredAt: f.clock(),
          payload: { startedAt, deadlineAt, timeValid: true, ...(section === 'writing' ? { task2 } : { answers }),
            ...(kind === 'seal' ? { reason } : {}) }
        };
      }
      const read = operation => f.request('status', { ...f.scope, operationId: operation.operationId });
      const invalid = op(skills[0], 'seal', { answers: { '1': 'Chốt trước khi có mốc bắt đầu' } });
      const held = await f.request('operation', invalid);
      assert.equal(held.status, 409);
      assert.equal(held.error, 'OFFLINE_START_REQUIRED');
      assert.ok(held.held?.payloadHash);
      assert.equal((await read(invalid)).receipt, null);
      assert.deepEqual((await read(invalid)).held, held.held);
      assert.equal((await f.request('hold', { ...invalid, operationId: randomUUID(), ownerId: randomUUID() })).status, 403);
      const { rows: [stored] } = await f.db.query(`SELECT payload,section FROM assessment.mini_k56_submission_hold
        WHERE attempt_id=$1 AND operation_id=$2`, [f.a, invalid.operationId]);
      assert.deepEqual(stored.payload.payload.answers, invalid.payload.answers);
      assert.equal(stored.section, skills[0]);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.k56_portal_field_dispatch')).rows[0].n, 0);

      for (const section of skills) {
        const start = op(section, 'start');
        assert.equal((await f.request('operation', start)).receipt?.status, 'accepted');
        if (paper && section === skills[0]) {
          const auto = op(section, 'seal', { startedAt: start.payload.startedAt, revision: 1, reason: 'deadline' });
          const review = await f.request('operation', auto);
          assert.equal(review.receipt?.reason, 'PAPER_MANUAL_ONLY');
          assert.deepEqual((await read(auto)).held, review.held);
          assert.ok(review.held?.payloadHash);
        }
        const seal = op(section, 'seal', { startedAt: start.payload.startedAt, revision: 2 });
        if (section === skills[1]) {
          drop = seal.operationId;
          await assert.rejects(() => f.request('operation', seal));
          drop = undefined;
        } else assert.equal((await f.request('operation', seal)).receipt?.status, 'accepted');
        const receipt = (await read(seal)).receipt;
        assert.equal(receipt?.status, 'accepted');
        assert.deepEqual((await f.request('operation', seal)).receipt, receipt);
        dependency = seal.operationId;
      }
      const writing = op('writing', 'seal', { task2: 'Mini writing paragraph.' });
      if (paper) {
        assert.equal((await f.request('hold', writing)).error, 'MODE_CONFLICT');
        assert.equal((await read(writing)).held, undefined);
      } else {
        const start = op('writing', 'start');
        assert.equal((await f.request('operation', start)).receipt?.status, 'accepted');
        const blank = mode === 'lis_first';
        const seal = op('writing', 'seal', { startedAt: start.payload.startedAt, revision: 1,
          task2: blank ? '\t \n\u200b' : writing.payload.task2 });
        const receipt = (await f.request('operation', seal)).receipt;
        assert.equal(receipt.status, 'accepted');
        assert.equal(Boolean(receipt.writingBlank), blank);
        assert.deepEqual((await read(seal)).receipt, receipt);
        if (blank) assert.equal((await f.ensure('Later local content')).status, 'blank');
      }
      const { rows: [counts] } = await f.db.query(`SELECT
        (SELECT count(*)::int FROM assessment.mini_k56_offline_operation WHERE kind='seal'
          AND receipt->>'status'='accepted') AS receipts,
        (SELECT count(*)::int FROM assessment.term_test_writing_grading_job) AS jobs,
        (SELECT count(*)::int FROM assessment.k56_portal_field_dispatch) AS scores`);
      assert.deepEqual(counts, { receipts: paper ? 2 : 3, jobs: !paper && mode === 'read_first' ? 1 : 0, scores: 2 });
    });
  }
}

test('Mini paper recovery opt-in can be disabled independently of CBT', async t => {
  const previous = process.env.K56_MINI_HOLD_PAPER;
  process.env.K56_MINI_HOLD_PAPER = '';
  const f = await fixture('lis_first', true);
  process.env.K56_MINI_HOLD_PAPER = previous;
  t.after(() => f.close());
  await f.db.exec('CREATE ROLE k56_shared_api NOLOGIN');
  await f.db.exec(migration);
  const prepared = await f.prepare();
  assert.equal(prepared.status, 200);
  assert.equal(prepared.offline.submissionRecoveryVersion, undefined);
});
