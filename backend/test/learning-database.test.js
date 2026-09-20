import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { LearningError, createLearningService } from '../src/learning-service.js';
import { claimLearningJobs, processLearningJob } from '../src/learning-outbox.js';
import { createLearningAttendanceSync } from '../src/learning-attendance-sync.js';

function poolFrom(database, onQuery = () => {}) {
  const query = async (sql, params) => {
    onQuery(sql);
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

async function createV1Database() {
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
    CREATE TABLE mapping.reviewer_class_assignment (
      reviewer_email TEXT NOT NULL,
      class_name TEXT NOT NULL,
      PRIMARY KEY (reviewer_email, class_name)
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
    INSERT INTO mapping.reviewer_class_assignment VALUES ('teacher@example.test', '  ic2139  ');
    INSERT INTO mapping.reviewer_account VALUES ('teacher@example.test', 'active');
  `);
  const migration = await readFile(
    new URL('../ops/learning-migrations/202608290001_learning_platform_v1.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migration);
  return database;
}

async function setupDatabase() {
  const database = await createV1Database();
  const migrationV2 = await readFile(
    new URL('../ops/learning-migrations/202609150001_learning_platform_v2.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migrationV2);
  const attendanceOutboxMigration = await readFile(
    new URL('../ops/learning-migrations/202609160003_portal_attendance_outbox.sql', import.meta.url),
    'utf8'
  );
  await database.exec(attendanceOutboxMigration);
  const attendanceDashboardIndex = await readFile(
    new URL('../ops/learning-migrations/202609160006_portal_attendance_dashboard_index.sql', import.meta.url),
    'utf8'
  );
  await database.exec(attendanceDashboardIndex);
  const authorityMigration = await readFile(
    new URL('../ops/learning-migrations/202609160001_course_content_authority.sql', import.meta.url),
    'utf8'
  );
  await database.exec(authorityMigration);
  const journeyMigration = await readFile(
    new URL('../ops/learning-migrations/202609150003_student_course_journey.sql', import.meta.url),
    'utf8'
  );
  await database.exec(journeyMigration);
  return { database, service: createLearningService({ pool: poolFrom(database) }) };
}

test('migration V2 chấp nhận nhiều block cùng checkpoint nhưng vẫn khóa theo block_id', async () => {
  const database = await createV1Database();
  await database.exec(`
    ALTER TABLE learning.outbox_job DROP CONSTRAINT outbox_job_job_type_check;
    ALTER TABLE learning.outbox_job ADD CONSTRAINT outbox_job_job_type_check
      CHECK (job_type IN (
        'analyze_submission', 'grade_translation', 'grade_writing_speaking',
        'build_periodic_report', 'refresh_dashboard', 'purge_student'
      ));
    INSERT INTO learning.outbox_job (
      job_type, entity_key, unit_key, operation_key, idempotency_key, payload
    ) VALUES (
      'grade_translation', 'student:test', 'submission:test',
      'existing-grade-job', 'existing-grade-job:v1', '{}'::jsonb
    );
  `);
  const definition = {
    schemaVersion: 'FormDefinitionV1',
    formVersionId: '31000000-0000-4000-8000-000000000002',
    title: 'Phiếu có hai block cùng thời điểm',
    kind: 'reflection',
    answerReleasePolicy: 'hidden',
    blocks: [
      { blockId: '31000000-0000-4000-8000-000000000003', checkpoint: 1, title: 'Phần A', instructions: '', items: [] },
      { blockId: '31000000-0000-4000-8000-000000000004', checkpoint: 1, title: 'Phần B', instructions: '', items: [] }
    ]
  };
  await database.query(`INSERT INTO learning.form_template (id, title, kind, created_by_email)
    VALUES ('31000000-0000-4000-8000-000000000001', 'Phiếu migration', 'reflection', 'teacher@example.test');`);
  await database.query(`INSERT INTO learning.form_version (
      id, template_id, version, public_definition, definition_hash, status,
      created_by_email, published_at
    ) VALUES (
      $1::uuid, '31000000-0000-4000-8000-000000000001', 1, $2::jsonb,
      $3, 'published', 'teacher@example.test', now()
    );`, [definition.formVersionId, JSON.stringify(definition), 'abababababababababababababababababababababababababababababababab']);
  await database.query(`INSERT INTO learning.form_assignment (
      id, public_token, form_version_id, course_code, erp_course_class_id,
      class_name_snapshot, session_number, title, status, created_by_email
    ) VALUES (
      '31000000-0000-4000-8000-000000000005',
      '31000000-0000-4000-8000-000000000006', $1::uuid, 'course-67', 2139,
      'IC2139', 1, 'Phiếu migration', 'published', 'teacher@example.test'
    );`, [definition.formVersionId]);
  const migrationV2 = await readFile(
    new URL('../ops/learning-migrations/202609150001_learning_platform_v2.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migrationV2);
  const releases = await database.query(`SELECT block_id, checkpoint, status
    FROM learning.assignment_block_release ORDER BY block_id;`);
  assert.equal(releases.rows.length, 2);
  assert.deepEqual(releases.rows.map(row => row.checkpoint), [1, 1]);
  assert.deepEqual(releases.rows.map(row => row.status), ['open', 'open']);
  const existingJob = await database.query(`SELECT job_type FROM learning.outbox_job
    WHERE operation_key = 'existing-grade-job';`);
  assert.equal(existingJob.rows[0].job_type, 'grade_translation');
  await database.close();
});

test('migration demo chỉ tạo dữ liệu giả và đủ hành trình tổng kết', async () => {
  const { database } = await setupDatabase();
  const seed = await readFile(
    new URL('../ops/learning-migrations/202608290002_seed_progress_log_demo.sql', import.meta.url),
    'utf8'
  );
  await database.exec(seed);
  const seedV2 = await readFile(
    new URL('../ops/learning-migrations/202609150002_seed_progress_log_demo_v2.sql', import.meta.url),
    'utf8'
  );
  await database.exec(seedV2);
  const journeySeed = await readFile(
    new URL('../ops/learning-migrations/202609150004_seed_student_course_journey_demo.sql', import.meta.url),
    'utf8'
  );
  await database.exec(journeySeed);
  const result = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.form_assignment WHERE erp_course_class_id = 990000567) AS assignments,
    (SELECT count(*)::int FROM learning.form_assignment_roster WHERE assignment_id = '20000000-0000-4000-8000-000000000301') AS roster,
    (SELECT count(*)::int FROM learning.submission WHERE assignment_id = '20000000-0000-4000-8000-000000000301') AS submissions,
    (SELECT count(*)::int FROM learning.evidence_event WHERE erp_course_class_id = 990000567) AS evidence,
    (SELECT count(*)::int FROM learning.periodic_report WHERE erp_course_class_id = 990000567) AS reports,
    (SELECT count(*)::int FROM learning.checkpoint_submission WHERE assignment_id = '20000000-0000-4000-8000-000000000301') AS checkpoints,
    (SELECT count(*)::int FROM learning.class_session_insight WHERE assignment_id = '20000000-0000-4000-8000-000000000301') AS insights;
  `);
  assert.deepEqual(result.rows[0], { assignments: 1, roster: 6, submissions: 3, evidence: 3, reports: 1, checkpoints: 3, insights: 2 });
  const service = createLearningService({ pool: poolFrom(database) });
  const dashboard = await service.getTeacherDashboard({
    assignmentId: '20000000-0000-4000-8000-000000000301',
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false }
  });
  const sample = dashboard.students.find(student => student.studentRef === '21000000-0000-4000-8000-000000000003');
  assert.equal(sample.evidenceCount, 3);
  assert.equal(sample.latestReport.humanNote.includes('Cô thấy em'), true);
  assert.equal(sample.checkpoints.length, 2);
  assert.equal(dashboard.classInsights.length, 2);
  const note = await service.saveTeacherHumanNote({
    reportId: sample.latestReport.reportId,
    assignmentId: dashboard.assignmentId,
    studentRef: sample.studentRef,
    noteText: 'Cô thấy em đang tiến bộ đúng hướng nhé.',
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false }
  });
  assert.match(note.noteText, /đúng hướng/);
  const delivery = await service.markReportDelivered({
    reportId: sample.latestReport.reportId,
    assignmentId: dashboard.assignmentId,
    studentRef: sample.studentRef,
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    operationId: crypto.randomUUID()
  });
  assert.equal(delivery.status, 'sent');
  const publishedReport = await database.query(`SELECT status, published_at IS NOT NULL AS has_published_at
    FROM learning.periodic_report WHERE id = $1::uuid;`, [sample.latestReport.reportId]);
  assert.deepEqual(publishedReport.rows[0], { status: 'published', has_published_at: true });

  const journey = await service.getStudentCourseJourney({
    accessToken: 'demo-progress-567-00000000-0000-4000-8000-000000000003'
  });
  assert.equal(journey.student.studentRef, sample.studentRef);
  assert.equal(journey.class.classId, '990000567');
  assert.equal(journey.latestReport.reportId, sample.latestReport.reportId);
  assert.equal(journey.sessions.length, 1);
  assert.equal(journey.sessions[0].evidenceCount, 1);
  assert.deepEqual(journey.sessions[0].evidenceSources, ['progress_form']);
  assert.equal(JSON.stringify(journey).includes('Nhầm FALSE và NOT GIVEN'), false);

  const firstGeneratedToken = 'generated-progress-link-00000000-0000-4000-8000-000000000001';
  const generated = await service.createStudentProgressLink({
    assignmentId: dashboard.assignmentId,
    studentRef: sample.studentRef,
    accessToken: firstGeneratedToken,
    expiresInDays: 30,
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    operationId: '23000000-0000-4000-8000-000000000002'
  });
  assert.equal(generated.studentRef, sample.studentRef);
  const replay = await service.createStudentProgressLink({
    assignmentId: dashboard.assignmentId,
    studentRef: sample.studentRef,
    accessToken: firstGeneratedToken,
    expiresInDays: 30,
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    operationId: '23000000-0000-4000-8000-000000000002'
  });
  assert.equal(replay.replayed, true);
  await service.getStudentCourseJourney({ accessToken: firstGeneratedToken });

  const replacementToken = 'generated-progress-link-00000000-0000-4000-8000-000000000002';
  await service.createStudentProgressLink({
    assignmentId: dashboard.assignmentId,
    studentRef: sample.studentRef,
    accessToken: replacementToken,
    expiresInDays: 30,
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    operationId: '23000000-0000-4000-8000-000000000003'
  });
  await assert.rejects(
    () => service.getStudentCourseJourney({ accessToken: firstGeneratedToken }),
    error => error instanceof LearningError && error.code === 'PROGRESS_LINK_INVALID'
  );
  const replacementJourney = await service.getStudentCourseJourney({ accessToken: replacementToken });
  assert.equal(replacementJourney.student.studentRef, sample.studentRef);
  assert.notEqual(replacementJourney.student.studentRef, '21000000-0000-4000-8000-000000000004');
  await database.query(`UPDATE learning.student_progress_access
    SET expires_at = now() - interval '1 minute'
    WHERE token_hash = $1;`, [crypto.createHash('sha256').update(replacementToken).digest('hex')]);
  await assert.rejects(
    () => service.getStudentCourseJourney({ accessToken: replacementToken }),
    error => error instanceof LearningError && error.code === 'PROGRESS_LINK_INVALID'
  );
  await database.close();
});

test('dashboard live trả đúng snapshot theo assignment và không lộ sang lớp không được cấp quyền', async () => {
  const { database, service } = await setupDatabase();
  const seed = await readFile(
    new URL('../ops/learning-migrations/202608290002_seed_progress_log_demo.sql', import.meta.url),
    'utf8'
  );
  await database.exec(seed);
  const seedV2 = await readFile(
    new URL('../ops/learning-migrations/202609150002_seed_progress_log_demo_v2.sql', import.meta.url),
    'utf8'
  );
  await database.exec(seedV2);

  const live = await service.getTeacherLiveDrafts({
    assignmentId: '20000000-0000-4000-8000-000000000301',
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false }
  });
  assert.equal(live.assignmentId, '20000000-0000-4000-8000-000000000301');
  assert.equal(live.students.length, 6);
  assert.equal(new Set(live.students.map(student => student.studentRef)).size, 6);
  const submitted = live.students.find(student => student.submissionId);
  assert.ok(submitted);
  assert.equal(Object.keys(submitted.finalResponses).length > 0, true);
  assert.equal(Object.hasOwn(submitted, 'gradingResult'), true);
  assert.equal(Object.hasOwn(submitted, 'attemptToken'), false);

  await assert.rejects(
    () => service.getTeacherLiveDrafts({
      assignmentId: live.assignmentId,
      reviewer: { email: 'unauthorized@example.test', canAccessAllClasses: false }
    }),
    error => error.code === 'ASSIGNMENT_ACCESS_DENIED' && error.httpStatus === 404
  );
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

test('quiz có điểm chỉ cho tự duyệt khi lead có quyền đúng khóa', async () => {
  const { database } = await setupDatabase();
  await database.query(`INSERT INTO learning.form_template (id, title, kind, created_by_email)
    VALUES ('23000000-0000-4000-8000-000000000001', 'Quiz cần duyệt', 'quiz', 'author@example.test');`);
  const definition = {
    schemaVersion: 'FormDefinitionV1',
    formVersionId: '23000000-0000-4000-8000-000000000002',
    courseCode: '56',
    title: 'Quiz cần duyệt',
    kind: 'quiz',
    answerReleasePolicy: 'hidden',
    blocks: [{
      blockId: '23000000-0000-4000-8000-000000000003', checkpoint: 1, title: 'Quiz', instructions: '',
      items: [{
        itemFamilyId: '23000000-0000-4000-8000-000000000004',
        itemVersionId: '23000000-0000-4000-8000-000000000005',
        position: 1, prompt: 'Chọn đáp án', helpText: '', interactionType: 'single_choice',
        pedagogicalTypeCode: 'multiple_choice', layoutType: 'plain_prompt', graderType: 'exact_option',
        groupId: null, required: true, maxScore: 1,
        options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }], skillCodes: ['reading'],
        releasePolicy: 'hidden'
      }]
    }]
  };
  await assert.rejects(() => database.query(`INSERT INTO learning.form_version (
      id, template_id, version, public_definition, definition_hash, status,
      created_by_email, approved_by_email, published_at
    ) VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4, 'published', $5, $5, now());`, [
    definition.formVersionId,
    '23000000-0000-4000-8000-000000000001',
    JSON.stringify(definition),
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'author@example.test'
  ]), /FORM_SECOND_APPROVAL_REQUIRED/);

  await database.query(`INSERT INTO learning.course_content_authority (
      reviewer_email, course_code, can_self_approve_scored_forms, grant_reference
    ) VALUES ($1, '67', true, 'Lead của khóa khác không được dùng chéo');`, ['author@example.test']);
  await assert.rejects(() => database.query(`INSERT INTO learning.form_version (
      id, template_id, version, public_definition, definition_hash, status,
      created_by_email, approved_by_email, published_at
    ) VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4, 'published', $5, $5, now());`, [
    definition.formVersionId,
    '23000000-0000-4000-8000-000000000001',
    JSON.stringify(definition),
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'author@example.test'
  ]), /FORM_SECOND_APPROVAL_REQUIRED/);

  await database.query(`INSERT INTO learning.course_content_authority (
      reviewer_email, course_code, can_self_approve_scored_forms, grant_reference
    ) VALUES ($1, '56', true, 'Chủ hệ thống xác nhận lead khối 56');`, ['author@example.test']);
  await database.query(`INSERT INTO learning.form_version (
      id, template_id, version, public_definition, definition_hash, status,
      created_by_email, approved_by_email, published_at
    ) VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4, 'published', $5, $5, now());`, [
    definition.formVersionId,
    '23000000-0000-4000-8000-000000000001',
    JSON.stringify(definition),
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'author@example.test'
  ]);
  const published = await database.query(`SELECT status, approved_by_email
    FROM learning.form_version WHERE id = $1::uuid;`, [definition.formVersionId]);
  assert.equal(published.rows[0].status, 'published');
  assert.equal(published.rows[0].approved_by_email, 'author@example.test');
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
  const submitQueries = [];
  const measuredService = createLearningService({
    pool: poolFrom(database, sql => submitQueries.push(String(sql).trim().split(/\s+/u)[0]))
  });
  const first = await measuredService.submit(submissionInput);
  assert.deepEqual(submitQueries, ['BEGIN', 'SELECT', 'WITH', 'COMMIT']);
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
    (SELECT count(*)::int FROM learning.response_item) AS response_items,
    (SELECT count(*)::int FROM learning.grading_result_item) AS grading_items,
    (SELECT count(*)::int FROM learning.evidence_event) AS evidence,
    (SELECT count(*)::int FROM learning.outbox_job) AS jobs,
    (SELECT count(*)::int FROM learning.attendance_event) AS attendance_events;
  `);
  assert.deepEqual(counts.rows[0], {
    submissions: 1,
    response_items: 2,
    grading_items: 2,
    evidence: 1,
    jobs: 2,
    attendance_events: 1
  });
  const queuedJobs = await database.query(`SELECT job_type, entity_key, unit_key, operation_key, idempotency_key, payload
    FROM learning.outbox_job ORDER BY job_type;`);
  assert.deepEqual(queuedJobs.rows.map(row => row.job_type), ['analyze_submission', 'sync_portal_attendance']);
  const attendanceJob = queuedJobs.rows.find(row => row.job_type === 'sync_portal_attendance');
  assert.equal(attendanceJob.payload.submissionId, submissionInput.submissionId);
  assert.equal(attendanceJob.payload.assignmentId, published.assignmentId);
  assert.equal(attendanceJob.payload.studentRef, firstStudent.studentRef);
  assert.equal(attendanceJob.payload.classId, '2139');
  assert.equal(attendanceJob.payload.studentId, '9001');
  assert.equal(attendanceJob.payload.sessionNumber, 3);
  assert.equal(attendanceJob.entity_key, `student:${firstStudent.studentRef}`);
  assert.equal(attendanceJob.unit_key, `portal-attendance:${published.assignmentId}:session:3`);
  await database.close();
});

test('giảng viên xác nhận có mặt tạo đúng một job Portal cho đúng học viên', async () => {
  const { database, service } = await setupDatabase();
  const published = await service.publishReflectionForm({
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    title: 'Phiếu điểm danh lớp thử', courseCode: '56', classId: '2139', sessionNumber: 3,
    opensAt: null, closesAt: null,
    items: [
      { libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true },
      { libraryItemId: '10000000-0000-4000-8000-000000000003', checkpoint: 2, required: true }
    ]
  });
  const common = {
    assignmentId: published.assignmentId,
    studentRef: '60000000-0000-4000-8000-000000000002',
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
    reason: 'Giảng viên đã xác nhận trong lớp.'
  };
  const confirmed = await service.overrideAttendance({
    ...common, status: 'teacher_confirmed',
    operationKey: 'attendance-override:70000000-0000-4000-8000-000000000010'
  });
  assert.equal(confirmed.status, 'teacher_confirmed');
  assert.equal(confirmed.portalSyncQueued, true);
  const jobs = await database.query(`SELECT entity_key, unit_key, operation_key, payload
    FROM learning.outbox_job WHERE job_type = 'sync_portal_attendance';`);
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].payload.schemaVersion, 'LearningPortalAttendanceOverrideJobV1');
  assert.equal(jobs.rows[0].payload.studentId, '9002');
  assert.equal(jobs.rows[0].payload.classId, '2139');
  assert.equal(jobs.rows[0].payload.sessionNumber, 3);
  assert.equal(jobs.rows[0].entity_key, `student:${common.studentRef}`);
  assert.equal(jobs.rows[0].unit_key, `portal-attendance:${common.assignmentId}:session:3`);
  const dashboard = await service.getTeacherDashboard({
    assignmentId: published.assignmentId,
    reviewer: common.reviewer
  });
  const targetStudent = dashboard.students.find(student => student.studentRef === common.studentRef);
  const otherStudent = dashboard.students.find(student => student.studentRef !== common.studentRef);
  assert.equal(targetStudent.portalSync.status, 'queued');
  assert.equal(otherStudent.portalSync, null);
  const replay = await service.overrideAttendance({
    ...common, status: 'teacher_confirmed',
    operationKey: 'attendance-override:70000000-0000-4000-8000-000000000010'
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.portalSyncQueued, true);
  const pending = await service.overrideAttendance({
    ...common, status: 'pending_teacher',
    operationKey: 'attendance-override:70000000-0000-4000-8000-000000000011'
  });
  assert.equal(pending.portalSyncQueued, false);
  const counts = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.outbox_job WHERE job_type = 'sync_portal_attendance') AS jobs,
    (SELECT count(*)::int FROM learning.attendance_event WHERE actor_type = 'teacher') AS events;`);
  assert.deepEqual(counts.rows[0], { jobs: 1, events: 2 });
  await database.close();
});

test('quiz 40 câu vẫn ghi đủ dữ liệu bằng bốn lượt trao đổi database', async () => {
  const { database } = await setupDatabase();
  const formVersionId = '24000000-0000-4000-8000-000000000002';
  const assignmentId = '24000000-0000-4000-8000-000000000004';
  const publicToken = '24000000-0000-4000-8000-000000000005';
  const studentRef = '60000000-0000-4000-8000-000000000003';
  const items = Array.from({ length: 40 }, (_, index) => ({
    itemFamilyId: `25000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    itemVersionId: `26000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    position: index + 1,
    prompt: `Câu kiểm thử tải ${index + 1}`,
    helpText: '',
    interactionType: 'single_choice',
    pedagogicalTypeCode: 'multiple_choice',
    layoutType: 'plain_prompt',
    graderType: 'exact_option',
    groupId: null,
    required: true,
    maxScore: 1,
    options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    skillCodes: ['reading'],
    releasePolicy: 'hidden'
  }));
  const definition = {
    schemaVersion: 'FormDefinitionV1',
    formVersionId,
    title: 'Quiz 40 câu kiểm thử tải',
    kind: 'quiz',
    answerReleasePolicy: 'hidden',
    blocks: [{
      blockId: '24000000-0000-4000-8000-000000000003',
      checkpoint: 1,
      title: 'Quiz',
      instructions: '',
      items
    }]
  };
  const gradingKey = {
    schemaVersion: 'FormGradingKeyV1',
    formVersionId,
    graderVersion: 1,
    items: Object.fromEntries(items.map(item => [item.itemVersionId, {
      graderType: 'exact_option',
      expectedOptionId: 'A'
    }])),
    groups: {}
  };
  await database.query(`INSERT INTO learning.form_template (
    id, title, kind, created_by_email
  ) VALUES ('24000000-0000-4000-8000-000000000001', 'Quiz tải', 'quiz', 'author@example.test');`);
  await database.query(`INSERT INTO learning.form_version (
      id, template_id, version, public_definition, definition_hash, status,
      created_by_email, approved_by_email, published_at
    ) VALUES (
      $1::uuid, '24000000-0000-4000-8000-000000000001', 1, $2::jsonb,
      $3, 'published', 'author@example.test', 'approver@example.test', now()
    );`, [
    formVersionId,
    JSON.stringify(definition),
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  ]);
  await database.query(`INSERT INTO learning.form_grading_key (
      form_version_id, grader_version, private_definition, content_hash
    ) VALUES ($1::uuid, 1, $2::jsonb, $3);`, [
    formVersionId,
    JSON.stringify(gradingKey),
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  ]);
  await database.query(`INSERT INTO learning.form_assignment (
      id, public_token, form_version_id, course_code, erp_course_class_id,
      class_name_snapshot, session_number, title, created_by_email
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'course-67', 2139,
      'IC2139', 40, 'Quiz 40 câu', 'teacher@example.test'
    );`, [assignmentId, publicToken, formVersionId]);
  await database.query(`INSERT INTO learning.form_assignment_roster (
      assignment_id, student_ref, erp_student_contact_id, student_name_snapshot
    ) VALUES ($1::uuid, $2::uuid, 9003, 'Học viên khác');`, [assignmentId, studentRef]);
  const service = createLearningService({ pool: poolFrom(database) });
  const attempt = await service.startAttempt({
    publicToken,
    studentRef,
    clientIdempotencyKey: '24000000-0000-4000-8000-000000000006',
    identityConfirmed: true
  });
  const responses = Object.fromEntries(items.map(item => [item.itemVersionId, 'A']));
  await service.saveDraft({
    attemptToken: attempt.attemptToken,
    revision: 1,
    definitionHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    responses
  });
  const submitQueries = [];
  const measuredService = createLearningService({
    pool: poolFrom(database, sql => submitQueries.push(String(sql).trim().split(/\s+/u)[0]))
  });
  const submitted = await measuredService.submit({
    attemptToken: attempt.attemptToken,
    submissionId: '24000000-0000-4000-8000-000000000007',
    definitionHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    draftRevision: 1,
    responses
  });
  assert.equal(submitted.result.summary.scoreEarned, 40);
  assert.deepEqual(submitQueries, ['BEGIN', 'SELECT', 'WITH', 'COMMIT']);
  const counts = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.response_item WHERE submission_id = '24000000-0000-4000-8000-000000000007') AS responses,
    (SELECT count(*)::int FROM learning.grading_result_item item
      JOIN learning.grading_run run ON run.id = item.grading_run_id
      WHERE run.submission_id = '24000000-0000-4000-8000-000000000007') AS grading;
  `);
  assert.deepEqual(counts.rows[0], { responses: 40, grading: 40 });
  await database.close();
});

test('GV mở từng phần và checkpoint được lưu thật, idempotent, không tự điểm danh', async () => {
  const { database, service } = await setupDatabase();
  const reviewer = { email: 'teacher@example.test', canAccessAllClasses: false };
  const published = await service.publishReflectionForm({
    reviewer,
    title: 'Phiếu có quyền mở từng phần',
    courseCode: 'course-67',
    classId: '2139',
    sessionNumber: 4,
    opensAt: null,
    closesAt: null,
    items: [
      { libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true },
      { libraryItemId: '10000000-0000-4000-8000-000000000002', checkpoint: 2, required: true }
    ]
  });
  const assignment = await service.getPublicAssignment(published.publicToken);
  assert.deepEqual(assignment.blockReleases.map(item => item.status), ['open', 'locked']);
  const student = assignment.roster[0];
  const attempt = await service.startAttempt({
    publicToken: published.publicToken,
    studentRef: student.studentRef,
    clientIdempotencyKey: crypto.randomUUID(),
    identityConfirmed: true
  });
  const [firstBlock, secondBlock] = assignment.definition.blocks;
  const firstResponses = { [firstBlock.items[0].itemVersionId]: 'Em đã làm được phần đầu.' };
  await service.saveDraft({
    attemptToken: attempt.attemptToken,
    revision: 1,
    definitionHash: published.definitionHash,
    responses: firstResponses
  });
  const checkpointInput = {
    attemptToken: attempt.attemptToken,
    checkpointSubmissionId: crypto.randomUUID(),
    blockId: firstBlock.blockId,
    checkpoint: 1,
    draftRevision: 1,
    definitionHash: published.definitionHash,
    responses: firstResponses,
    idempotencyKey: `checkpoint-test:${crypto.randomUUID()}`
  };
  const saved = await service.submitCheckpoint(checkpointInput);
  const replayed = await service.submitCheckpoint(checkpointInput);
  assert.equal(saved.completeness, 'complete');
  assert.equal(replayed.replayed, true);

  await assert.rejects(
    () => service.submitCheckpoint({
      ...checkpointInput,
      checkpointSubmissionId: crypto.randomUUID(),
      blockId: secondBlock.blockId,
      checkpoint: 2,
      responses: { [secondBlock.items[0].itemVersionId]: 'Em còn vướng một điểm.' },
      idempotencyKey: `checkpoint-test:${crypto.randomUUID()}`
    }),
    error => error instanceof LearningError && error.code === 'BLOCK_NOT_OPEN'
  );

  const release = await service.setBlockRelease({
    assignmentId: published.assignmentId,
    blockId: secondBlock.blockId,
    status: 'open',
    reviewer,
    operationId: crypto.randomUUID()
  });
  assert.equal(release.status, 'open');
  await service.setBlockRelease({
    assignmentId: published.assignmentId,
    blockId: firstBlock.blockId,
    status: 'closed',
    reviewer,
    operationId: crypto.randomUUID()
  });
  const lateReplay = await service.submitCheckpoint(checkpointInput);
  assert.equal(lateReplay.replayed, true, 'Mất phản hồi rồi thử lại phải đọc được checkpoint cũ dù phần đã đóng.');
  await assert.rejects(
    () => service.submitCheckpoint({
      ...checkpointInput,
      responses: { [firstBlock.items[0].itemVersionId]: 'Nội dung khác.' }
    }),
    error => error instanceof LearningError && error.code === 'CHECKPOINT_IDEMPOTENCY_CONFLICT'
  );
  const counts = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.checkpoint_submission) AS checkpoints,
    (SELECT count(*)::int FROM learning.attendance_record) AS attendance,
    (SELECT count(*)::int FROM learning.assignment_block_release_event) AS release_events;
  `);
  assert.deepEqual(counts.rows[0], { checkpoints: 1, attendance: 0, release_events: 2 });
  const final = await service.submit({
    attemptToken: attempt.attemptToken,
    submissionId: crypto.randomUUID(),
    definitionHash: published.definitionHash,
    draftRevision: 1,
    responses: { ...firstResponses, [secondBlock.items[0].itemVersionId]: 'Em đã hoàn thành phần cuối.' }
  });
  assert.equal(final.receipt.attendanceStatus, 'self_confirmed');
  const replayAfterFinal = await service.submitCheckpoint(checkpointInput);
  assert.equal(replayAfterFinal.replayed, true, 'Retry checkpoint sau khi phiếu cuối đã nộp phải đọc lại bản cũ.');
  await assert.rejects(() => service.submitCheckpoint({
    ...checkpointInput,
    checkpointSubmissionId: crypto.randomUUID(),
    idempotencyKey: `checkpoint-test:${crypto.randomUUID()}`
  }), error => error instanceof LearningError && error.code === 'ATTEMPT_NOT_ACTIVE');
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

test('bài nộp thiếu không tự điểm danh; GV xác nhận thì Portal lỗi rồi hồi phục không làm mất biên nhận', async () => {
  const { database, service } = await setupDatabase();
  const reviewer = { email: 'teacher@example.test', canAccessAllClasses: false };
  const published = await service.publishReflectionForm({
    reviewer, title: 'Phiếu thử thiếu câu', courseCode: '56', classId: '2139', sessionNumber: 6,
    opensAt: null, closesAt: null,
    items: [
      { libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true },
      { libraryItemId: '10000000-0000-4000-8000-000000000003', checkpoint: 2, required: true }
    ]
  });
  const assignment = await service.getPublicAssignment(published.publicToken);
  const student = assignment.roster[0];
  const attempt = await service.startAttempt({
    publicToken: published.publicToken, studentRef: student.studentRef,
    clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true
  });
  const firstItem = assignment.definition.blocks[0].items[0].itemVersionId;
  const responses = { [firstItem]: 'Em chỉ kịp ghi phần đầu.' };
  const submission = await service.submit({
    attemptToken: attempt.attemptToken, submissionId: crypto.randomUUID(),
    definitionHash: published.definitionHash, draftRevision: 0, responses
  });
  assert.equal(submission.receipt.attendanceStatus, 'pending_teacher');
  const before = await database.query(`SELECT job_type FROM learning.outbox_job ORDER BY job_type;`);
  assert.deepEqual(before.rows.map(row => row.job_type), ['analyze_submission']);
  const replay = await service.submit({
    attemptToken: attempt.attemptToken, submissionId: crypto.randomUUID(),
    definitionHash: published.definitionHash, draftRevision: 0, responses
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.submissionId, submission.receipt.submissionId);
  await assert.rejects(() => service.submit({
    attemptToken: attempt.attemptToken, submissionId: crypto.randomUUID(),
    definitionHash: published.definitionHash, draftRevision: 0,
    responses: { [firstItem]: 'Nội dung bị đổi sau nộp.' }
  }), error => error instanceof LearningError && error.code === 'SUBMISSION_ALREADY_FINAL');

  const override = await service.overrideAttendance({
    assignmentId: published.assignmentId, studentRef: student.studentRef,
    status: 'teacher_confirmed', reason: 'Giảng viên thấy học viên có mặt.',
    reviewer, operationKey: `attendance-override:${crypto.randomUUID()}`
  });
  assert.equal(override.portalSyncQueued, true);
  const pool = poolFrom(database);
  const [job] = await claimLearningJobs({
    pool, workerId: 'portal-test-1', limit: 10,
    jobTypes: ['sync_portal_attendance']
  });
  assert.equal(job.payload.studentRef, student.studentRef);
  const config = {
    learningAttendanceSyncUrl: 'https://example.test/attendance',
    learningAttendanceSyncSecret: 'test-only-secret',
    learningAttendanceSyncTimeoutMs: 1000
  };
  const firstHandler = createLearningAttendanceSync({
    config, fetchImpl: async () => ({ ok: false, status: 503 })
  });
  const failed = await processLearningJob({
    pool, workerId: 'portal-test-1', job, handler: firstHandler
  });
  assert.equal(failed.errorCode, 'PORTAL_ATTENDANCE_HTTP_503');
  const failedReadback = await database.query(`SELECT status, last_error_code, attempt_count
    FROM learning.outbox_job WHERE id = $1::uuid;`, [job.id]);
  assert.deepEqual(failedReadback.rows[0], {
    status: 'retry_wait', last_error_code: 'PORTAL_ATTENDANCE_HTTP_503', attempt_count: 1
  });
  await database.query(`UPDATE learning.outbox_job SET next_attempt_at = now() - interval '1 second'
    WHERE id = $1::uuid;`, [job.id]);
  const [retried] = await claimLearningJobs({
    pool, workerId: 'portal-test-2', limit: 10,
    jobTypes: ['sync_portal_attendance']
  });
  assert.equal(retried.id, job.id);
  let sent;
  const recoveryHandler = createLearningAttendanceSync({ config, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, status: 200, async json() {
      return { ok: true, status: 'synced', entityKey: job.entityKey,
        unitKey: job.unitKey, operationKey: job.operationKey,
        idempotencyKey: job.idempotencyKey, classId: job.payload.classId,
        studentId: job.payload.studentId, sessionNumber: job.payload.sessionNumber };
    } };
  } });
  const completed = await processLearningJob({
    pool, workerId: 'portal-test-2', job: retried, handler: recoveryHandler
  });
  assert.equal(completed.status, 'complete');
  assert.equal(sent.studentRef, student.studentRef);
  assert.equal(sent.commit, true);
  const dashboard = await service.getTeacherDashboard({ assignmentId: published.assignmentId, reviewer });
  const target = dashboard.students.find(row => row.studentRef === student.studentRef);
  assert.equal(target.attendanceStatus, 'teacher_confirmed');
  assert.equal(target.portalSync.status, 'complete');
  assert.equal(target.submissionId, submission.receipt.submissionId);
  const counts = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.submission) AS submissions,
    (SELECT count(*)::int FROM learning.outbox_job WHERE job_type = 'sync_portal_attendance') AS portal_jobs;`);
  assert.deepEqual(counts.rows[0], { submissions: 1, portal_jobs: 1 });
  await database.close();
});

function stableContains(value, needle) {
  return JSON.stringify(value).includes(needle);
}
