import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  buildTermTestWritingImageToken,
  calculateTermTestWritingOverall,
  calculateWritingTaskScore,
  createTermTestWritingGradingService,
  decodeTermTestWritingImageDataUrl,
  verifyTermTestWritingImageToken
} from '../src/term-test-writing-grading.js';

const taskDefinitions = [
  { id: 'task1', prompt: 'Đề Task 1', image: 'https://example.test/chart.png' },
  { id: 'task2', prompt: 'Đề Task 2' }
];

function criteria(taskNumber, scores) {
  const codes = taskNumber === 1 ? ['TA', 'CC', 'LR', 'GRA'] : ['TR', 'CC', 'LR', 'GRA'];
  return codes.map((code, index) => ({
    code,
    name: code,
    bandScore: scores[index],
    feedback: `Nhận xét ${code}`,
    components: [{
      code: `${code.toLowerCase()}_detail`,
      label: `Khía cạnh ${code}`,
      summary: `Tóm tắt ${code}`,
      feedback: `Chi tiết ${code}`
    }]
  }));
}

async function makeDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA assessment;
    CREATE TABLE assessment.term_test_attempt (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_slug TEXT NOT NULL,
      erp_course_class_id BIGINT,
      erp_student_contact_id BIGINT,
      class_name_snapshot TEXT,
      student_name_snapshot TEXT,
      listening_result JSONB,
      combined_result JSONB,
      completed_at TIMESTAMPTZ,
      writing_submitted_at TIMESTAMPTZ
    );
  `);
  const migration = await readFile(
    new URL('../../docs/migrations/2026-08-19-term-test-writing-grading.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migration);
  await database.exec(migration);
  return database;
}

test('công thức Task và Writing tổng giữ đúng cách làm tròn của khóa 67', () => {
  assert.equal(calculateWritingTaskScore(criteria(1, [6.5, 7, 6.5, 7])), 6.5);
  assert.equal(calculateWritingTaskScore(criteria(2, [7, 7, 6.5, 7])), 6.5);
  assert.equal(calculateTermTestWritingOverall(6.5, 7), 7);
});

test('liên kết ảnh Task 1 dùng chữ ký chống sửa và chỉ nhận ảnh an toàn', () => {
  const secret = 's'.repeat(32);
  const jobId = '00000000-0000-4000-8000-000000000299';
  const token = buildTermTestWritingImageToken(secret, jobId);
  assert.equal(token.length, 64);
  assert.equal(verifyTermTestWritingImageToken(secret, jobId, token), true);
  assert.equal(verifyTermTestWritingImageToken(secret, `${jobId}x`, token), false);
  assert.equal(verifyTermTestWritingImageToken(secret, jobId, `${token.slice(0, -1)}0`), false);

  const image = decodeTermTestWritingImageDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.body.toString('base64'), 'iVBORw0KGgo=');
  assert.throws(
    () => decodeTermTestWritingImageDataUrl('data:text/html;base64,PHNjcmlwdD4='),
    error => error.code === 'WRITING_GRADING_IMAGE_INVALID'
  );
  assert.throws(
    () => decodeTermTestWritingImageDataUrl(`data:image/png;base64,${'A'.repeat((600 * 1024 * 4 / 3) + 8)}`),
    error => error.code === 'WRITING_GRADING_IMAGE_INVALID'
  );
});

test('chỉ mở điểm sau khi đủ hai Task và không tạo việc trùng', async () => {
  const database = await makeDatabase();
  const attemptToken = '00000000-0000-4000-8000-000000000201';
  const portalPayloads = [];
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, erp_course_class_id, erp_student_contact_id,
    class_name_snapshot, student_name_snapshot, combined_result,
    completed_at, writing_submitted_at
  ) VALUES ($1::uuid, 'term-test-2', 2146, 9001, 'IC2146', 'Học viên thử nghiệm',
    $2::jsonb, now(), now());`, [attemptToken, JSON.stringify({
    listening: { band: 6 },
    reading: { band: 6.5 }
  })]);
  const service = createTermTestWritingGradingService({
    pool: database,
    syncErpGrades: async payload => {
      portalPayloads.push(payload);
      return { status: 'synced', attemptToken: payload.attemptToken };
    }
  });

  const first = await service.ensureSubmission({
    attemptToken,
    testSlug: 'term-test-2',
    task1: 'Bài Task 1',
    task2: 'Bài Task 2',
    taskDefinitions
  });
  assert.equal(first.ready, false);
  await service.ensureSubmission({
    attemptToken,
    testSlug: 'term-test-2',
    task1: 'Nội dung gửi lại không được ghi đè',
    task2: 'Nội dung gửi lại không được ghi đè',
    taskDefinitions
  });
  const runCount = await database.query('SELECT count(*)::int AS count FROM assessment.term_test_writing_grading_run;');
  const jobCount = await database.query('SELECT count(*)::int AS count FROM assessment.term_test_writing_grading_job;');
  assert.equal(runCount.rows[0].count, 2);
  assert.equal(jobCount.rows[0].count, 2);

  const dispatchJobs = await service.claimJobs({ workerId: 'test-worker', limit: 4 });
  assert.equal(dispatchJobs.length, 2);
  assert.equal((await service.claimJobs({ workerId: 'other-worker', limit: 4 })).length, 0);
  for (const job of dispatchJobs) {
    await service.completeDispatch({
      jobId: job.jobId,
      workerId: 'test-worker',
      sourceRecordId: `lark-task-${job.taskNumber}`
    });
  }
  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at = now()
    WHERE job_type = 'collect';`);
  const collectJobs = await service.claimJobs({ workerId: 'collector-worker', limit: 4 });
  assert.equal(collectJobs.length, 2);

  const task1Job = collectJobs.find(job => job.taskNumber === 1);
  const task2Job = collectJobs.find(job => job.taskNumber === 2);
  const task1Criteria = criteria(1, [6.5, 7, 6.5, 7]);
  const task2Criteria = criteria(2, [7, 7, 7, 7]);
  const task1Completed = await service.completeResult({
    jobId: task1Job.jobId,
    workerId: 'collector-worker',
    runKey: task1Job.runKey,
    sourceRecordId: 'lark-task-1',
    result: { taskScore: 6.5, criteria: task1Criteria, report: 'Báo cáo Task 1' }
  });
  assert.equal(task1Completed.grading.ready, false);
  assert.equal(task1Completed.grading.task1Score, null);

  const task2Completed = await service.completeResult({
    jobId: task2Job.jobId,
    workerId: 'collector-worker',
    runKey: task2Job.runKey,
    sourceRecordId: 'lark-task-2',
    result: { taskScore: 7, criteria: task2Criteria, report: 'Báo cáo Task 2' }
  });
  assert.equal(task2Completed.grading.ready, true);
  assert.equal(task2Completed.grading.task1Score, 6.5);
  assert.equal(task2Completed.grading.task2Score, 7);
  assert.equal(task2Completed.grading.writingScore, 7);
  assert.equal(task2Completed.portalSyncStatus, 'synced');
  assert.deepEqual(portalPayloads.map(payload => payload.grades), [{
    listening: 6,
    reading: 6.5,
    writing: 7
  }]);
  assert.equal(task2Completed.grading.tasks.length, 2);
  assert.equal(task2Completed.grading.tasks[0].criteria[0].components[0].feedback, 'Chi tiết TA');

  const storedEssay = await database.query(`SELECT essay_text
    FROM assessment.term_test_writing_grading_run
    WHERE attempt_id = $1::uuid AND task_number = 1;`, [attemptToken]);
  assert.equal(storedEssay.rows[0].essay_text, 'Bài Task 1');
  await database.close();
});

test('Term Test 1 chỉ có Task 2 vẫn chấm xong, hiện điểm và đồng bộ Portal', async () => {
  const database = await makeDatabase();
  const attemptToken = '00000000-0000-4000-8000-000000000211';
  const portalPayloads = [];
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, erp_course_class_id, erp_student_contact_id,
    class_name_snapshot, student_name_snapshot, combined_result,
    completed_at, writing_submitted_at
  ) VALUES ($1::uuid, 'term-test-1', 2146, 9011, 'IC2146', 'Học viên Task 2',
    $2::jsonb, now(), now());`, [attemptToken, JSON.stringify({
    listening: { band: 6 },
    reading: { band: 6.5 }
  })]);
  const service = createTermTestWritingGradingService({
    pool: database,
    syncErpGrades: async payload => {
      portalPayloads.push(payload);
      return { status: 'synced' };
    }
  });

  const pending = await service.ensureSubmission({
    attemptToken,
    testSlug: 'term-test-1',
    task1: '',
    task2: 'Bài Task 2 của Term Test 1',
    taskDefinitions: [{ id: 'task2', prompt: 'Đề Task 2 Term Test 1' }]
  });
  assert.equal(pending.ready, false);
  assert.deepEqual(pending.taskStates, { task2: 'queued' });

  const [dispatchJob] = await service.claimJobs({ workerId: 'term-1-dispatch', limit: 2 });
  assert.equal(dispatchJob.taskNumber, 2);
  await service.completeDispatch({
    jobId: dispatchJob.jobId,
    workerId: 'term-1-dispatch',
    sourceRecordId: 'lark-term-1-task-2'
  });
  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at = now()
    WHERE job_type = 'collect';`);
  const [collectJob] = await service.claimJobs({ workerId: 'term-1-collect', limit: 2 });
  const completed = await service.completeResult({
    jobId: collectJob.jobId,
    workerId: 'term-1-collect',
    runKey: collectJob.runKey,
    sourceRecordId: 'lark-term-1-task-2',
    result: {
      taskScore: 6.5,
      criteria: criteria(2, [6.5, 6.5, 6.5, 6.5]),
      report: 'Báo cáo Task 2'
    }
  });
  assert.equal(completed.grading.ready, true);
  assert.equal(completed.grading.task1Score, null);
  assert.equal(completed.grading.task2Score, 6.5);
  assert.equal(completed.grading.writingScore, 6.5);
  assert.deepEqual(completed.grading.taskStates, { task2: 'complete' });
  assert.deepEqual(portalPayloads[0].grades, { listening: 6, reading: 6.5, writing: 6.5 });
  await database.close();
});

test('Term Test 2 K56 chỉ có Task 1 vẫn hoàn tất đúng lượt, không đòi Task 2', async () => {
  const database = await makeDatabase();
  const attemptToken = '00000000-0000-4000-8000-000000000212';
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, erp_course_class_id, erp_student_contact_id,
    class_name_snapshot, student_name_snapshot, completed_at, writing_submitted_at
  ) VALUES ($1::uuid, 'term-test-2-k56', 1252, 9012, 'IC2264', 'Học viên thử nghiệm', now(), now());`, [attemptToken]);
  const service = createTermTestWritingGradingService({ pool: database });
  const submission = {
    attemptToken,
    testSlug: 'term-test-2-k56',
    task1: 'Bài Task 1 K56',
    task2: '',
    taskDefinitions: [{ id: 'task1', prompt: 'Đề Task 1 K56' }]
  };
  await service.ensureSubmission(submission);
  await service.ensureSubmission({ ...submission, task1: 'Nội dung gửi lại không được ghi đè' });
  const [dispatch] = await service.claimJobs({ workerId: 'k56-dispatch', limit: 2 });
  assert.equal(dispatch.taskNumber, 1);
  await service.completeDispatch({ jobId: dispatch.jobId, workerId: 'k56-dispatch', sourceRecordId: 'k56-task-1' });
  await database.query(`UPDATE assessment.term_test_writing_grading_job SET next_attempt_at = now() WHERE job_type = 'collect';`);
  const [collect] = await service.claimJobs({ workerId: 'k56-collect', limit: 2 });
  const completed = await service.completeResult({
    jobId: collect.jobId,
    workerId: 'k56-collect',
    runKey: collect.runKey,
    sourceRecordId: 'k56-task-1',
    result: { taskScore: 6.5, criteria: criteria(1, [6.5, 6.5, 6.5, 6.5]), report: 'Báo cáo Task 1' }
  });
  assert.equal(completed.grading.ready, true);
  assert.equal(completed.grading.task1Score, 6.5);
  assert.equal(completed.grading.task2Score, null);
  assert.equal(completed.grading.writingScore, 6.5);
  assert.deepEqual(completed.grading.taskStates, { task1: 'complete' });
  const runs = await database.query(`SELECT count(*)::int AS count, min(essay_text) AS essay FROM assessment.term_test_writing_grading_run;`);
  assert.equal(runs.rows[0].count, 1);
  assert.equal(runs.rows[0].essay, 'Bài Task 1 K56');
  await database.close();
});

test('Mini K56 chấm đoạn văn Task 2 cho hai lớp cùng tên mà không lẫn lượt', async () => {
  const database = await makeDatabase();
  const attempts = [
    { token: '00000000-0000-4000-8000-000000000213', classId: 1252, className: 'IC2264', score: 6.5 },
    { token: '00000000-0000-4000-8000-000000000214', classId: 1253, className: 'IC2265', score: 8 }
  ];
  const service = createTermTestWritingGradingService({ pool: database });
  for (const attempt of attempts) {
    await database.query(`INSERT INTO assessment.term_test_attempt (
      id, test_slug, erp_course_class_id, erp_student_contact_id,
      class_name_snapshot, student_name_snapshot, completed_at, writing_submitted_at
    ) VALUES ($1::uuid, 'mini-test-k56', $2, 9013, $3, 'Học viên cùng tên', now(), now());`, [
      attempt.token, attempt.classId, attempt.className
    ]);
    const pending = await service.ensureSubmission({
      attemptToken: attempt.token,
      testSlug: 'mini-test-k56',
      task1: '',
      task2: `Đoạn văn giả lớp ${attempt.className}`,
      taskDefinitions: [{ id: 'task2', prompt: 'Đề Mini giả, chấm đoạn văn.' }]
    });
    assert.deepEqual(pending.taskStates, { task2: 'queued' });
  }

  const dispatches = await service.claimJobs({ workerId: 'mini-dispatch', limit: 2, testSlug: 'mini-test-k56' });
  assert.equal(dispatches.length, 2);
  assert.notEqual(dispatches[0].runKey, dispatches[1].runKey);
  for (const job of dispatches) {
    assert.equal(job.taskNumber, 2);
    assert.equal(job.testSlug, 'mini-test-k56');
    await service.completeDispatch({ jobId: job.jobId, workerId: 'mini-dispatch' });
  }
  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at = now() WHERE job_type = 'collect';`);
  const collects = await service.claimJobs({ workerId: 'mini-collect', limit: 2, testSlug: 'mini-test-k56' });
  assert.equal(collects.length, 2);
  const first = collects.find(job => job.runKey.includes(attempts[0].token));
  const second = collects.find(job => job.runKey.includes(attempts[1].token));
  assert.ok(first && second);
  await assert.rejects(service.completeResult({
    jobId: first.jobId,
    workerId: 'mini-collect',
    runKey: second.runKey,
    result: { taskScore: 6.5, criteria: criteria(2, [6.5, 6.5, 6.5, 6.5]), report: 'Bài giả' }
  }), error => error.code === 'WRITING_GRADING_JOB_TYPE_MISMATCH');
  for (const [job, score] of [[second, 8], [first, 6.5]]) {
    const completed = await service.completeResult({
      jobId: job.jobId,
      workerId: 'mini-collect',
      runKey: job.runKey,
      result: { taskScore: score, criteria: criteria(2, [score, score, score, score]), report: 'Bài giả' }
    });
    assert.equal(completed.grading.ready, true);
    assert.equal(completed.grading.task1Score, null);
    assert.equal(completed.grading.task2Score, score);
    assert.equal(completed.grading.writingScore, score);
    assert.equal(completed.portalSyncStatus, 'not_applicable');
  }
  for (const attempt of attempts) {
    const status = await service.getStatus(attempt.token);
    assert.equal(status.writingScore, attempt.score);
    assert.equal(status.tasks.length, 1);
    assert.deepEqual(status.taskStates, { task2: 'complete' });
  }
  const stored = await database.query(`SELECT run.run_key, run.essay_text, attempt.class_name_snapshot
    FROM assessment.term_test_writing_grading_run AS run
    JOIN assessment.term_test_attempt AS attempt ON attempt.id = run.attempt_id
    ORDER BY attempt.class_name_snapshot;`);
  assert.equal(stored.rows.length, 2);
  for (const row of stored.rows) {
    assert.ok(row.run_key.includes('mini-test-k56:'));
    assert.equal(row.essay_text, `Đoạn văn giả lớp ${row.class_name_snapshot}`);
  }
  await database.close();
});

test('Portal lỗi tạm thời thì điểm Writing vẫn sẵn sàng và việc ghi điểm được đưa lại vào hàng chờ', async () => {
  const database = await makeDatabase();
  const attemptToken = '00000000-0000-4000-8000-000000000205';
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, erp_course_class_id, erp_student_contact_id,
    class_name_snapshot, student_name_snapshot, combined_result,
    completed_at, writing_submitted_at
  ) VALUES ($1::uuid, 'term-test-2', 2146, 9005, 'IC2146', 'Học viên thử nghiệm',
    $2::jsonb, now(), now());`, [attemptToken, JSON.stringify({
    listening: { band: 6 },
    reading: { band: 6 }
  })]);
  const service = createTermTestWritingGradingService({
    pool: database,
    syncErpGrades: async () => {
      throw new Error('Portal tạm thời không phản hồi.');
    }
  });
  await service.ensureSubmission({
    attemptToken,
    testSlug: 'term-test-2',
    task1: 'Bài Task 1',
    task2: 'Bài Task 2',
    taskDefinitions
  });
  const dispatchJobs = await service.claimJobs({ workerId: 'portal-retry-worker', limit: 4 });
  for (const job of dispatchJobs) {
    await service.completeDispatch({
      jobId: job.jobId,
      workerId: 'portal-retry-worker',
      sourceRecordId: `lark-portal-retry-${job.taskNumber}`
    });
  }
  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at = now()
    WHERE job_type = 'collect';`);
  const collectJobs = await service.claimJobs({ workerId: 'portal-retry-worker', limit: 4 });
  const task1Job = collectJobs.find(job => job.taskNumber === 1);
  const task2Job = collectJobs.find(job => job.taskNumber === 2);
  await service.completeResult({
    jobId: task1Job.jobId,
    workerId: 'portal-retry-worker',
    runKey: task1Job.runKey,
    result: { taskScore: 6, criteria: criteria(1, [6, 6, 6, 6]), report: 'Task 1' }
  });
  await assert.rejects(() => service.completeResult({
    jobId: task2Job.jobId,
    workerId: 'portal-retry-worker',
    runKey: task2Job.runKey,
    result: { taskScore: 6, criteria: criteria(2, [6, 6, 6, 6]), report: 'Task 2' }
  }), error => error.code === 'WRITING_PORTAL_SYNC_FAILED' && error.httpStatus === 503);

  const ready = await service.getStatus(attemptToken);
  assert.equal(ready.ready, true);
  assert.equal(ready.writingScore, 6);
  const beforeRetry = await database.query(`SELECT job.status, run.status AS run_status
    FROM assessment.term_test_writing_grading_job AS job
    JOIN assessment.term_test_writing_grading_run AS run ON run.id = job.run_id
    WHERE job.id = $1::uuid;`, [task2Job.jobId]);
  assert.equal(beforeRetry.rows[0].status, 'processing');
  assert.equal(beforeRetry.rows[0].run_status, 'complete');

  const retry = await service.failJob({
    jobId: task2Job.jobId,
    workerId: 'portal-retry-worker',
    errorCode: 'WRITING_PORTAL_SYNC_FAILED'
  });
  assert.equal(retry.status, 'retry_wait');
  const afterRetry = await database.query(`SELECT status
    FROM assessment.term_test_writing_grading_job
    WHERE id = $1::uuid;`, [task2Job.jobId]);
  assert.equal(afterRetry.rows[0].status, 'retry_wait');
  await database.close();
});

test('việc chưa có kết quả được trả về hàng retry thay vì mất khỏi hệ thống', async () => {
  const database = await makeDatabase();
  const attemptToken = '00000000-0000-4000-8000-000000000202';
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, completed_at, writing_submitted_at
  ) VALUES ($1::uuid, 'term-test-2', now(), now());`, [attemptToken]);
  const service = createTermTestWritingGradingService({ pool: database });
  await service.ensureSubmission({
    attemptToken,
    testSlug: 'term-test-2',
    task1: 'Task 1',
    task2: 'Task 2',
    taskDefinitions
  });
  const [job] = await service.claimJobs({ workerId: 'retry-worker', limit: 1 });
  const failed = await service.failJob({
    jobId: job.jobId,
    workerId: 'retry-worker',
    errorCode: 'LEGACY_GRADING_TEMPORARY_ERROR'
  });
  assert.equal(failed.status, 'retry_wait');
  const stored = await database.query(`SELECT status, attempt_count, last_error_code
    FROM assessment.term_test_writing_grading_job
    WHERE id = $1::uuid;`, [job.jobId]);
  assert.equal(stored.rows[0].status, 'retry_wait');
  assert.equal(stored.rows[0].attempt_count, 1);
  assert.equal(stored.rows[0].last_error_code, 'LEGACY_GRADING_TEMPORARY_ERROR');
  await database.close();
});

test('lease hết hạn được nhận lại và tiến trình cũ không thể chốt nhầm việc', async () => {
  const database = await makeDatabase();
  const attemptToken = '00000000-0000-4000-8000-000000000203';
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, completed_at, writing_submitted_at
  ) VALUES ($1::uuid, 'term-test-2', now(), now());`, [attemptToken]);
  const service = createTermTestWritingGradingService({ pool: database });
  await service.ensureSubmission({
    attemptToken,
    testSlug: 'term-test-2',
    task1: 'Task 1 có hình',
    task2: 'Task 2',
    taskDefinitions: [
      { id: 'task1', prompt: 'Đề Task 1', image: { src: 'data:image/png;base64,QUJD', alt: 'Biểu đồ' } },
      { id: 'task2', prompt: 'Đề Task 2' }
    ]
  });
  const [firstLease] = await service.claimJobs({ workerId: 'worker-old', limit: 1 });
  assert.equal(firstLease.imageUrl, 'data:image/png;base64,QUJD');
  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at = now() + interval '1 hour'
    WHERE id <> $1::uuid AND status = 'queued';`, [firstLease.jobId]);
  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET lease_until = now() - interval '1 second'
    WHERE id = $1::uuid;`, [firstLease.jobId]);
  const [secondLease] = await service.claimJobs({ workerId: 'worker-new', limit: 1 });
  assert.equal(secondLease.jobId, firstLease.jobId);
  assert.equal(secondLease.attemptCount, 2);
  await assert.rejects(() => service.completeDispatch({
    jobId: firstLease.jobId,
    workerId: 'worker-old'
  }), error => error.code === 'WRITING_GRADING_JOB_LEASE_MISMATCH');
  const completed = await service.completeDispatch({
    jobId: secondLease.jobId,
    workerId: 'worker-new',
    sourceRecordId: 'lark-reclaimed'
  });
  assert.equal(completed.status, 'accepted');
  await database.close();
});

test('kết quả sai công thức rollback toàn bộ và quá số lần thử chuyển sang giáo viên kiểm tra', async () => {
  const database = await makeDatabase();
  const attemptToken = '00000000-0000-4000-8000-000000000204';
  await database.query(`INSERT INTO assessment.term_test_attempt (
    id, test_slug, completed_at, writing_submitted_at
  ) VALUES ($1::uuid, 'term-test-2', now(), now());`, [attemptToken]);
  const service = createTermTestWritingGradingService({ pool: database });
  await service.ensureSubmission({
    attemptToken,
    testSlug: 'term-test-2',
    task1: 'Task 1',
    task2: 'Task 2',
    taskDefinitions
  });
  const dispatchJobs = await service.claimJobs({ workerId: 'dispatch-invalid', limit: 2 });
  for (const job of dispatchJobs) {
    await service.completeDispatch({ jobId: job.jobId, workerId: 'dispatch-invalid' });
  }
  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET next_attempt_at = now()
    WHERE job_type = 'collect' AND run_id = (
      SELECT id FROM assessment.term_test_writing_grading_run
      WHERE attempt_id = $1::uuid AND task_number = 1
    );`, [attemptToken]);
  const [collectJob] = await service.claimJobs({ workerId: 'collector-invalid', limit: 1 });
  await assert.rejects(() => service.completeResult({
    jobId: collectJob.jobId,
    workerId: 'collector-invalid',
    runKey: collectJob.runKey,
    result: {
      taskScore: 7,
      criteria: criteria(1, [6.5, 7, 6.5, 7]),
      report: 'Điểm tổng cố tình không khớp.'
    }
  }), error => error.code === 'WRITING_GRADING_SCORE_MISMATCH');
  const partial = await database.query(`SELECT count(*)::int AS total
    FROM assessment.term_test_writing_grading_criterion;`);
  assert.equal(partial.rows[0].total, 0);

  await database.query(`UPDATE assessment.term_test_writing_grading_job
    SET max_attempts = attempt_count
    WHERE id = $1::uuid;`, [collectJob.jobId]);
  const terminal = await service.failJob({
    jobId: collectJob.jobId,
    workerId: 'collector-invalid',
    errorCode: 'WRITING_SCORE_CONTRACT_FAILED'
  });
  assert.equal(terminal.status, 'review_required');
  const status = await service.getStatus(attemptToken);
  assert.equal(status.ready, false);
  assert.equal(status.status, 'review_required');
  assert.equal(status.task1Score, null);
  await database.close();
});
