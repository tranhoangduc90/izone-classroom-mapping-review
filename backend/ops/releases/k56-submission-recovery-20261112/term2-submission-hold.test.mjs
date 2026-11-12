import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.TERM2_TEST_PG_URL || '', '', 'Only isolated PGlite is supported by this suite.');
process.env.K56_TEST_PRODUCT = '2';
process.env.TERM2_FIXTURE_IMPORT_ONLY = '1';
process.env.K56_TERM2_HOLD_HOURS = '2';
process.env.K56_TERM2_HOLD_LIMIT = '8';
process.env.K56_TERM2_HOLD_CLASSES = 'FIXTURE';
const root = process.env.TERM2_RUNTIME_ROOT;
assert.ok(root);
const { fixture, op } = await import(pathToFileURL(resolve(root, 'term1-offline-20261107/test.mjs')));
const migration = await readFile(new URL('./term2-submission-hold.sql', import.meta.url), 'utf8');

async function setup(t, mode, options) {
  const fixtureRun = await fixture(mode, { skipPrepare: true, ...options });
  t.after(() => fixtureRun.close());
  await fixtureRun.db.exec('CREATE ROLE k56_shared_api NOLOGIN');
  await fixtureRun.db.exec('ALTER TABLE assessment.term_test_attempt ADD COLUMN writing_updated_at timestamptz');
  await fixtureRun.db.exec(migration);
  const { scope, permit } = await fixtureRun.newRun();
  return {
    ...fixtureRun, scope, get clock() { return fixtureRun.clock; },
    request(path, body, credential = permit) { return fixtureRun.request(path, body, credential); }
  };
}

const submit = (f, op) => f.request('/offline/operation', op);
const status = (f, op) => f.request('/offline/status', { ...f.scope, operationId: op.operationId });

async function startWriting(f, mode) {
  let dependency = null;
  for (const section of mode === 'read_first' ? ['reading', 'listening'] : ['listening', 'reading']) {
    const start = op(f, section, 'start', { dependency });
    assert.equal((await submit(f, start)).receipt?.status, 'accepted');
    const seal = op(f, section, 'seal', { dependency, startedAt: start.payload.startedAt });
    assert.equal((await submit(f, seal)).receipt?.status, 'accepted');
    dependency = seal.operationId;
  }
  const start = op(f, 'writing', 'start', { dependency });
  assert.equal((await submit(f, start)).receipt?.status, 'accepted');
  return { dependency, startedAt: start.payload.startedAt };
}

for (const mode of ['read_first', 'lis_first']) {
  test('Term 2 K56 retains stale Writing and accepts a valid seal once with a full hold store and lost ACK · ' + mode, async t => {
    let dropped, logFailure = false;
    const observations = [];
    const f = await setup(t, mode, {
      record(...args) {
        if (logFailure) throw Error('Isolated log sink unavailable');
        observations.push(args);
      },
      dropResponse: (body, response) => body?.operationId === dropped && response.receipt?.status === 'accepted'
    });
    const writing = await startWriting(f, mode);
    const draft = op(f, 'writing', 'draft', { ...writing, revision: 2, task1: 'Newer native draft.' });
    assert.equal((await submit(f, draft)).receipt?.status, 'accepted');
    const stale = op(f, 'writing', 'seal', { ...writing, revision: 1, task1: 'A sealed answer — không trùng.\nLine 2.' });
    const rejected = await submit(f, stale);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.error, 'OFFLINE_REVISION_STALE');
    assert.ok(rejected.held?.payloadHash);
    assert.deepEqual(await status(f, stale), { status: 200, ok: true, persisted: false, receipt: null, held: rejected.held });
    assert.equal((await f.request('/offline/status', { ...f.scope, operationId: stale.operationId }, 'bad')).status, 403);
    const collision = { ...stale, payload: { ...stale.payload, task1: 'Different text' } };
    assert.equal((await submit(f, collision)).error, 'OPERATION_CONFLICT');
    assert.equal((await submit(f, { ...stale, operationId: randomUUID(), generation: 1 })).status, 403);
    const { rows: [row] } = await f.db.query(`SELECT
      (SELECT payload->'payload'->>'task1' FROM assessment.term2_submission_hold WHERE operation_id=$1) AS essay,
      (SELECT count(*)::int FROM assessment.term2_offline_operation WHERE operation_id=$1) AS receipts,
      (SELECT count(*)::int FROM assessment.term_test_writing_grading_job) AS jobs`, [stale.operationId]);
    assert.deepEqual(row, { essay: stale.payload.task1, receipts: 0, jobs: 0 });
    assert.ok(observations.some(([name,,,data]) => name === 'offline_submission_held' &&
      data.operationId === stale.operationId && data.task1Length === stale.payload.task1.length));
    assert.ok(!JSON.stringify(observations).includes(stale.payload.task1));
    await f.db.query('UPDATE assessment.term2_offline_run SET submission_hold_limit=1 WHERE attempt_id=$1',
      [f.scope.attemptToken]);
    f.advance(Date.parse(writing.startedAt) + f.timing.writingDurationMinutes * 60000 - 500 - f.clock);
    const valid = op(f, 'writing', 'seal', { ...writing, revision: 3, task1: 'Valid final Writing Task 1.' });
    assert.equal((await f.request('/offline/hold', valid)).error, 'OFFLINE_HOLD_FULL');
    dropped = valid.operationId;
    logFailure = true;
    await assert.rejects(() => submit(f, valid));
    dropped = undefined;
    const read = await status(f, valid);
    assert.equal(read.receipt?.status, 'accepted');
    assert.equal(read.held, undefined);
    assert.deepEqual((await submit(f, valid)).receipt, read.receipt);
    const { rows: [after] } = await f.db.query(`SELECT
      (SELECT writing_task_1 FROM assessment.term_test_attempt WHERE id=$1) AS essay,
      (SELECT count(*)::int FROM assessment.term2_offline_operation WHERE operation_id=$2) AS receipts,
      (SELECT count(*)::int FROM assessment.term_test_writing_grading_job WHERE job_type='dispatch') AS jobs,
      (SELECT count(*)::int FROM assessment.term2_submission_hold WHERE operation_id=$2 AND payload IS NOT NULL) AS holds`,
    [f.scope.attemptToken, valid.operationId]);
    assert.deepEqual(after, { essay: valid.payload.task1, receipts: 1, jobs: 1, holds: 0 });
  });
}

test('Term 2 keeps only an expiring copy when an opted-in seal is truly late', async t => {
  const f = await setup(t, 'read_first');
  const writing = await startWriting(f, 'read_first');
  f.advance(f.timing.writingDurationMinutes * 60000 + 3000);
  const late = op(f, 'writing', 'seal', { ...writing, revision: 1, task1: 'Actually late Writing.' });
  const review = await submit(f, late);
  assert.equal(review.receipt?.status, 'review_required');
  assert.equal(review.receipt?.reason, 'TIME_REVIEW_REQUIRED');
  assert.ok(review.held?.payloadHash);
  assert.deepEqual((await status(f, late)).held, review.held);
  const { rows: [row] } = await f.db.query(`SELECT
    (SELECT payload FROM assessment.term2_offline_operation WHERE operation_id=$1) AS operation,
    (SELECT payload->'payload'->>'task1' FROM assessment.term2_submission_hold WHERE operation_id=$1) AS held,
    (SELECT count(*)::int FROM assessment.term_test_writing_grading_job) AS jobs`, [late.operationId]);
  assert.deepEqual(row, { operation: {}, held: late.payload.task1, jobs: 0 });
});

test('Term 2 keeps old review and blank-writing behavior for a run without opt-in', async t => {
  const before = process.env.K56_TERM2_HOLD_CLASSES;
  process.env.K56_TERM2_HOLD_CLASSES = '';
  let f;
  try { f = await setup(t, 'lis_first'); } finally { process.env.K56_TERM2_HOLD_CLASSES = before; }
  const writing = await startWriting(f, 'lis_first');
  const noOrder = op(f, 'writing', 'seal', { ...writing, dependency: randomUUID(), task1: 'Hold is off.' });
  assert.equal((await f.request('/offline/hold', noOrder)).status, 403);
  const oldReview = op(f, 'writing', 'seal', { ...writing, timeValid: false, task1: 'Legacy review payload.' });
  const reviewed = await submit(f, oldReview);
  assert.equal(reviewed.receipt?.status, 'review_required');
  assert.equal(reviewed.held, undefined);
  assert.deepEqual((await status(f, oldReview)).receipt, reviewed.receipt);
  const { rows: [legacy] } = await f.db.query(
    'SELECT payload FROM assessment.term2_offline_operation WHERE operation_id=$1', [oldReview.operationId]);
  assert.deepEqual(legacy.payload, oldReview);
  const blank = op(f, 'writing', 'seal', { ...writing, task1: ' \n\t' });
  const accepted = await submit(f, blank);
  assert.equal(accepted.receipt?.status, 'accepted');
  assert.deepEqual((await status(f, blank)).receipt, accepted.receipt);
  const { rows: [row] } = await f.db.query(`SELECT
    (SELECT writing_score::float FROM assessment.term_test_writing_grading_final LIMIT 1) AS score,
    (SELECT count(*)::int FROM assessment.term_test_writing_grading_job) AS jobs,
    (SELECT count(*)::int FROM assessment.term2_submission_hold) AS holds`);
  assert.deepEqual(row, { score: 0, jobs: 0, holds: 0 });
});
