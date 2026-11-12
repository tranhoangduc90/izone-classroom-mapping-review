import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

process.env.K56_ONLINE_FIXTURE_IMPORT_ONLY = '1';
const { fixture } = await import('./term-online-submission.test.mjs');

export async function writingFixture(t, term, mode, options) {
  const f = await fixture(t, term, mode, { ...options, writing: true });
  const activeTask = term === 1 ? 'task2' : 'task1';
  const activeColumn = term === 1 ? 'writing_task_2' : 'writing_task_1';
  await f.db.query(`UPDATE assessment.term_test_attempt SET
    completed_at=now(), listening_submitted_at=now(), reading_submitted_at=now(),
    writing_started_at=now(), writing_deadline_at=now()+interval '45 minutes' WHERE id=$1`, [f.a]);
  const requestBody = (essay, changes = {}) => ({
    attemptToken: f.a, baseRevision: 0, task1: '', task2: '', [activeTask]: essay, outline: 'Synthetic outline',
    recovery: { ...f.scope, operationId: randomUUID(), capturedAt: new Date().toISOString(), automatic: false },
    ...changes
  });
  const state = async body => (await f.db.query(`SELECT writing_submitted_at, ` + activeColumn + ` AS essay,
    (SELECT count(*)::int FROM assessment.term_test_writing_grading_job) AS jobs,
    (SELECT task_number FROM assessment.term_test_writing_grading_run) AS task,
    (SELECT essay_text FROM assessment.term_test_writing_grading_run) AS graded,
    (SELECT payload FROM assessment.term_online_submission_hold WHERE operation_id=$2) AS held,
    (SELECT count(*)::int FROM assessment.term_online_submission_hold WHERE receipt IS NOT NULL) AS receipts
    FROM assessment.term_test_attempt WHERE id=$1`, [f.a, body.recovery.operationId])).rows[0];
  const submit = body => f.request('writing/finalize', body);
  return { ...f, requestBody, state, submit, activeTask, activeColumn };
}

if (!process.env.K56_WRITING_FIXTURE_IMPORT_ONLY) for (const term of [1, 2]) {
  test('Term ' + term + ' Writing: wrong scope, atomic rollback, ACK loss, replay and exact job', async t => {
    const f = await writingFixture(t, term, term === 1 ? 'lis_first' : 'read_first');
    assert.equal((await f.prepare()).submissionRecoveryVersion, 1);
    const essay = 'Fixture · Text does not enter Journal. ' + '字'.repeat(100);
    const body = f.requestBody(essay);
    const stale = { ...body, recovery: { ...body.recovery, generation: 9 } };
    assert.equal((await f.submit(stale)).error, 'SUBMISSION_RECOVERY_SCOPE');
    assert.equal((await f.state(body)).held, null);
    f.fault.receipt = true;
    const fault = await f.submit(body);
    assert.equal(fault.status, 503, JSON.stringify(fault));
    assert.equal(fault.error, 'OFFLINE_SUBMISSION_UNAVAILABLE');
    assert.ok(fault.held);
    let native = await f.state(body);
    assert.equal(native.held.writing[f.activeTask], essay);
    assert.equal(native.jobs, 0);
    assert.equal(native.writing_submitted_at, null);
    f.fault.receipt = false;
    f.fault.drop = body.recovery.operationId;
    await assert.rejects(f.submit(body), /fetch failed/i);
    const checked = await f.status('writing', body);
    assert.ok(checked.receipt.receiptId);
    assert.equal(checked.response.writing[f.activeTask], essay);
    assert.equal((await f.status('writing', body, { studentRef: randomUUID() })).status, 403);
    assert.equal((await f.submit(body)).receipt.receiptId, checked.receipt.receiptId);
    assert.equal((await f.submit({ ...body, [f.activeTask]: 'different' })).error, 'OPERATION_CONFLICT');
    const otherOperation = f.requestBody(essay);
    assert.equal((await f.submit(otherOperation)).error, 'WRITING_ALREADY_RECEIVED');
    assert.equal((await f.status('writing', otherOperation)).recoveryReview, 'WRITING_ALREADY_RECEIVED');
    native = await f.state(body);
    assert.equal(native.held, null);
    assert.equal(native.essay, essay);
    assert.equal(native.graded, essay);
    assert.equal(native.task, term === 1 ? 2 : 1);
    assert.equal(native.jobs, 1);
    assert.equal(native.receipts, 1);
    const queued = f.observations.find(([name]) => name === 'job_queued')[3];
    assert.equal(queued.receiptId, checked.receipt.receiptId);
    assert.equal(queued.operationId, body.recovery.operationId);
    assert.ok(queued.jobId);
    assert.ok(!JSON.stringify(f.observations).includes(essay));
  });

  test('Term ' + term + ' Writing: revision conflict held without grading; late canonical stays distinct', async t => {
    const f = await writingFixture(t, term, 'lis_first');
    await f.prepare();
    const previous = 'Earlier saved canonical';
    const incoming = f.requestBody('Different text sealed in browser');
    await f.db.query('UPDATE assessment.term_test_attempt SET ' + f.activeColumn
      + '=$2, writing_draft_revision=1 WHERE id=$1', [f.a, previous]);
    assert.equal((await f.submit(incoming)).error, 'WRITING_REVISION_CONFLICT');
    assert.equal((await f.state(incoming)).jobs, 0);
    await f.db.query("UPDATE assessment.term_test_attempt SET writing_deadline_at=now()-interval '5 seconds' WHERE id=$1", [f.a]);
    const late = await f.submit(incoming);
    assert.equal(late.error, 'WRITING_DEADLINE_EXPIRED');
    assert.ok(late.held);
    const status = await f.status('writing', incoming);
    assert.equal(status.receipt, null);
    assert.equal(status.recoveryReview, 'SUBMISSION_DIFFERENT_CANONICAL');
    const native = await f.state(incoming);
    assert.equal(native.held.writing[f.activeTask], incoming[f.activeTask]);
    assert.equal(native.essay, previous);
    assert.equal(native.graded, previous);
    assert.equal(native.receipts, 0);
    assert.equal(native.jobs, 1);
  });

  test('Term ' + term + ' Writing: blank commits score zero and no AI when logger is down', async t => {
    const f = await writingFixture(t, term, 'read_first');
    await f.prepare();
    f.fault.logger = true;
    const body = f.requestBody('\u200b \r\n');
    const result = await f.submit(body);
    assert.equal(result.writing?.grading?.writingScore, 0, JSON.stringify(result));
    assert.ok(result.receipt);
    const row = (await f.db.query('SELECT *,id::text AS attempt_token FROM assessment.term_test_attempt WHERE id=$1', [f.a])).rows[0];
    assert.equal((await f.rerunGrading(row)).writingScore, 0);
    assert.equal((await f.state(body)).jobs, 0);
    assert.deepEqual((await f.db.query("SELECT field,grade::float FROM assessment.k56_portal_field_dispatch WHERE field='writing'")).rows,
      [{ field: 'writing', grade: 0 }]);
  });

  test('Term ' + term + ' online Writing receives valid work when the temporary store is full', async t => {
    const f = await writingFixture(t, term, 'read_first');
    await f.prepare();
    await f.db.query('UPDATE assessment.term_test_attempt SET submission_hold_limit=1 WHERE id=$1', [f.a]);
    await f.db.query(`INSERT INTO assessment.term_online_submission_hold
      (attempt_id,generation,operation_id,section,payload_hash,payload,held_at,expires_at)
      VALUES($1,0,$2,'reading',$3,'{}',now(),now()+interval '1 hour')`, [f.a, randomUUID(), 'a'.repeat(64)]);
    const essay = 'Writing fixture submitted while the temporary store is full.';
    const body = f.requestBody(essay);
    f.fault.drop = body.recovery.operationId;
    await assert.rejects(f.submit(body), /fetch failed/i);
    const status = await f.status('writing', body);
    assert.ok(status.receipt?.receiptId);
    assert.equal((await f.submit(body)).receipt.receiptId, status.receipt.receiptId);
    assert.equal((await f.submit({ ...body, [f.activeTask]: 'Different text' })).error, 'OPERATION_CONFLICT');
    const native = await f.state(body);
    assert.equal(native.essay, essay);
    assert.equal(native.graded, essay);
    assert.equal(native.held, null);
    assert.equal(native.receipts, 1);
    assert.equal(native.jobs, 1);
  });
}
