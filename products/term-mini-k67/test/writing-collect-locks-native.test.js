import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createTermTestWritingGradingService } from '../src/term-test-writing-grading.js';
import { createNativeOrderFixture } from './helpers/native-exam-order-fixture.js';

const nativeOptions = { skip: !process.env.K67_ORDER_NATIVE_URL, timeout: 45_000 };
const workerId = 'native-writing-collector';

async function seedAttempt(db, studentId, slug = 'term-test-2') {
  const { rows: [row] } = await db.query(`INSERT INTO assessment.term_test_attempt
    (client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
    erp_student_contact_id,student_name_snapshot,listening_answers,listening_result,listening_submitted_at,
    reading_answers,reading_result,reading_submitted_at,completed_at,combined_result,
    writing_task_1,writing_task_2,writing_started_at,writing_updated_at,writing_submitted_at,exam_mode,exam_delivery)
    VALUES ($1,$2,1,1293,'IC2304',$3,'Synthetic learner','{}','{}',now(),
    '{}','{}',now(),now(),'{}','Synthetic Task 1','Synthetic Task 2',now(),now(),now(),'lis_first','cbt')
    RETURNING id`, [randomUUID(), slug, studentId]);
  return row.id;
}

function taskResult(taskNumber) {
  return { taskScore: 6, criteria: [taskNumber === 1 ? 'TA' : 'TR', 'CC', 'LR', 'GRA']
    .map(code => ({ code, bandScore: 6, feedback: 'Synthetic feedback' })) };
}

async function collectJobs(db, service, attempts, slug = 'term-test-2') {
  const taskNumbers = slug === 'term-test-1' ? [2] : [1, 2];
  for (const attemptToken of attempts) {
    await service.ensureSubmission({ attemptToken, testSlug: slug,
      taskDefinitions: taskNumbers.map(n => ({ id: `task${n}`, prompt: 'Synthetic writing prompt' })) });
  }
  await db.query(`INSERT INTO assessment.term_test_writing_grading_job
    (run_id,job_type,idempotency_key,status,worker_id,leased_at,lease_until)
    SELECT id,'collect',run_key||':collect','processing',$1,now(),now()+interval '10 minutes'
    FROM assessment.term_test_writing_grading_run WHERE attempt_id=ANY($2::uuid[])`, [workerId, attempts]);
  const { rows } = await db.query(`SELECT job.id,run.run_key,run.attempt_id,run.task_number
    FROM assessment.term_test_writing_grading_job AS job
    JOIN assessment.term_test_writing_grading_run AS run ON run.id=job.run_id
    WHERE job.job_type='collect' AND run.attempt_id=ANY($1::uuid[]) ORDER BY run.task_number`, [attempts]);
  return rows.map(row => ({ attemptId: row.attempt_id, taskNumber: row.task_number,
    input: { jobId: row.id, runKey: row.run_key, workerId, result: taskResult(row.task_number) } }));
}

async function waitUntilBlocked(db, backend, blocker) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows: [row] } = await db.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [backend(), blocker]);
    if (row.blocked) return;
    await delay(20);
  }
  assert.fail('Duplicate Task 1 callback did not wait for Task 2');
}

async function nativeFixture(t) {
  const { db, pool } = await createNativeOrderFixture({ examOrder: true });
  t.after(() => db.close());
  for (const slug of ['term-test-1', 'term-test-2']) {
    await db.query(`INSERT INTO assessment.test_definition
      (slug,title,version,listening_definition,reading_definition,is_active)
      SELECT $1,$1,1,listening_definition,reading_definition,true
      FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`, [slug]);
  }
  return { db, pool };
}

test('native: Task 2 can publish the final row while the duplicate Task 1 callback waits', nativeOptions, async t => {
  const { db, pool } = await nativeFixture(t);
  const delivered = [];
  const syncErpGrades = async payload => { delivered.push(payload); return { status: 'synced' }; };
  const service = createTermTestWritingGradingService({ pool, syncErpGrades });
  const attemptId = await seedAttempt(db, 900001);
  const [first, second] = await collectJobs(db, service, [attemptId]);
  assert.equal((await service.completeResult(first.input)).status, 'accepted');

  const enteredFinal = Promise.withResolvers();
  const resumeFinal = Promise.withResolvers();
  let duplicateBackend;
  let coordinate = true;
  const gatedService = createTermTestWritingGradingService({ syncErpGrades, pool: {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (sql, values) => {
        if (values?.includes(first.input.jobId)) duplicateBackend = client.processID;
        if (coordinate && sql.includes('SELECT id::text, task_number, task_score, status')) {
          coordinate = false;
          enteredFinal.resolve(client.processID);
          await resumeFinal.promise;
        }
        return client.query(sql, values);
      } };
    },
  } });
  const final = gatedService.completeResult(second.input);
  let duplicate;
  // Keep both rejections observable before releasing the barrier.
  const finalOut = Promise.allSettled([final]);
  try {
    const blocker = await Promise.race([enteredFinal.promise, final]);
    assert.equal(typeof blocker, 'number');
    duplicate = Promise.allSettled([gatedService.completeResult(first.input)]);
    await waitUntilBlocked(db, () => duplicateBackend || 0, blocker);
  } finally {
    resumeFinal.resolve();
    await finalOut;
    await duplicate;
  }
  const outcomes = [...await finalOut, ...await duplicate];
  const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(({ reason }) => ({
    code: reason.code, message: reason.message, detail: reason.detail, context: reason.where,
  }));
  assert.deepEqual(failures, []);
  assert.deepEqual(outcomes.map(outcome => outcome.value.status), ['accepted', 'duplicate']);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].attemptToken, attemptId);
  assert.equal(delivered[0].grades.writing, 6);
});

function fakePortal({ dropAck = false } = {}) {
  const effective = new Map();
  let writes = 0;
  let attempts = 0;
  const syncErpGrades = async payload => {
    attempts++;
    const key = `${payload.testSlug}:${payload.classId}:${payload.studentId}:writing`;
    if (effective.has(key)) {
      assert.deepEqual(payload, effective.get(key));
    } else {
      effective.set(key, payload);
      writes++;
      if (dropAck) throw new Error('Lost acknowledgement after recording the score');
    }
    return { status: 'synced' };
  };
  return { effective, syncErpGrades, counts: () => ({ writes, attempts }) };
}

test('native: Writing result survives a lost Portal acknowledgement and an expired lease', nativeOptions, async t => {
  const { db, pool } = await nativeFixture(t);
  const portal = fakePortal({ dropAck: true });
  const service = createTermTestWritingGradingService({ pool, syncErpGrades: portal.syncErpGrades });
  const attemptId = await seedAttempt(db, 900001);
  const [first, second] = await collectJobs(db, service, [attemptId]);
  await service.completeResult(second.input);
  await assert.rejects(service.completeResult(first.input), { code: 'WRITING_PORTAL_SYNC_FAILED' });
  await service.failJob({ jobId: first.input.jobId, workerId, errorCode: 'WRITING_PORTAL_SYNC_FAILED' });
  await db.query('UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now() WHERE id=$1', [first.input.jobId]);
  const [reclaimed] = await service.claimJobs({ workerId: 'retry-collector', limit: 1 });
  assert.equal(reclaimed.jobId, first.input.jobId);
  await db.query(`UPDATE assessment.term_test_writing_grading_job
    SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1`, [first.input.jobId]);
  await assert.rejects(service.completeResult({ ...first.input, workerId: 'retry-collector' }),
    { code: 'WRITING_GRADING_JOB_LEASE_MISMATCH' });
  const [fresh] = await service.claimJobs({ workerId: 'fresh-collector', limit: 1 });
  assert.equal(fresh.jobId, first.input.jobId);
  const retry = await service.completeResult({ ...first.input, workerId: 'fresh-collector', result: { taskScore: 8 } });
  assert.equal(retry.grading.writingScore, 6);
  assert.equal(retry.portalSyncStatus, 'synced');
  assert.deepEqual(portal.counts(), { writes: 1, attempts: 2 });
  assert.equal(portal.effective.get('term-test-2:1293:900001:writing').attemptToken, attemptId);
});

for (const wave of [1, 2, 3]) {
  test(`native: Writing wave ${wave} completes 17 essays with duplicate callbacks and one score per essay`, nativeOptions, async t => {
    const { db, pool } = await nativeFixture(t);
    const portal = fakePortal();
    const service = createTermTestWritingGradingService({ pool, syncErpGrades: portal.syncErpGrades });
    const attemptIds = [];
    for (let index = 0; index < 17; index++) attemptIds.push(await seedAttempt(db, 900001 + index));
    const jobs = await collectJobs(db, service, attemptIds);
    const callbacks = attemptIds.flatMap((attemptId, index) => {
      const pair = jobs.filter(job => job.attemptId === attemptId);
      if (wave === 2 || (wave === 3 && index % 2)) pair.reverse();
      return [...pair, ...pair].map(job => job.input);
    });
    const started = performance.now();
    const outcomes = await Promise.allSettled(callbacks.map(input => service.completeResult(input)));
    const elapsedMs = Math.round(performance.now() - started);
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(({ reason }) => reason.code ?? reason.message);
    assert.deepEqual(failures, []);
    assert.equal(outcomes.filter(outcome => outcome.value.status === 'accepted').length, 34);
    assert.equal(outcomes.filter(outcome => outcome.value.status === 'duplicate').length, 34);
    const { rows: [counts] } = await db.query(`SELECT
      (SELECT count(*)::int FROM assessment.term_test_writing_grading_run WHERE status='complete') AS tasks,
      (SELECT count(*)::int FROM assessment.term_test_writing_grading_final WHERE status='ready') AS finals`);
    assert.deepEqual(counts, { tasks: 34, finals: 17 });
    assert.equal(portal.counts().writes, 17);
    for (const [index, attemptId] of attemptIds.entries()) {
      const payload = portal.effective.get(`term-test-2:1293:${900001 + index}:writing`);
      assert.equal(payload.attemptToken, attemptId);
      assert.equal(payload.grades.writing, 6);
    }
    t.diagnostic(JSON.stringify({ wave, elapsedMs, ...counts, deadlocks: 0, portal: portal.counts() }));
  });
}
