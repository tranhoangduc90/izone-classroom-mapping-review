import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { LearningError, createLearningService } from '../src/learning-service.js';
import {createLearningTestResultReader} from '../src/learning-test-results.js';
import { claimLearningJobs, processLearningJob } from '../src/learning-outbox.js';
import { createLearningAttendanceSync } from '../src/learning-attendance-sync.js';
import { sha256, stableStringify } from '../src/learning-domain.js';
import {
  buildIc2304Session2ScoredDefinition,
  buildIc2304Session2ScoredGradingKey,
  IC2304_SESSION2_SCORED
} from '../src/learning-templates/ic2304-session2-scored.js';
import {
  buildIc2304Session2SpeakingDefinition,
  buildIc2304Session2SpeakingGradingKey,
  IC2304_SESSION2_SPEAKING
} from '../src/learning-templates/ic2304-session2-speaking.js';
import {
  buildIc2305Session5Definition,
  buildIc2305Session5GradingKey,
  IC2305_SESSION5_TEMPLATE
} from '../src/learning-templates/ic2305-session5-reading-writing-speaking.js';

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
    CREATE TABLE mapping.reviewer_account (
      email TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE mapping.reviewer_class_assignment (
      reviewer_email TEXT NOT NULL,
      class_name TEXT NOT NULL
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
  const progressAdminMigration = await readFile(
    new URL('../ops/learning-migrations/202609280001_progress_log_admin_scope.sql', import.meta.url),
    'utf8'
  );
  await database.exec(progressAdminMigration);
  const journeyMigration = await readFile(
    new URL('../ops/learning-migrations/202609150003_student_course_journey.sql', import.meta.url),
    'utf8'
  );
  await database.exec(journeyMigration);
  const speakingFeedbackMigration = await readFile(
    new URL('../ops/learning-migrations/202609240001_teacher_session_speaking_feedback.sql', import.meta.url),
    'utf8'
  );
  await database.exec(speakingFeedbackMigration);
  const answerReleaseMigration = await readFile(
    new URL('../ops/learning-migrations/202609280001_assignment_answer_release.sql', import.meta.url),
    'utf8'
  );
  await database.exec(answerReleaseMigration);
  const journeyPlanMigration = await readFile(
    new URL('../ops/learning-migrations/202609290001_teacher_confirmed_journey_plan.sql', import.meta.url),
    'utf8'
  );
  await database.exec(journeyPlanMigration);
  await database.exec(await readFile(new URL('../ops/learning-migrations/202610060001_attendance_binding_and_submission_deadline.sql', import.meta.url), 'utf8'));
  return { database, service: createLearningService({ pool: poolFrom(database) }) };
}

test('ba học viên nộp đủ kích hoạt hạn 22:00 ngày người thứ ba, receipt retry giữ hạn', async () => {
  const { database, service } = await setupDatabase();
  try {
    const published = await service.publishReflectionForm({
      reviewer: { email: 'teacher@example.test', canAccessAllClasses: false },
      title: 'Phiếu kiểm hạn nhận bài', courseCode: 'course-67', classId: '2139',
      sessionNumber: 3, opensAt: null, closesAt: null,
      items: [{ libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true }]
    });
    const assignment = await service.getPublicAssignment(published.publicToken);
    const itemId = assignment.definition.blocks[0].items[0].itemVersionId;
    let lastInput, lastResult;
    for (const student of assignment.roster.slice(0, 3)) {
      const attempt = await service.startAttempt({ publicToken: published.publicToken,
        studentRef: student.studentRef, identityConfirmed: true, clientIdempotencyKey: crypto.randomUUID() });
      lastInput = { attemptToken: attempt.attemptToken, submissionId: crypto.randomUUID(),
        definitionHash: published.definitionHash, draftRevision: 0,
        responses: { [itemId]: 'Nội dung đầy đủ để kiểm hạn nhận bài.' } };
      lastResult = await service.submit(lastInput);
    }
    const vietnamDay = new Date(Date.parse(lastResult.receipt.receivedAt) + 7 * 3600_000).toISOString().slice(0, 10);
    assert.equal(lastResult.submissionWindow?.autoClosesAt, `${vietnamDay}T15:00:00.000Z`);
    assert.equal(lastResult.submissionWindow?.completeStudents, 3);
    const replay = await service.submit(lastInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.submissionWindow.autoClosesAt, lastResult.submissionWindow.autoClosesAt);
    assert.equal(Number((await database.query('SELECT count(*) AS count FROM learning.submission')).rows[0].count), 3);
  } finally { await database.close(); }
});

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

  await database.query(`INSERT INTO learning.evidence_event (
    id, source_system, source_record_id, source_revision, entity_key, unit_key,
    operation_key, idempotency_key, organization_key, course_code,
    erp_course_class_id, session_number, student_ref, visibility, payload,
    content_hash, renderer_version, markdown, occurred_at
  ) VALUES (
    '24000000-0000-4000-8000-000000000005', 'mini_test', 'mini-5-student-3', 1,
    'student:21000000-0000-4000-8000-000000000003', 'class:990000567:session:5',
    'mini-5-student-3-op', 'mini-5-student-3-idem', 'izone', 'DEMO-56',
    990000567, 5, '21000000-0000-4000-8000-000000000003', 'analysis_allowed',
    '{"test":{"title":"Mini Test buổi 5"}}'::jsonb,
    repeat('a', 64), 'fixture-v1', '', now()
  );`);
  const journey = await service.getStudentCourseJourney({
    accessToken: 'demo-progress-567-00000000-0000-4000-8000-000000000003'
  });
  assert.equal(journey.student.studentRef, sample.studentRef);
  assert.equal(journey.class.classId, '990000567');
  assert.equal(journey.latestReport.reportId, sample.latestReport.reportId);
  assert.equal(journey.sessions.length, 6);
  assert.equal(journey.sessions[4].sessionNumber, 5);
  assert.equal(journey.sessions[4].assignmentId, null);
  assert.equal(journey.sessions[4].completeness, null);
  assert.equal(journey.sessions[4].sessionKind, 'test');
  assert.equal(journey.sessions[4].dataOrigin, 'test_evidence');
  assert.equal(journey.sessions[3].dataOrigin, 'inferred_gap');
  assert.equal(journey.sessions[4].title, 'Mini Test');
  assert.deepEqual(journey.coverage, {
    knownThroughSession: 6, schedule: 'not_connected', plannedSessions: null,
    planOutdated: false, testResults: 'not_connected'
  });
  assert.equal(journey.sessions[5].evidenceCount, 1);
  assert.deepEqual(journey.sessions[5].evidenceSources, ['progress_form']);
  assert.equal(JSON.stringify(journey).includes('Nhầm FALSE và NOT GIVEN'), false);
  const integratedJourney = await service.getStudentCourseJourney({
    publicToken: dashboard.publicToken, studentRef: sample.studentRef
  });
  assert.equal(integratedJourney.student.studentRef, sample.studentRef);
  assert.equal(integratedJourney.class.classId, journey.class.classId);
  assert.equal(integratedJourney.sessions.length, journey.sessions.length);
  const reviewer = { email: 'teacher@example.test', canAccessAllClasses: false };
  const emptyPlan = await service.getTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, reviewer
  });
  assert.equal(emptyPlan.totalSessions, null);
  assert.equal(emptyPlan.revision, 0);
  assert.deepEqual(emptyPlan.sessionDates, []);
  await assert.rejects(
    () => service.saveTeacherJourneyPlan({
      assignmentId: dashboard.assignmentId, totalSessions: 5,
      testSessionNumbers: [], expectedRevision: 0, reviewer
    }),
    error => error instanceof LearningError && error.code === 'JOURNEY_PLAN_TOO_SHORT'
  );
  const savedPlan = await service.saveTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, totalSessions: 8,
    testSessionNumbers: [5, 7],
    sessionDates: [{ sessionNumber: 1, date: '2026-09-01' },
      { sessionNumber: 7, date: '2026-09-30' }],
    expectedRevision: 0, reviewer
  });
  assert.equal(savedPlan.revision, 1);
  assert.equal(savedPlan.replayed, false);
  const planReadback = await service.getTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, reviewer
  });
  assert.deepEqual(planReadback.testSessionNumbers, [5, 7]);
  assert.deepEqual(planReadback.sessionDates, [
    { sessionNumber: 1, date: '2026-09-01' },
    { sessionNumber: 7, date: '2026-09-30' }
  ]);
  const planReplay = await service.saveTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, totalSessions: 8,
    testSessionNumbers: [5, 7],
    sessionDates: [{ sessionNumber: 1, date: '2026-09-01' },
      { sessionNumber: 7, date: '2026-09-30' }],
    expectedRevision: 0, reviewer
  });
  assert.equal(planReplay.replayed, true);
  const legacySave = await service.saveTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, totalSessions: 8,
    testSessionNumbers: [5, 7], expectedRevision: 1, reviewer
  });
  assert.equal(legacySave.revision, 2);
  assert.deepEqual(legacySave.sessionDates, planReadback.sessionDates);
  const erpCalls = [];
  const erpService = createLearningService({ pool: poolFrom(database),
    erpScheduleReader: async classId => {
      erpCalls.push(String(classId));
      return { sessions: [{ erpSessionId: '35811', date: '2026-09-14',
        startsAt: '2026-09-14 18:30:00', endsAt: '2026-09-14 21:00:00', statusCode: 1 }],
      fetchedAt: '2026-09-30T00:00:00.000Z' };
    }
  });
  const erpSchedule = await erpService.getTeacherErpSchedule({
    assignmentId: dashboard.assignmentId, reviewer
  });
  assert.equal(erpSchedule.classId, '990000567');
  assert.deepEqual(erpCalls, ['990000567']);
  await assert.rejects(
    () => erpService.getTeacherErpSchedule({ assignmentId: dashboard.assignmentId,
      reviewer: { email: 'unauthorized@example.test', canAccessAllClasses: false } }),
    error => error instanceof LearningError && error.code === 'ASSIGNMENT_ACCESS_DENIED'
  );
  assert.deepEqual(erpCalls, ['990000567']);
  await assert.rejects(
    () => erpService.saveTeacherJourneyPlan({assignmentId: dashboard.assignmentId,
      totalSessions:8, testSessionNumbers:[5,7], expectedRevision:2,
      expectedScheduleFingerprint:'b'.repeat(64), reviewer}),
    error => error instanceof LearningError && error.code === 'ERP_SCHEDULE_STALE'
  );
  assert.equal((await service.getTeacherJourneyPlan({assignmentId:dashboard.assignmentId,reviewer})).revision,2);
  await assert.rejects(
    () => erpService.saveTeacherJourneyPlan({ assignmentId: dashboard.assignmentId,
      totalSessions: 8, testSessionNumbers: [5, 7],
      sessionDates: [{ sessionNumber: 2, date: '2026-09-15', erpSessionId: '35811' }],
      expectedRevision: 2, reviewer }),
    error => error instanceof LearningError && error.code === 'ERP_SCHEDULE_MAPPING_CHANGED'
  );
  const mappedPlan = await erpService.saveTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, totalSessions: 8, testSessionNumbers: [5, 7],
    sessionDates: [{ sessionNumber: 1, date: '2026-09-01' },
      { sessionNumber: 2, date: '2026-09-14', erpSessionId: '35811' },
      { sessionNumber: 6, date: '2026-09-28' },
      { sessionNumber: 7, date: '2026-09-30' }],
    expectedRevision: 2, expectedScheduleFingerprint: erpSchedule.fingerprint, reviewer
  });
  assert.equal(mappedPlan.revision, 3);
  await assert.rejects(
    () => service.saveTeacherJourneyPlan({assignmentId:dashboard.assignmentId,
      totalSessions:8,testSessionNumbers:[5,7],expectedRevision:3,reviewer,
      sessionDates:mappedPlan.sessionDates.filter(item=>item.sessionNumber!==6)}),
    error => error instanceof LearningError && error.code === 'ERP_ASSIGNED_SESSION_LOCKED'
  );
  assert.equal((await service.getTeacherJourneyPlan({assignmentId:dashboard.assignmentId,reviewer})).revision,3);
  assert.deepEqual((await erpService.getTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, reviewer
  })).sessionDates, mappedPlan.sessionDates);
  const testSourceCalls = [];
  const testSourceService = createLearningService({ pool: poolFrom(database),
    testSourceReader: async classId => {
      testSourceCalls.push(String(classId));
      return [{ testSlug: 'mini-test-lesson-5', title: 'Mini Test',
        definitionVersion: 1, studentsWithResult: 3,
        latestResultAt: '2026-09-29T10:00:00.000Z' }];
    }
  });
  const sources = await testSourceService.getTeacherTestSources({
    assignmentId: dashboard.assignmentId, reviewer
  });
  assert.equal(sources.tests[0].studentsWithResult, 3);
  assert.deepEqual(testSourceCalls, ['990000567']);
  const mappedTestPlan = await testSourceService.saveTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, totalSessions: 8, testSessionNumbers: [5, 7],
    testSources: [{ sessionNumber: 5, testSlug: 'mini-test-lesson-5' }],
    expectedRevision: 3, reviewer
  });
  assert.equal(mappedTestPlan.revision, 4);
  assert.deepEqual((await testSourceService.getTeacherJourneyPlan({
    assignmentId: dashboard.assignmentId, reviewer
  })).testSources, [{ sessionNumber: 5, testSlug: 'mini-test-lesson-5' }]);
  const testResultService = createLearningService({ pool: poolFrom(database),
    testResultReader: async input => {
      assert.deepEqual(input, { classId: '990000567', studentRef: sample.studentRef,
        testSlugs: ['mini-test-lesson-5'] });
      return [{ testSlug: 'mini-test-lesson-5', title: 'Mini Test',
        completedAt: '2026-09-29T10:00:00.000Z',
        listening: { correct: 15, total: 20, band: 7 },
        reading: { correct: 9, total: 13, band: 7 }, writing: null }];
    }
  });
  const journeyWithTest = await testResultService.getStudentCourseJourney({
    publicToken: dashboard.publicToken, studentRef: sample.studentRef
  });
  assert.equal(journeyWithTest.coverage.testResults, 'connected');
  assert.equal(journeyWithTest.sessions[4].testResult.listening.correct, 15);
  assert.equal(journeyWithTest.sessions[3].testResult, undefined);
  await assert.rejects(() => testSourceService.getTeacherTestSources({
    assignmentId: dashboard.assignmentId,
    reviewer: { email: 'unauthorized@example.test', canAccessAllClasses: false }
  }), error => error instanceof LearningError && error.code === 'ASSIGNMENT_ACCESS_DENIED');
  assert.deepEqual(testSourceCalls, ['990000567', '990000567']);
  await assert.rejects(
    () => service.saveTeacherJourneyPlan({
      assignmentId: dashboard.assignmentId, totalSessions: 9,
      testSessionNumbers: [5, 7], expectedRevision: 0, reviewer
    }),
    error => error instanceof LearningError && error.code === 'JOURNEY_PLAN_STALE'
  );
  await assert.rejects(
    () => service.getTeacherJourneyPlan({
      assignmentId: dashboard.assignmentId,
      reviewer: { email: 'unauthorized@example.test', canAccessAllClasses: false }
    }),
    error => error instanceof LearningError && error.code === 'ASSIGNMENT_ACCESS_DENIED'
  );
  const plannedJourney = await service.getStudentCourseJourney({
    publicToken: dashboard.publicToken, studentRef: sample.studentRef
  });
  assert.equal(plannedJourney.sessions.length, 8);
  assert.deepEqual(plannedJourney.coverage, {
    knownThroughSession: 8, schedule: 'teacher_confirmed',
    plannedSessions: 8, planOutdated: false, testResults: 'temporarily_unavailable'
  });
  assert.equal(plannedJourney.sessions[6].sessionKind, 'test');
  assert.equal(plannedJourney.sessions[6].dataOrigin, 'confirmed_plan');
  assert.equal(plannedJourney.sessions[6].assignmentId, null);
  assert.equal(plannedJourney.sessions[6].title, 'Buổi Test');
  assert.equal(plannedJourney.sessions[0].sessionDate, '2026-09-01');
  assert.equal(plannedJourney.sessions[6].sessionDate, '2026-09-30');
  assert.equal(plannedJourney.sessions[4].sessionDate, null);
  const overview = await service.getCourseOverview({classId:'990000567',reviewer});
  assert.equal(overview.sessions.length,8);
  assert.equal(overview.students.find(s=>s.studentRef===sample.studentRef).cells[6].status,'test_pending');
  assert.ok(overview.students.every(s=>s.cells.length===8));
  const detail=await service.getCourseSessionDetail({classId:'990000567',studentRef:sample.studentRef,
    sessionNumber:dashboard.sessionNumber,reviewer});
  assert.equal(detail.student.studentRef,sample.studentRef);
  assert.equal(detail.sessionNumber,dashboard.sessionNumber);
  assert.ok(detail.definition.blocks.length);
  assert.ok(Object.keys(detail.responses).length);
  assert.doesNotMatch(JSON.stringify(detail),/expectedAnswer|expectedOptionId/u);
  const testDetail=await service.getCourseSessionDetail({classId:'990000567',studentRef:sample.studentRef,
    sessionNumber:7,reviewer});
  assert.equal(testDetail.status,'test_pending');
  assert.equal(testDetail.definition,null);
  await assert.rejects(()=>service.getCourseSessionDetail({classId:'990000567',studentRef:'21000000-0000-4000-8000-000000000099',
    sessionNumber:3,reviewer}),error=>error.code==='JOURNEY_STUDENT_NOT_FOUND');
  await assert.rejects(()=>service.getCourseOverview({classId:'990000567',
    reviewer:{email:'unauthorized@example.test',canAccessAllClasses:false}}),
    error=>error instanceof LearningError&&error.code==='CLASS_ACCESS_DENIED');
  assert.equal(plannedJourney.sessions[7].dataOrigin, 'confirmed_plan');
  await database.query(`INSERT INTO learning.evidence_event (
    id, source_system, source_record_id, source_revision, entity_key, unit_key,
    operation_key, idempotency_key, organization_key, course_code,
    erp_course_class_id, session_number, student_ref, visibility, payload,
    content_hash, renderer_version, markdown, occurred_at
  ) VALUES (
    '24000000-0000-4000-8000-000000000009', 'mini_test', 'late-mini-9', 1,
    'student:21000000-0000-4000-8000-000000000003', 'class:990000567:session:9',
    'late-mini-9-op', 'late-mini-9-idem', 'izone', 'DEMO-56',
    990000567, 9, '21000000-0000-4000-8000-000000000003', 'analysis_allowed',
    '{}'::jsonb, repeat('b', 64), 'fixture-v1', '', now()
  );`);
  await assert.rejects(
    () => service.saveTeacherJourneyPlan({
      assignmentId: dashboard.assignmentId, totalSessions: 8,
      testSessionNumbers: [5, 7], expectedRevision: 1, reviewer
    }),
    error => error instanceof LearningError && error.code === 'JOURNEY_PLAN_TOO_SHORT'
  );
  const outdatedJourney = await service.getStudentCourseJourney({
    publicToken: dashboard.publicToken, studentRef: sample.studentRef
  });
  assert.equal(outdatedJourney.sessions.length, 9);
  assert.equal(outdatedJourney.coverage.planOutdated, true);
  await assert.rejects(
    () => service.getStudentCourseJourney({
      publicToken: dashboard.publicToken, studentRef: '21000000-0000-4000-8000-000000000099'
    }),
    error => error instanceof LearningError && error.code === 'PROGRESS_LINK_INVALID'
  );

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
  await database.query(`UPDATE learning.form_assignment SET status = 'closed'
    WHERE public_token = $1::uuid;`, [dashboard.publicToken]);
  const closedContext = await service.getLearningJourneyContext(dashboard.publicToken);
  assert.equal(closedContext.class.id, journey.class.classId);
  assert.equal(closedContext.roster.length, 6);
  await assert.rejects(() => service.getPublicAssignment(dashboard.publicToken));
  const closedJourney = await service.getStudentCourseJourney({
    publicToken: dashboard.publicToken, studentRef: sample.studentRef
  });
  assert.equal(closedJourney.sessions.length, 9);
  await database.close();
});

test('O01/O03/E07: lớp chưa có phiếu vẫn đọc/chốt kế hoạch đúng quyền lớp', async () => {
  const {database}=await setupDatabase();
  const reviewer={email:'teacher@example.test',canAccessAllClasses:false};
  const service=createLearningService({pool:poolFrom(database),erpScheduleReader:async()=>({sessions:[
    {erpSessionId:'401',date:'2026-10-05',startsAt:'2026-10-05 18:30:00',endsAt:'2026-10-05 20:00:00',status:1},
    {erpSessionId:'402',date:'2026-10-08',startsAt:'2026-10-08 18:30:00',endsAt:'2026-10-08 20:00:00',status:1}]})});
  try {
    const initial=await service.getTeacherJourneyPlan({classId:'2139',reviewer});
    assert.equal(initial.revision,0);assert.equal(initial.highestKnownSession,0);
    const schedule=await service.getTeacherErpSchedule({classId:'2139',reviewer});
    await service.saveTeacherJourneyPlan({classId:'2139',totalSessions:2,testSessionNumbers:[2],
      sessionDates:[{sessionNumber:1,erpSessionId:'401',date:'2026-10-05'},{sessionNumber:2,erpSessionId:'402',date:'2026-10-08'}],
      expectedRevision:0,expectedScheduleFingerprint:schedule.fingerprint,reviewer});
    const overview=await service.getCourseOverview({classId:'2139',reviewer});
    assert.equal(overview.sessions.length,2);assert.equal(overview.counts.assignments,0);
    assert.equal(overview.students.length,3);assert.ok(overview.students.every(student=>student.cells.length===2));
    assert.equal(new Set(overview.students.map(student=>student.studentRef)).size,3);
    assert.equal(overview.rosterCoverage,'mapping_unverified');
    // Nguồn Test giả đúng các field được reader dùng: kiểm SQL tổng hợp và Writing đến sau.
    await database.exec(`CREATE SCHEMA assessment;
      CREATE TABLE assessment.test_definition (slug text PRIMARY KEY,title text);
      CREATE TABLE assessment.term_test_roster (test_slug text,erp_course_class_id bigint,student_ref uuid,erp_student_contact_id bigint);
      CREATE TABLE assessment.term_test_temporary_student (test_slug text,erp_course_class_id bigint,student_ref uuid,temporary_student_id bigint,active boolean);
      CREATE TABLE assessment.term_test_attempt (id uuid PRIMARY KEY,test_slug text,erp_course_class_id bigint,erp_student_contact_id bigint,
        completed_at timestamptz,writing_submitted_at timestamptz,combined_result jsonb);
      CREATE TABLE assessment.term_test_writing_grading_final (attempt_id uuid,status text,writing_score numeric);
      CREATE TABLE assessment.mini_test_result (test_slug text,erp_course_class_id bigint,erp_student_contact_id bigint,result jsonb,updated_at timestamptz);
      INSERT INTO assessment.test_definition VALUES ('term-test-2','Term Test giả');
      INSERT INTO assessment.term_test_attempt VALUES
        ('31000000-0000-4000-8000-000000000001','term-test-2',2139,9001,now(),now(),'{"reading":{"correct":28,"total":40}}'),
        ('31000000-0000-4000-8000-000000000002','term-test-2',2139,9002,now(),now(),'{"reading":{"correct":30,"total":40}}');
      INSERT INTO assessment.term_test_writing_grading_final VALUES ('31000000-0000-4000-8000-000000000002','ready',6);
      UPDATE learning.class_journey_plan SET test_sources='[{"sessionNumber":2,"testSlug":"term-test-2"}]' WHERE erp_course_class_id=2139;`);
    let bulkQueries=0;
    const testReader=createLearningTestResultReader({pool:poolFrom(database,()=>{bulkQueries+=1;})});
    const results=await testReader.readClass({classId:'2139',studentRefs:overview.students.map(student=>student.studentRef),testSlugs:['term-test-2']});
    assert.equal(bulkQueries,1);assert.equal(results.length,2);
    const testService=createLearningService({pool:poolFrom(database),testResultReader:testReader});
    const testOverview=await testService.getCourseOverview({classId:'2139',reviewer});
    const first=testOverview.students.find(student=>student.studentRef==='60000000-0000-4000-8000-000000000001');
    assert.equal(first.cells[1].testResult.reading.correct,28);assert.equal(first.cells[1].testResult.writing.status,'pending');
    await database.exec(`INSERT INTO assessment.term_test_writing_grading_final VALUES ('31000000-0000-4000-8000-000000000001','ready',6.5);`);
    const updated=await testService.getCourseOverview({classId:'2139',reviewer});
    assert.equal(updated.students.find(student=>student.studentRef===first.studentRef).cells[1].testResult.writing.score,6.5);
    await database.exec(`ALTER TABLE mapping.erp_class_membership_snapshot ADD COLUMN registration_status text;
      ALTER TABLE mapping.erp_class_membership_snapshot ADD COLUMN source_state text;
      INSERT INTO mapping.erp_class_membership_snapshot VALUES (2139,9001,'active','active'),(2139,9002,'on_hold','active'),(2139,9003,'dropped','missing');`);
    const reduced=await testService.getCourseOverview({classId:'2139',reviewer});
    assert.equal(reduced.counts.currentStudents,1);assert.equal(reduced.rosterCoverage,'erp_snapshot');
    const unauthorized={email:'other@example.test',canAccessAllClasses:false};
    for(const method of ['getTeacherJourneyPlan','getTeacherErpSchedule','getCourseOverview']) {
      await assert.rejects(()=>service[method]({classId:'2139',reviewer:unauthorized}),error=>error.code==='CLASS_ACCESS_DENIED');
    }
  } finally {await database.close();}
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

test('quản trị Progress Log thấy và công bố ở lớp khác mà không nhận quyền toàn hệ thống', async () => {
  const { database, service } = await setupDatabase();
  await database.exec(`
    INSERT INTO mapping.classroom_course_mapping VALUES (2140, 'IC2140');
    INSERT INTO mapping.student_mapping_review (
      public_id, erp_course_class_id, erp_student_contact_id, erp_student_name_snapshot
    ) VALUES ('60000000-0000-4000-8000-000000000004', 2140, 9004, 'Học viên lớp khác');
    INSERT INTO mapping.reviewer_account VALUES ('admin@example.test', 'active');
    INSERT INTO learning.progress_log_admin (reviewer_email, grant_reference)
    VALUES ('admin@example.test', 'Đức cấp quyền quản trị Progress Log để kiểm thử');
  `);
  const admin = { email: 'admin@example.test', canAccessAllClasses: false };
  const classes = await service.listTeacherOptions(admin);
  assert.deepEqual(classes.classes.map(item => item.class_id), ['2139', '2140']);
  const teacher = { email: 'other@example.test', canAccessAllClasses: false };
  await assert.rejects(() => service.publishReflectionForm({
    reviewer: teacher, title: 'Phiếu lớp khác', courseCode: '56', classId: '2140',
    sessionNumber: 1, opensAt: null, closesAt: null,
    items: [{ libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true }]
  }), error => error instanceof LearningError && error.code === 'CLASS_ACCESS_DENIED');
  const published = await service.publishReflectionForm({
    reviewer: admin, title: 'Phiếu lớp khác', courseCode: '56', classId: '2140',
    sessionNumber: 1, opensAt: null, closesAt: null,
    items: [{ libraryItemId: '10000000-0000-4000-8000-000000000001', checkpoint: 1, required: true }]
  });
  assert.equal(published.rosterCount, 1);
  await database.exec("UPDATE learning.progress_log_admin SET status = 'revoked', revoked_at = now() WHERE reviewer_email = 'admin@example.test';");
  assert.equal((await service.listTeacherOptions(admin)).classes.length, 0);
  await database.exec("UPDATE learning.progress_log_admin SET status = 'active', revoked_at = NULL WHERE reviewer_email = 'admin@example.test'; UPDATE mapping.reviewer_account SET status = 'inactive' WHERE email = 'admin@example.test';");
  assert.equal((await service.listTeacherOptions(admin)).classes.length, 0);
  await database.close();
});

test('quiz có điểm chỉ cho tự duyệt khi lead có quyền đúng khóa', async () => {
  const { database } = await setupDatabase();
  // Quyền quản trị Progress Log không tự cấp quyền duyệt nội dung có điểm.
  await database.exec(`INSERT INTO mapping.reviewer_account (email) VALUES ('author@example.test');
    INSERT INTO learning.progress_log_admin (reviewer_email, grant_reference)
    VALUES ('author@example.test', 'Được quyền quản trị Progress Log để kiểm thử');`);
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
  assert.equal(submitQueries[0], 'BEGIN');
  assert.equal(submitQueries.at(-1), 'COMMIT');
  assert.ok(submitQueries.length <= 8, 'Nhận bài và khóa hạn dùng số lượt trao đổi cố định.');
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
  const queuedJourney = await service.getStudentCourseJourney({
    publicToken: published.publicToken, studentRef: common.studentRef
  });
  const queuedSession = queuedJourney.sessions.find(session => session.sessionNumber === 3);
  assert.equal(queuedSession.dataOrigin, 'progress_log');
  assert.equal(queuedSession.portalSync.status, 'queued');
  await database.query("UPDATE learning.outbox_job SET status = 'review_required' WHERE job_type = 'sync_portal_attendance';");
  const reviewJourney = await service.getStudentCourseJourney({
    publicToken: published.publicToken, studentRef: common.studentRef
  });
  assert.equal(reviewJourney.sessions.find(session => session.sessionNumber === 3).portalSync.status, 'review_required');
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

test('quiz 40 câu vẫn ghi đủ dữ liệu với số lượt trao đổi database cố định, gồm khóa hạn', async () => {
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
  assert.equal(submitQueries[0], 'BEGIN');
  assert.equal(submitQueries.at(-1), 'COMMIT');
  assert.ok(submitQueries.length <= 8, 'Số câu hỏi không làm tăng số lượt trao đổi database.');
  const counts = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.response_item WHERE submission_id = '24000000-0000-4000-8000-000000000007') AS responses,
    (SELECT count(*)::int FROM learning.grading_result_item item
      JOIN learning.grading_run run ON run.id = item.grading_run_id
      WHERE run.submission_id = '24000000-0000-4000-8000-000000000007') AS grading;
  `);
  assert.deepEqual(counts.rows[0], { responses: 40, grading: 40 });
  const reviewer={email:'teacher@example.test',canAccessAllClasses:false};
  const analytics=await service.getQuestionAnalytics({assignmentId,reviewer});
  assert.equal(analytics.items.length,40);assert.equal(analytics.submittedCount,1);
  assert.ok(analytics.items.every(item=>item.counts.correct===1&&item.counts.graded===1));
  await assert.rejects(()=>service.getQuestionAnalytics({assignmentId,
    reviewer:{email:'outside@example.test',canAccessAllClasses:false}}),
    error=>error instanceof LearningError&&error.code==='ASSIGNMENT_ACCESS_DENIED');
  // Tạo lần chấm lại trên DB giả; bản hoàn tất mới nhất thay điểm cũ, không tăng mẫu số.
  await database.exec(`INSERT INTO learning.grading_run (id,submission_id,grader_version,operation_key,idempotency_key,status,result_json,completed_at)
    SELECT '28000000-0000-4000-8000-000000000001',submission_id,2,'fixture-regrade-op','fixture-regrade-idem',status,result_json,now()+interval '1 second'
    FROM learning.grading_run WHERE submission_id='24000000-0000-4000-8000-000000000007' AND grader_version=1;
    INSERT INTO learning.grading_result_item (grading_run_id,item_version_id,raw_answer,normalized_answer,expected_answer,answer_state,verdict,score_earned,max_score)
    SELECT '28000000-0000-4000-8000-000000000001',item_version_id,raw_answer,normalized_answer,expected_answer,answer_state,
      CASE WHEN item_version_id='26000000-0000-4000-8000-000000000001' THEN 'incorrect' ELSE verdict END,
      CASE WHEN item_version_id='26000000-0000-4000-8000-000000000001' THEN 0 ELSE score_earned END,max_score
    FROM learning.grading_result_item WHERE grading_run_id=(SELECT id FROM learning.grading_run
      WHERE submission_id='24000000-0000-4000-8000-000000000007' AND grader_version=1);`);
  const regraded=await service.getQuestionAnalytics({assignmentId,reviewer});
  assert.equal(regraded.items[0].counts.incorrect,1);assert.equal(regraded.items[0].counts.correct,0);
  assert.equal(regraded.items[0].counts.graded,1);assert.equal(regraded.submittedCount,1);
  assert.ok(!JSON.stringify(regraded).includes('expectedOptionId'));
  // Làm lại có lượt mới: bỏ bài cũ khỏi mẫu số, rồi chỉ đếm bài nộp hiện hành.
  await database.query(`UPDATE learning.attempt SET status='superseded' WHERE attempt_token=$1::uuid`,[attempt.attemptToken]);
  const retake=await service.startAttempt({publicToken,studentRef,clientIdempotencyKey:crypto.randomUUID(),identityConfirmed:true});
  assert.equal((await service.getQuestionAnalytics({assignmentId,reviewer})).submittedCount,0);
  const retakeResponses=Object.fromEntries(items.map(item=>[item.itemVersionId,'B']));
  await service.saveDraft({attemptToken:retake.attemptToken,revision:1,definitionHash:retake.definitionHash,responses:retakeResponses});
  const retakeInput={attemptToken:retake.attemptToken,submissionId:crypto.randomUUID(),definitionHash:retake.definitionHash,
    draftRevision:1,responses:retakeResponses};
  await service.submit(retakeInput);await service.submit(retakeInput);
  const canonical=await service.getQuestionAnalytics({assignmentId,reviewer});
  assert.equal(canonical.submittedCount,1);
  assert.ok(canonical.items.every(item=>item.counts.graded===1&&item.counts.incorrect===1));
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

test('Listening IC2304 chấm khi nộp phần, khôi phục được và hiện điểm ngay trong danh sách GV', async () => {
  const { database, service } = await setupDatabase();
  const definition = buildIc2304Session2ScoredDefinition();
  const sampleAnswers = ['B', 'B', 'B', 'B', 'B'];
  const gradingKey = buildIc2304Session2ScoredGradingKey(sampleAnswers);
  const assignmentId = '23040002-0000-4000-8000-000000000005';
  const publicToken = '23040002-0000-4000-8000-000000000006';
  const studentRef = '60000000-0000-4000-8000-000000000001';
  await database.query(`INSERT INTO mapping.reviewer_account (email) VALUES ('reviewer@example.test');`);
  await database.query(`INSERT INTO mapping.reviewer_class_access VALUES ('reviewer@example.test', 2139);`);
  await database.query(`INSERT INTO learning.form_template
    (id, title, kind, created_by_email) VALUES ($1::uuid, $2, 'mixed', 'teacher@example.test');`, [
    IC2304_SESSION2_SCORED.templateId, definition.title
  ]);
  await database.query(`INSERT INTO learning.form_version
    (id, template_id, version, schema_version, public_definition, definition_hash,
     status, created_by_email, approved_by_email, published_at)
    VALUES ($1::uuid, $2::uuid, 2, 'FormDefinitionV1', $3::jsonb, $4,
      'published', 'teacher@example.test', 'reviewer@example.test', now());`, [
    definition.formVersionId, IC2304_SESSION2_SCORED.templateId,
    JSON.stringify(definition), sha256(stableStringify(definition))
  ]);
  await database.query(`INSERT INTO learning.form_grading_key
    (form_version_id, schema_version, grader_version, private_definition, content_hash)
    VALUES ($1::uuid, 'FormGradingKeyV1', 1, $2::jsonb, $3);`, [
    definition.formVersionId, JSON.stringify(gradingKey), sha256(stableStringify(gradingKey))
  ]);
  await database.query(`INSERT INTO learning.form_assignment
    (id, public_token, form_version_id, course_code, erp_course_class_id,
     class_name_snapshot, session_number, title, status, created_by_email)
    VALUES ($1::uuid, $2::uuid, $3::uuid, '67', 2139,
      'IC2139', 2, $4, 'published', 'teacher@example.test');`, [
    assignmentId, publicToken, definition.formVersionId, definition.title
  ]);
  await database.query(`INSERT INTO learning.form_assignment_roster
    (assignment_id, student_ref, erp_student_contact_id, student_name_snapshot)
    VALUES ($1::uuid, $2::uuid, 9001, 'Học viên mẫu');`, [assignmentId, studentRef]);
  for (const [index, block] of definition.blocks.entries()) {
    await database.query(`INSERT INTO learning.assignment_block_release
      (assignment_id, block_id, checkpoint, status, release_version, updated_by_email)
      VALUES ($1::uuid, $2::uuid, $3, $4, 1, 'teacher@example.test');`, [
      assignmentId, block.blockId, block.checkpoint, index === 0 ? 'open' : 'locked'
    ]);
  }
  const assignment = await service.getPublicAssignment(publicToken);
  assert.equal(JSON.stringify(assignment).includes('expectedOptionId'), false);
  const attempt = await service.startAttempt({ publicToken, studentRef,
    clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true });
  assert.equal(attempt.checkpointSubmissions.length, 0);
  const responses = Object.fromEntries(definition.blocks[0].items.map((item, index) => [
    item.itemVersionId, ['A', 'B', 'A', 'A', 'B'][index]
  ]));
  await service.saveDraft({ attemptToken: attempt.attemptToken, revision: 1,
    definitionHash: attempt.definitionHash, responses });
  const input = { attemptToken: attempt.attemptToken,
    checkpointSubmissionId: crypto.randomUUID(), blockId: definition.blocks[0].blockId,
    checkpoint: 1, draftRevision: 1, definitionHash: attempt.definitionHash,
    responses, idempotencyKey: `ic2304-test:${crypto.randomUUID()}` };
  const submitted = await service.submitCheckpoint(input);
  assert.equal(submitted.result.summary.scoreEarned, 2);
  assert.deepEqual(submitted.result.items.map(item => item.expectedAnswer), sampleAnswers);
  const replayed = await service.submitCheckpoint(input);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.result.summary.scoreEarned, 2);
  const restored = await service.startAttempt({ publicToken, studentRef,
    clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true });
  assert.equal(restored.checkpointSubmissions[0].result.summary.scoreEarned, 2);
  const dashboard = await service.getTeacherDashboard({ assignmentId,
    reviewer: { email: 'teacher@example.test', canAccessAllClasses: false } });
  assert.deepEqual(dashboard.students[0].checkpointScores, [
    { blockId: definition.blocks[0].blockId, checkpoint: 1, correct: 2, total: 5 }
  ]);
  const denied = await service.getTeacherDashboard({ assignmentId,
    reviewer: { email: 'outsider@example.test', canAccessAllClasses: false } }).catch(error => error);
  assert.equal(denied.code, 'ASSIGNMENT_ACCESS_DENIED');
  const attendance = await database.query('SELECT count(*)::int AS total FROM learning.attendance_record;');
  assert.equal(attendance.rows[0].total, 0);
  await database.close();
});

test('IC2305 hiện đáp án sau checkpoint và cả demo 56/67 đều không ghi Portal', async () => {
  const { database, service } = await setupDatabase();
  const definition = buildIc2305Session5Definition();
  const gradingKey = buildIc2305Session5GradingKey();
  const assignmentId = '56000000-0000-4000-8000-000000000099';
  const publicToken = '56000000-0000-4000-8000-000000000098';
  const studentRef = '60000000-0000-4000-8000-000000000001';
  await database.query(`INSERT INTO learning.form_template (id, title, kind, created_by_email)
    VALUES ($1::uuid, $2, 'mixed', 'teacher@example.test')`,
  [IC2305_SESSION5_TEMPLATE.templateId, definition.title]);
  await database.query(`INSERT INTO learning.form_version
    (id, template_id, version, schema_version, public_definition, definition_hash,
     status, created_by_email, approved_by_email, published_at)
    VALUES ($1::uuid, $2::uuid, 1, 'FormDefinitionV1', $3::jsonb, $4,
      'published', 'teacher@example.test', 'reviewer@example.test', now())`,
  [definition.formVersionId, IC2305_SESSION5_TEMPLATE.templateId,
    JSON.stringify(definition), sha256(stableStringify(definition))]);
  await database.query(`INSERT INTO learning.form_grading_key
    (form_version_id, schema_version, grader_version, private_definition, content_hash)
    VALUES ($1::uuid, 'FormGradingKeyV1', 1, $2::jsonb, $3)`,
  [definition.formVersionId, JSON.stringify(gradingKey), sha256(stableStringify(gradingKey))]);
  await database.query(`INSERT INTO learning.form_assignment
    (id, public_token, form_version_id, course_code, erp_course_class_id,
     class_name_snapshot, session_number, title, status, created_by_email)
    VALUES ($1::uuid, $2::uuid, $3::uuid, '56', 2139,
      'IC2305', 5, $4, 'published', 'teacher@example.test')`,
  [assignmentId, publicToken, definition.formVersionId, definition.title]);
  await database.query(`INSERT INTO learning.form_assignment_roster
    (assignment_id, student_ref, erp_student_contact_id, student_name_snapshot)
    VALUES ($1::uuid, $2::uuid, 9001, 'Học viên mẫu')`, [assignmentId, studentRef]);
  for (const block of definition.blocks) {
    await database.query(`INSERT INTO learning.assignment_block_release
      (assignment_id, block_id, checkpoint, status, release_version, updated_by_email)
      VALUES ($1::uuid, $2::uuid, $3, 'open', 1, 'teacher@example.test')`,
    [assignmentId, block.blockId, block.checkpoint]);
  }
  const items = definition.blocks.flatMap(block => block.items);
  const responses = Object.fromEntries([
    [items[0].itemVersionId, 'Em nhớ cách đọc câu hỏi.'],
    [items[1].itemVersionId, 'A'],
    [items[2].itemVersionId, 'C'],
    [items[3].itemVersionId, 'C'],
    [items[4].itemVersionId, 'A'],
    [items[5].itemVersionId, ['Dùng từ chỉ khả năng', 'Giới hạn khẳng định']],
    [items[6].itemVersionId, 'FLUENCY']
  ]);
  const openedBefore = await service.getPublicAssignment(publicToken);
  const attempt = await service.startAttempt({ publicToken, studentRef,
    clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true });
  const firstResponses = Object.fromEntries(Object.entries(responses)
    .filter(([id]) => definition.blocks[0].items.some(item => item.itemVersionId === id)));
  await service.saveDraft({ attemptToken: attempt.attemptToken, revision: 1,
    definitionHash: attempt.definitionHash, responses: firstResponses });
  const firstInput = { attemptToken: attempt.attemptToken,
    checkpointSubmissionId: crypto.randomUUID(), blockId: definition.blocks[0].blockId,
    checkpoint: 1, draftRevision: 1, definitionHash: attempt.definitionHash,
    responses: firstResponses, idempotencyKey: `first:${crypto.randomUUID()}` };
  const hidden = await service.submitCheckpoint(firstInput);
  assert.equal(hidden.result, null);
  await database.query(`UPDATE learning.form_assignment
    SET answer_release_override = 'immediate' WHERE id = $1::uuid`, [assignmentId]);
  const openedAfter = await service.getPublicAssignment(publicToken);
  assert.deepEqual(openedAfter.definition, openedBefore.definition);
  assert.equal(openedAfter.definitionHash, attempt.definitionHash);
  assert.equal(JSON.stringify(openedAfter).includes('expectedOptionId'), false);
  const resumed = await service.startAttempt({ publicToken, studentRef,
    clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true });
  assert.equal(resumed.attemptToken, attempt.attemptToken);
  assert.equal(resumed.checkpointSubmissions[0].result.answerRelease, 'released');
  const replay = await service.submitCheckpoint(firstInput);
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.items.find(item => item.itemVersionId === items[1].itemVersionId).expectedAnswer, 'B');
  assert.equal(replay.result.items.find(item => item.itemVersionId === items[0].itemVersionId).verdict, 'ungraded');
  await service.saveDraft({ attemptToken: attempt.attemptToken, revision: 2,
    definitionHash: attempt.definitionHash, responses });
  const second = await service.submitCheckpoint({ attemptToken: attempt.attemptToken,
    checkpointSubmissionId: crypto.randomUUID(), blockId: definition.blocks[1].blockId,
    checkpoint: 2, draftRevision: 2, definitionHash: attempt.definitionHash,
    responses, idempotencyKey: `second:${crypto.randomUUID()}` });
  assert.equal(second.result.answerRelease, 'released');
  assert.equal(second.result.items.filter(item => item.maxScore > 0).length, 2);
  await database.query(`UPDATE learning.form_assignment SET course_code = NULL WHERE id = $1::uuid`, [assignmentId]);
  const finalInput = { attemptToken: attempt.attemptToken, submissionId: crypto.randomUUID(),
    definitionHash: attempt.definitionHash, draftRevision: 2, responses };
  const final = await service.submit(finalInput);
  assert.equal(final.result.answerRelease, 'released');
  assert.equal(final.result.items.filter(item => item.maxScore > 0).length, 4);
  assert.equal(final.result.items.filter(item => item.verdict === 'ungraded').length, 4);
  assert.equal(final.result.items.find(item => item.itemVersionId === items[5].itemVersionId).expectedAnswer, null);
  assert.equal((await service.submit(finalInput)).result.answerRelease, 'released');
  assert.equal((await service.getResult({ attemptToken: attempt.attemptToken })).result.answerRelease, 'released');
  await database.query(`UPDATE learning.form_assignment SET answer_release_override = NULL
    WHERE id = $1::uuid`, [assignmentId]);
  const afterRollback = await service.getResult({ attemptToken: attempt.attemptToken });
  assert.equal(afterRollback.result.answerRelease, 'hidden');
  assert.equal(afterRollback.result.items.some(item => Object.hasOwn(item, 'expectedAnswer')), false);
  const counts = await database.query(`SELECT
    (SELECT count(*)::int FROM learning.attempt WHERE assignment_id = $1::uuid) AS attempts,
    (SELECT count(*)::int FROM learning.submission WHERE assignment_id = $1::uuid) AS submissions`, [assignmentId]);
  assert.deepEqual(counts.rows[0], { attempts: 1, submissions: 1 });
  const realJobs = await database.query(`SELECT count(*)::int AS total FROM learning.outbox_job
    WHERE job_type = 'sync_portal_attendance' AND entity_key = $1`, [`student:${studentRef}`]);
  assert.equal(realJobs.rows[0].total, 1);
  await database.query(`UPDATE learning.form_assignment SET course_code = '56' WHERE id = $1::uuid`, [assignmentId]);

  const demoAssignmentId = '56000000-0000-4000-8d00-000000000005';
  const demoStudentRef = '21000000-0000-4000-8000-000000000001';
  await database.query(`INSERT INTO learning.form_assignment
    (id, public_token, form_version_id, course_code, erp_course_class_id,
     class_name_snapshot, session_number, title, status, created_by_email, answer_release_override)
    VALUES ($1::uuid, gen_random_uuid(), $2::uuid, 'DEMO-56', 990000567,
      'IC2305 · Bản dùng thử', 5, 'Buổi 5 · Bản dùng thử', 'published',
      'teacher@example.test', 'immediate')`, [demoAssignmentId, definition.formVersionId]);
  await database.query(`INSERT INTO learning.form_assignment_roster
    (assignment_id, student_ref, erp_student_contact_id, student_name_snapshot)
    VALUES ($1::uuid, $2::uuid, 990000001, 'HỌC VIÊN DEMO')`, [demoAssignmentId, demoStudentRef]);
  for (const block of definition.blocks) {
    await database.query(`INSERT INTO learning.assignment_block_release
      (assignment_id, block_id, checkpoint, status, release_version, updated_by_email)
      VALUES ($1::uuid, $2::uuid, $3, 'open', 1, 'teacher@example.test')`,
    [demoAssignmentId, block.blockId, block.checkpoint]);
  }
  const demoToken = await database.query(`SELECT public_token::text FROM learning.form_assignment
    WHERE id = $1::uuid`, [demoAssignmentId]);
  const demoAttempt = await service.startAttempt({ publicToken: demoToken.rows[0].public_token,
    studentRef: demoStudentRef, clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true });
  await service.saveDraft({ attemptToken: demoAttempt.attemptToken, revision: 1,
    definitionHash: demoAttempt.definitionHash, responses });
  for (const block of definition.blocks) {
    await service.submitCheckpoint({ attemptToken: demoAttempt.attemptToken,
      checkpointSubmissionId: crypto.randomUUID(), blockId: block.blockId,
      checkpoint: block.checkpoint, draftRevision: 1, definitionHash: demoAttempt.definitionHash,
      responses, idempotencyKey: `demo:${crypto.randomUUID()}` });
  }
  const demoFinal = await service.submit({ attemptToken: demoAttempt.attemptToken,
    submissionId: crypto.randomUUID(), definitionHash: demoAttempt.definitionHash,
    draftRevision: 1, responses });
  assert.equal(demoFinal.result.answerRelease, 'released');
  const demoJobs = await database.query(`SELECT count(*)::int AS total FROM learning.outbox_job
    WHERE job_type = 'sync_portal_attendance' AND entity_key = $1`, [`student:${demoStudentRef}`]);
  assert.equal(demoJobs.rows[0].total, 0);
  await database.query(`UPDATE learning.form_assignment
    SET course_code = 'DEMO-67', class_name_snapshot = 'IC2304 · Bản dùng thử',
      session_number = 3 WHERE id = $1::uuid`, [demoAssignmentId]);
  const demo67Attempt = await service.startAttempt({ publicToken: demoToken.rows[0].public_token,
    studentRef: demoStudentRef, clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true });
  await service.saveDraft({ attemptToken: demo67Attempt.attemptToken, revision: 1,
    definitionHash: demo67Attempt.definitionHash, responses });
  for (const block of definition.blocks) {
    await service.submitCheckpoint({ attemptToken: demo67Attempt.attemptToken,
      checkpointSubmissionId: crypto.randomUUID(), blockId: block.blockId,
      checkpoint: block.checkpoint, draftRevision: 1, definitionHash: demo67Attempt.definitionHash,
      responses, idempotencyKey: `demo67:${crypto.randomUUID()}` });
  }
  const demo67Final = await service.submit({ attemptToken: demo67Attempt.attemptToken,
    submissionId: crypto.randomUUID(), definitionHash: demo67Attempt.definitionHash,
    draftRevision: 1, responses });
  assert.equal(demo67Final.result.answerRelease, 'released');
  const demo67Jobs = await database.query(`SELECT count(*)::int AS total FROM learning.outbox_job
    WHERE job_type = 'sync_portal_attendance' AND entity_key = $1`, [`student:${demoStudentRef}`]);
  assert.equal(demo67Jobs.rows[0].total, 0);
  const realRoster = await database.query(`SELECT count(*)::int AS total FROM learning.form_assignment_roster
    WHERE assignment_id = $1::uuid AND student_ref = $2::uuid`, [assignmentId, demoStudentRef]);
  assert.equal(realRoster.rows[0].total, 0);
  await database.close();
});

test('IC2304 v3 lưu Speaking và nộp đủ ba phần, chỉ Listening có điểm', async () => {
  const { database, service } = await setupDatabase();
  const definition = buildIc2304Session2SpeakingDefinition();
  const sampleAnswers = ['B', 'B', 'B', 'B', 'B'];
  const gradingKey = buildIc2304Session2SpeakingGradingKey(sampleAnswers);
  const assignmentId = '23040002-0000-4000-8000-000000000025';
  const publicToken = '23040002-0000-4000-8000-000000000026';
  const studentRef = '60000000-0000-4000-8000-000000000001';
  await database.query(`INSERT INTO mapping.reviewer_account (email) VALUES ('reviewer@example.test');`);
  await database.query(`INSERT INTO mapping.reviewer_class_access VALUES ('reviewer@example.test', 2139);`);
  await database.query(`INSERT INTO learning.form_template
    (id, title, kind, created_by_email) VALUES ($1::uuid, $2, 'mixed', 'teacher@example.test');`, [
    IC2304_SESSION2_SPEAKING.templateId, definition.title
  ]);
  await database.query(`INSERT INTO learning.form_version
    (id, template_id, version, schema_version, public_definition, definition_hash,
     status, created_by_email, approved_by_email, published_at)
    VALUES ($1::uuid, $2::uuid, 3, 'FormDefinitionV1', $3::jsonb, $4,
      'published', 'teacher@example.test', 'reviewer@example.test', now());`, [
    definition.formVersionId, IC2304_SESSION2_SPEAKING.templateId,
    JSON.stringify(definition), sha256(stableStringify(definition))
  ]);
  await database.query(`INSERT INTO learning.form_grading_key
    (form_version_id, schema_version, grader_version, private_definition, content_hash)
    VALUES ($1::uuid, 'FormGradingKeyV1', 1, $2::jsonb, $3);`, [
    definition.formVersionId, JSON.stringify(gradingKey), sha256(stableStringify(gradingKey))
  ]);
  await database.query(`INSERT INTO learning.form_assignment
    (id, public_token, form_version_id, course_code, erp_course_class_id,
     class_name_snapshot, session_number, title, status, created_by_email)
    VALUES ($1::uuid, $2::uuid, $3::uuid, '67', 2139,
      'IC2139', 2, $4, 'published', 'teacher@example.test');`, [
    assignmentId, publicToken, definition.formVersionId, definition.title
  ]);
  await database.query(`INSERT INTO learning.form_assignment_roster
    (assignment_id, student_ref, erp_student_contact_id, student_name_snapshot)
    VALUES ($1::uuid, $2::uuid, 9001, 'Học viên mẫu');`, [assignmentId, studentRef]);
  for (const block of definition.blocks) {
    await database.query(`INSERT INTO learning.assignment_block_release
      (assignment_id, block_id, checkpoint, status, release_version, updated_by_email)
      VALUES ($1::uuid, $2::uuid, $3, 'open', 1, 'teacher@example.test');`, [
      assignmentId, block.blockId, block.checkpoint
    ]);
  }
  const assignment = await service.getPublicAssignment(publicToken);
  assert.equal(assignment.definition.blocks.length, 3);
  assert.equal(JSON.stringify(assignment).includes('expectedOptionId'), false);
  const attempt = await service.startAttempt({ publicToken, studentRef,
    clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true });
  const [listening, writing, speaking] = definition.blocks;
  const responses = Object.fromEntries(listening.items.map((item, index) => [
    item.itemVersionId, sampleAnswers[index]
  ]));
  for (const item of writing.items) responses[item.itemVersionId] = 'Ý minh họa';
  responses[speaking.items[0].itemVersionId] = ['IDEAS', 'VOCABULARY'];
  responses[speaking.items[1].itemVersionId] = 'Em thiếu ví dụ';
  responses[speaking.items[2].itemVersionId] = 'Em thiếu từ về môi trường';
  await service.saveDraft({ attemptToken: attempt.attemptToken, revision: 1,
    definitionHash: attempt.definitionHash, responses });
  for (const block of definition.blocks) {
    const submitted = await service.submitCheckpoint({ attemptToken: attempt.attemptToken,
      checkpointSubmissionId: crypto.randomUUID(), blockId: block.blockId,
      checkpoint: block.checkpoint, draftRevision: 1, definitionHash: attempt.definitionHash,
      responses, idempotencyKey: `ic2304-v3:${crypto.randomUUID()}` });
    assert.equal(submitted.completeness, 'complete');
    assert.equal(submitted.result?.summary.maxScore ?? 0, block.checkpoint === 1 ? 5 : 0);
  }
  const final = await service.submit({ attemptToken: attempt.attemptToken,
    submissionId: crypto.randomUUID(), definitionHash: attempt.definitionHash,
    draftRevision: 1, responses });
  assert.equal(final.receipt.completeness, 'complete');
  assert.equal(final.receipt.attendanceStatus, 'self_confirmed');
  const readback = await database.query(`SELECT response_payload FROM learning.checkpoint_submission
    WHERE assignment_id = $1::uuid AND checkpoint = 3;`, [assignmentId]);
  assert.deepEqual(readback.rows[0].response_payload[speaking.items[0].itemVersionId],
    ['IDEAS', 'VOCABULARY']);
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

test('outbox tự nhận lại job processing khi lease đã hết sau khi worker dừng', async () => {
  const { database } = await setupDatabase();
  const pool = poolFrom(database);
  await database.query(`INSERT INTO learning.outbox_job (
    job_type, entity_key, unit_key, operation_key, idempotency_key, payload
  ) VALUES ('sync_portal_attendance', 'student:lease-test', 'class:2139:session:8',
    'job:lease-test', 'job:lease-test:v1', '{}'::jsonb);`);

  const [first] = await claimLearningJobs({
    pool, workerId: 'worker-before-restart', limit: 1, leaseSeconds: 60,
    jobTypes: ['sync_portal_attendance']
  });
  assert.ok(first);
  assert.equal((await claimLearningJobs({
    pool, workerId: 'worker-too-early', limit: 1, jobTypes: ['sync_portal_attendance']
  })).length, 0);

  await database.query(`UPDATE learning.outbox_job SET lease_until = now() - interval '1 second'
    WHERE id = $1::uuid;`, [first.id]);
  const [recovered] = await claimLearningJobs({
    pool, workerId: 'worker-after-restart', limit: 1, jobTypes: ['sync_portal_attendance']
  });
  assert.equal(recovered?.id, first.id);
  assert.equal(recovered.attemptCount, 2);
  const finished = await processLearningJob({
    pool, workerId: 'worker-after-restart', job: recovered,
    handler: async job => ({
      entityKey: job.entityKey, unitKey: job.unitKey,
      operationKey: job.operationKey, idempotencyKey: job.idempotencyKey,
      status: 'complete'
    })
  });
  assert.equal(finished.status, 'complete');
  assert.equal((await claimLearningJobs({
    pool, workerId: 'worker-third', limit: 1, jobTypes: ['sync_portal_attendance']
  })).length, 0);
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
    config, pool, fetchImpl: async () => ({ ok: false, status: 503 })
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
  const recoveryHandler = createLearningAttendanceSync({ config, pool, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, status: 200, async json() {
      return { ok: true, status: sent.commit ? 'synced' : 'resolved', entityKey: job.entityKey,
        unitKey: job.unitKey, operationKey: job.operationKey,
        idempotencyKey: job.idempotencyKey, classId: job.payload.classId,
        studentId: job.payload.studentId, sessionNumber: job.payload.sessionNumber,
        targetSessionId: '35817', resolvedSessionId: '35817', bindingRevision: sent.bindingRevision ?? null,
        scheduleFingerprint: 'fixture-schedule', sessionDate: '2026-10-05' };
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


test('nhận xét Speaking gửi đúng học viên, đọc lại và chặn gửi trùng hay người không có quyền', async () => {
  const { database, service } = await setupDatabase();
  for (const name of [
    '202608290002_seed_progress_log_demo.sql',
    '202609150002_seed_progress_log_demo_v2.sql',
    '202609150004_seed_student_course_journey_demo.sql'
  ]) {
    const seed = await readFile(new URL(`../ops/learning-migrations/${name}`, import.meta.url), 'utf8');
    await database.exec(seed);
  }
  const assignmentId = '20000000-0000-4000-8000-000000000301';
  const studentRef = '21000000-0000-4000-8000-000000000003';
  const otherStudentRef = '21000000-0000-4000-8000-000000000004';
  const reviewer = { email: 'teacher@example.test', canAccessAllClasses: false };
  const input = { assignmentId, studentRef, noteText: 'Em đã phát triển ý rõ hơn; luyện nhịp nói mỗi ngày.',
    expectedRevision: 0, operationId: crypto.randomUUID(), reviewer };
  const sent = await service.sendTeacherSessionFeedback(input);
  assert.equal(sent.revision, 1);
  assert.equal(sent.replayed, false);
  const replay = await service.sendTeacherSessionFeedback(input);
  assert.equal(replay.replayed, true);
  await assert.rejects(() => service.sendTeacherSessionFeedback({ ...input, noteText: 'Nội dung khác' }),
    error => error instanceof LearningError && error.code === 'SESSION_FEEDBACK_IDEMPOTENCY_CONFLICT');
  await assert.rejects(() => service.sendTeacherSessionFeedback({ ...input, operationId: crypto.randomUUID() }),
    error => error instanceof LearningError && error.code === 'SESSION_FEEDBACK_STALE');
  await assert.rejects(() => service.sendTeacherSessionFeedback({ ...input,
    operationId: crypto.randomUUID(), reviewer: { email: 'outsider@example.test', canAccessAllClasses: false } }),
  error => error instanceof LearningError && error.code === 'SESSION_FEEDBACK_ACCESS_DENIED');

  const dashboard = await service.getTeacherDashboard({ assignmentId, reviewer });
  assert.equal(dashboard.students.find(row => row.studentRef === studentRef)
    .teacherSessionFeedback.noteText, input.noteText);
  assert.equal(dashboard.students.find(row => row.studentRef === otherStudentRef)
    .teacherSessionFeedback, null);
  const journey = await service.getStudentCourseJourney({
    accessToken: 'demo-progress-567-00000000-0000-4000-8000-000000000003'
  });
  assert.equal(journey.sessions.find(session => session.sessionNumber === 6)
    .teacherSessionFeedback.noteText, input.noteText);
  const otherAccessToken = 'generated-progress-link-00000000-0000-4000-8000-000000000004';
  await service.createStudentProgressLink({ assignmentId, studentRef: otherStudentRef,
    accessToken: otherAccessToken, expiresInDays: 30, reviewer, operationId: crypto.randomUUID() });
  const otherJourney = await service.getStudentCourseJourney({ accessToken: otherAccessToken });
  assert.equal(otherJourney.sessions.find(session => session.sessionNumber === 6)
    .teacherSessionFeedback, null);
  const saved = await database.query(`SELECT count(*)::int AS total FROM learning.teacher_session_feedback;`);
  assert.equal(saved.rows[0].total, 1);
  await database.query(`INSERT INTO mapping.reviewer_class_assignment (reviewer_email, class_name)
    VALUES ('assigned@example.test', '[DEMO] PROGRESS LOG · KHÓA 56');`);
  const assignedTeacher = await service.sendTeacherSessionFeedback({ ...input,
    noteText: 'Em đã duy trì mạch nói tốt hơn.', expectedRevision: 1,
    operationId: crypto.randomUUID(),
    reviewer: { email: 'assigned@example.test', canAccessAllClasses: false } });
  assert.equal(assignedTeacher.revision, 2);
  const latest = await service.getTeacherDashboard({ assignmentId, reviewer });
  assert.equal(latest.students.find(row => row.studentRef === studentRef)
    .teacherSessionFeedback.noteText, assignedTeacher.noteText);
  await database.close();
});

// Đọc bài đã nộp theo link/tên hiện có; không ghi thêm attempt, điểm danh hay job.
test('student history regression: full public questions/responses, assigned link and identity isolation', async () => {
  const {database,service}=await setupDatabase();
  try {
    const published=await service.publishReflectionForm({reviewer:{email:'teacher@example.test',canAccessAllClasses:false},
      title:'Reading 3 + Writing 1',courseCode:'course-67',classId:'2139',sessionNumber:3,opensAt:null,closesAt:null,
      items:[{libraryItemId:'10000000-0000-4000-8000-000000000001',checkpoint:1,required:true},
        {libraryItemId:'10000000-0000-4000-8000-000000000003',checkpoint:2,required:true}]});
    const assignment=await service.getPublicAssignment(published.publicToken);
    const studentRef=assignment.roster[0].studentRef,other=assignment.roster[1].studentRef;
    const input={publicToken:published.publicToken,studentRef,identityConfirmed:true,sessionNumber:3};
    await assert.rejects(()=>service.getStudentCourseSessionDetail(input),e=>e.code==='JOURNEY_SUBMISSION_NOT_READY');
    const attempt=await service.startAttempt({publicToken:published.publicToken,studentRef,identityConfirmed:true,clientIdempotencyKey:crypto.randomUUID()});
    const responses=Object.fromEntries(assignment.definition.blocks.flatMap(b=>b.items).map((i,n)=>[i.itemVersionId,'Dòng '+n+'\nTiếng Việt rất dài <script>alert(1)</script>']));
    const submissionId=crypto.randomUUID();
    await service.submit({attemptToken:attempt.attemptToken,submissionId,definitionHash:published.definitionHash,draftRevision:0,responses});
    const before=await database.query('SELECT (SELECT count(*)::int FROM learning.attempt) AS attempts,(SELECT count(*)::int FROM learning.outbox_job) AS jobs');
    const journey=await service.getStudentCourseJourney(input);
    assert.equal(journey.sessions[2].publicToken,published.publicToken);
    const detail=await service.getStudentCourseSessionDetail(input);
    assert.equal(detail.student.studentRef,studentRef);assert.equal(detail.classId,'2139');assert.equal(detail.sessionNumber,3);
    assert.deepEqual(detail.responses,responses);assert.equal(detail.definition.blocks.flatMap(b=>b.items).length,2);
    assert.equal(detail.submissionId,submissionId);assert.ok(detail.gradingItems.every(i=>!('expectedAnswer' in i)));
    await assert.rejects(()=>service.getStudentCourseSessionDetail({...input,studentRef:other}),e=>e.code==='JOURNEY_SUBMISSION_NOT_READY');
    await assert.rejects(()=>service.getStudentCourseSessionDetail({...input,studentRef:crypto.randomUUID()}),e=>e.code==='PROGRESS_LINK_INVALID');
    await assert.rejects(()=>service.getStudentCourseSessionDetail({...input,sessionNumber:99}),e=>e.code==='JOURNEY_SESSION_NOT_FOUND');
    await database.query("UPDATE learning.form_assignment SET status='closed' WHERE id=$1",[published.assignmentId]);
    assert.deepEqual((await service.getStudentCourseSessionDetail(input)).responses,responses);
    const after=await database.query('SELECT (SELECT count(*)::int FROM learning.attempt) AS attempts,(SELECT count(*)::int FROM learning.outbox_job) AS jobs');
    assert.deepEqual(after.rows,before.rows);
  } finally {await database.close();}
});
