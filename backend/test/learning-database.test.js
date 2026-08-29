import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { LearningError, createLearningService } from '../src/learning-service.js';
import { claimLearningJobs, processLearningJob } from '../src/learning-outbox.js';

function poolFrom(database) {
  const query = async (sql, params) => {
    const result = await database.query(sql, params);
    return {
      ...result,
      rowCount: result.rowCount ?? (result.rows.length || result.affectedRows || 0)
    };
  };
  return {
    query,
    async connect() {
      return {
        query,
        release() {}
      };
    }
  };
}

async function setupDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      approved_by TEXT,
      approved_at TIMESTAMPTZ
    );
    CREATE TABLE mapping.student_mapping_review (
      id BIGSERIAL PRIMARY KEY,
      public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      erp_student_code TEXT,
      erp_student_name_snapshot TEXT NOT NULL,
      match_method TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'approved',
      reviewer_email TEXT,
      reviewer_note TEXT,
      decided_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      , UNIQUE (erp_course_class_id, erp_student_contact_id)
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
    );
    CREATE TABLE mapping.reviewer_class_access (
      reviewer_email TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      PRIMARY KEY (reviewer_email, erp_course_class_id)
    );
    CREATE TABLE mapping.reviewer_account (
      email TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active'
    );
    INSERT INTO mapping.classroom_course_mapping VALUES (2139, 'IC2139');
    INSERT INTO mapping.student_mapping_review (
      public_id, erp_course_class_id, erp_student_contact_id, erp_student_name_snapshot
    ) VALUES
      ('60000000-0000-4000-8000-000000000001', 2139, 9001, 'Học viên trùng tên'),
      ('60000000-0000-4000-8000-000000000002', 2139, 9002, 'Học viên trùng tên'),
      ('60000000-0000-4000-8000-000000000003', 2139, 9003, 'Học viên khác');
    INSERT INTO mapping.reviewer_class_access VALUES ('teacher@example.test', 2139);
    INSERT INTO mapping.reviewer_account VALUES ('teacher@example.test', 'active');
  `);
  const migration = await readFile(
    new URL('../ops/learning-migrations/202608290001_learning_platform_v1.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migration);
  return { database, service: createLearningService({ pool: poolFrom(database) }) };
}

test('migration demo chỉ tạo dữ liệu giả và đủ hành trình tổng kết', async () => {
  const { database } = await setupDatabase();
  const seed = await readFile(
    new URL('../ops/learning-migrations/202608290002_seed_progress_log_demo.sql', import.meta.url),
    'utf8'
  );
  await database.exec(seed);
  const result = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.form_assignment WHERE erp_course_class_id = 990000567) AS assignments,
    (SELECT count(*)::int FROM learning.form_assignment_roster WHERE assignment_id = '20000000-0000-4000-8000-000000000301') AS roster,
    (SELECT count(*)::int FROM learning.submission WHERE assignment_id = '20000000-0000-4000-8000-000000000301') AS submissions,
    (SELECT count(*)::int FROM learning.evidence_event WHERE erp_course_class_id = 990000567) AS evidence,
    (SELECT count(*)::int FROM learning.periodic_report WHERE erp_course_class_id = 990000567) AS reports;
  `);
  assert.deepEqual(result.rows[0], { assignments: 1, roster: 6, submissions: 3, evidence: 3, reports: 1 });
  const dashboard = await createLearningService({ pool: poolFrom(database) }).getTeacherDashboard({
    assignmentId: '20000000-0000-4000-8000-000000000301',
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false }
  });
  const sample = dashboard.students.find(student => student.studentRef === '21000000-0000-4000-8000-000000000003');
  assert.equal(sample.evidenceCount, 3);
  assert.equal(sample.latestReport.humanNote.includes('Cô thấy em'), true);
  await database.close();
});

test('migration tạo đủ bảng lõi và không làm lộ grading key qua public assignment', async () => {
  const { database, service } = await setupDatabase();
  const published = await service.publishReflectionForm({
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    title: 'Phiếu điểm danh buổi 2',
    courseCode: 'course-67',
    classId: '2139',
    sessionNumber: 2,
    opensAt: null,
    closesAt: null,
    items: [
      { libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true },
      { libraryItemId: '10000000-0000-4000-8000-000000000002', checkpoint: 2, required: true }
    ]
  });
  assert.equal(published.rosterCount, 3);
  const assignment = await service.getPublicAssignment(published.publicToken);
  assert.equal(assignment.roster.length, 3);
  assert.equal(assignment.roster.filter(student => student.discriminator).length, 2);
  assert.equal(stableContains(assignment, 'FormGradingKeyV1'), false);
  assert.equal(stableContains(assignment, 'private_definition'), false);
  const tables = await database.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'learning'
    ORDER BY table_name;
  `);
  assert.ok(tables.rows.some(row => row.table_name === 'evidence_event'));
  assert.ok(tables.rows.some(row => row.table_name === 'outbox_job'));
  await database.close();
});

test('submit idempotent, draft cũ fail-closed và readback không đổi nhầm học viên trùng tên', async () => {
  const { database, service } = await setupDatabase();
  const published = await service.publishReflectionForm({
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    title: 'Phiếu điểm danh buổi 3',
    courseCode: 'course-67',
    classId: '2139',
    sessionNumber: 3,
    opensAt: null,
    closesAt: null,
    items: [
      { libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true },
      { libraryItemId: '10000000-0000-4000-8000-000000000003', checkpoint: 2, required: true }
    ]
  });
  const assignment = await service.getPublicAssignment(published.publicToken);
  const firstStudent = assignment.roster.find(student => student.studentRef === '60000000-0000-4000-8000-000000000001');
  const secondStudent = assignment.roster.find(student => student.studentRef === '60000000-0000-4000-8000-000000000002');
  assert.equal(firstStudent.name, secondStudent.name);
  const attempt = await service.startAttempt({
    publicToken: published.publicToken,
    studentRef: firstStudent.studentRef,
    clientIdempotencyKey: '70000000-0000-4000-8000-000000000001',
    identityConfirmed: true
  });
  const itemIds = assignment.definition.blocks.flatMap(block => block.items.map(item => item.itemVersionId));
  const responses = {
    [itemIds[0]]: 'Em đã nhận ra cách chọn ý chính.',
    [itemIds[1]]: 'Em sẽ luyện lại hai câu sai.'
  };
  const saved = await service.saveDraft({
    attemptToken: attempt.attemptToken,
    revision: 2,
    definitionHash: published.definitionHash,
    responses
  });
  assert.equal(saved.revision, 2);
  await assert.rejects(
    () => service.saveDraft({
      attemptToken: attempt.attemptToken,
      revision: 1,
      definitionHash: published.definitionHash,
      responses
    }),
    error => error instanceof LearningError && error.code === 'STALE_DRAFT'
  );
  const submissionInput = {
    attemptToken: attempt.attemptToken,
    submissionId: '70000000-0000-4000-8000-000000000002',
    definitionHash: published.definitionHash,
    draftRevision: 2,
    responses
  };
  const first = await service.submit(submissionInput);
  const replay = await service.submit(submissionInput);
  assert.equal(first.receipt.attendanceStatus, 'self_confirmed');
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.submissionId, first.receipt.submissionId);

  const dashboard = await service.getTeacherDashboard({
    assignmentId: published.assignmentId,
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false }
  });
  const firstStatus = dashboard.students.find(student => student.studentRef === firstStudent.studentRef);
  const secondStatus = dashboard.students.find(student => student.studentRef === secondStudent.studentRef);
  assert.equal(firstStatus.attendanceStatus, 'self_confirmed');
  assert.equal(secondStatus.attendanceStatus, null);

  const counts = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.submission) AS submissions,
    (SELECT count(*)::int FROM learning.evidence_event) AS evidence,
    (SELECT count(*)::int FROM learning.outbox_job) AS jobs,
    (SELECT count(*)::int FROM learning.attendance_event) AS attendance_events;
  `);
  assert.deepEqual(counts.rows[0], { submissions: 1, evidence: 1, jobs: 1, attendance_events: 1 });
  await database.close();
});

test('outbox lease đúng một lần và output sai identity bị fail-closed', async () => {
  const { database } = await setupDatabase();
  const pool = poolFrom(database);
  await database.query(`INSERT INTO learning.outbox_job (
    job_type, entity_key, unit_key, operation_key, idempotency_key, payload
  ) VALUES
    ('refresh_dashboard', 'student:fake-1', 'class:2139:session:8', 'job:correct', 'job:correct:v1', '{}'::jsonb),
    ('refresh_dashboard', 'student:fake-2', 'class:2139:session:8', 'job:mismatch', 'job:mismatch:v1', '{}'::jsonb);`);

  const claimed = await claimLearningJobs({ pool, workerId: 'worker-test-1', limit: 2, leaseSeconds: 60 });
  assert.equal(claimed.length, 2);
  const correctJob = claimed.find(job => job.operationKey === 'job:correct');
  const mismatchJob = claimed.find(job => job.operationKey === 'job:mismatch');
  assert.ok(correctJob);
  assert.ok(mismatchJob);
  const completed = await processLearningJob({
    pool,
    workerId: 'worker-test-1',
    job: correctJob,
    handler: async job => ({
      entityKey: job.entityKey,
      unitKey: job.unitKey,
      operationKey: job.operationKey,
      idempotencyKey: job.idempotencyKey,
      status: 'complete'
    })
  });
  assert.equal(completed.status, 'complete');

  const rejected = await processLearningJob({
    pool,
    workerId: 'worker-test-1',
    job: mismatchJob,
    handler: async job => ({
      entityKey: 'student:wrong-target',
      unitKey: job.unitKey,
      operationKey: job.operationKey,
      idempotencyKey: job.idempotencyKey,
      status: 'complete'
    })
  });
  assert.equal(rejected.errorCode, 'OUTPUT_IDENTITY_MISMATCH');
  const readback = await database.query(`SELECT operation_key, status, last_error_code
    FROM learning.outbox_job ORDER BY operation_key;`);
  const correct = readback.rows.find(row => row.operation_key === 'job:correct');
  const mismatch = readback.rows.find(row => row.operation_key === 'job:mismatch');
  assert.equal(correct.status, 'complete');
  assert.equal(mismatch.status, 'failed');
  assert.equal(mismatch.last_error_code, 'OUTPUT_IDENTITY_MISMATCH');
  await database.close();
});

function stableContains(value, needle) {
  return JSON.stringify(value).includes(needle);
}
