import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createWritingTestService } from '../src/writing-tests.js';

test('ghép hai Task, hết giờ dùng 0 và sửa điểm muộn chạy an toàn trong PostgreSQL', async () => {
  const database = new PGlite();
  await database.exec(`
    CREATE ROLE mapping_review_api;
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.student_identity_mapping (
      erp_student_contact_id BIGINT PRIMARY KEY,
      google_user_id TEXT NOT NULL UNIQUE,
      erp_name_snapshot TEXT,
      google_name_snapshot TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      erp_class_name_snapshot TEXT NOT NULL,
      erp_student_name_snapshot TEXT NOT NULL,
      source_state TEXT NOT NULL,
      PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
    );
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      classroom_course_id TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE mapping.classroom_roster_snapshot (
      classroom_course_id TEXT NOT NULL,
      classroom_user_id TEXT NOT NULL,
      roster_state TEXT NOT NULL,
      PRIMARY KEY (classroom_course_id, classroom_user_id)
    );
  `);
  const migration = await readFile(
    new URL('../../docs/migrations/2026-08-10-writing-test-portal-sync.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migration);
  await database.exec(migration);
  const globalRoutingMigration = await readFile(
    new URL('../../docs/migrations/2026-08-11-writing-test-global-class-routing.sql', import.meta.url),
    'utf8'
  );
  await database.exec(globalRoutingMigration);
  await database.exec(globalRoutingMigration);
  const weightedTerm2Migration = await readFile(
    new URL('../../docs/migrations/2026-08-15-writing-term2-weighted-variant.sql', import.meta.url),
    'utf8'
  );
  await database.exec(weightedTerm2Migration);
  await database.exec(weightedTerm2Migration);
  const ic2146PortalNameMigration = await readFile(
    new URL('../../docs/migrations/2026-08-15-writing-ic2146-phase2-portal-name.sql', import.meta.url),
    'utf8'
  );
  await database.exec(ic2146PortalNameMigration);
  await database.exec(ic2146PortalNameMigration);
  await database.exec(`
    UPDATE assessment.writing_test_definition
    SET enabled = true, wait_minutes = 720
    WHERE test_key IN ('course-67-phase-2', 'course-56-term-2-weighted');
    INSERT INTO assessment.writing_test_source (
      classroom_course_id, classroom_coursework_id, test_key, component
    ) VALUES
      ('shared-writing-course', 'phase-2-task-1', 'course-67-phase-2', 'task1'),
      ('shared-writing-course', 'phase-2-task-2', 'course-67-phase-2', 'task2'),
      ('ic2146-writing-course', 'term-2-task-1', 'course-56-term-2-weighted', 'task1'),
      ('ic2146-writing-course', 'term-2-task-2', 'course-56-term-2-weighted', 'task2');
    INSERT INTO assessment.writing_test_class_scope (
      test_key, erp_course_class_id, class_name_snapshot
    ) VALUES ('course-67-phase-2', 1187, 'IC2200');
    INSERT INTO mapping.student_identity_mapping VALUES
      (9001, 'google-user-1', 'Học viên 1', 'Học viên 1', 'approved'),
      (9002, 'google-user-2', 'Học viên 2', 'Học viên 2', 'approved'),
      (9003, 'google-user-3', 'Học viên 3', 'Học viên 3', 'approved'),
      (9004, 'google-user-no-roster', 'Học viên 4', 'Học viên 4', 'approved');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES
      (1187, 9001, 'IC2200', 'Học viên 1', 'active'),
      (1187, 9002, 'IC2200', 'Học viên 2', 'active'),
      (1200, 9003, 'IC2201', 'Học viên 3', 'active'),
      (1202, 9003, 'IC2203', 'Học viên 3', 'active'),
      (1201, 9004, 'IC2202', 'Học viên 4', 'active');
    INSERT INTO mapping.classroom_course_mapping VALUES
      (1187, 'main-classroom-ic2200', 'approved'),
      (1200, 'main-classroom-ic2201', 'approved'),
      (1202, 'main-classroom-ic2203', 'approved'),
      (1201, 'main-classroom-ic2202', 'approved');
    INSERT INTO mapping.classroom_roster_snapshot VALUES
      ('main-classroom-ic2200', 'google-user-1', 'active'),
      ('main-classroom-ic2200', 'google-user-2', 'active'),
      ('main-classroom-ic2201', 'google-user-3', 'active'),
      ('main-classroom-ic2203', 'google-user-3', 'active');
    SET ROLE mapping_review_api;
  `);

  let clock = new Date('2026-08-10T03:00:00.000Z');
  const configured = await database.query(`SELECT source.*, definition.enabled AS definition_enabled
    FROM assessment.writing_test_source AS source
    JOIN assessment.writing_test_definition AS definition USING (test_key);`);
  assert.equal(configured.rows.length, 4, JSON.stringify(configured.rows));
  assert.ok(configured.rows.every(row => row.definition_enabled === true), JSON.stringify(configured.rows));
  const service = createWritingTestService({ pool: database, now: () => new Date(clock) });

  // Cùng một nguồn test dùng chung vẫn tự định tuyến được sang một lớp khác IC2200.
  const otherClass = await service.receiveScore({
    idempotencyKey: 'student-3-global-class-event',
    sourceRecordId: 'rec-student-3-task-1',
    classroomCourseId: 'shared-writing-course',
    classroomCourseworkId: 'phase-2-task-1',
    googleUserId: 'google-user-3',
    className: 'IC2201',
    score: 6.5,
    scoredAt: '2026-08-10T03:00:00.000Z'
  });
  assert.equal(otherClass.ok, true, JSON.stringify(otherClass));
  assert.equal(otherClass.record.classId, '1200');
  assert.equal(otherClass.record.className, 'IC2201');

  const ambiguousWithoutClass = await service.receiveScore({
    idempotencyKey: 'student-3-ambiguous-without-class',
    sourceRecordId: 'rec-student-3-no-class',
    classroomCourseId: 'shared-writing-course',
    classroomCourseworkId: 'phase-2-task-2',
    googleUserId: 'google-user-3',
    score: 7,
    scoredAt: '2026-08-10T03:00:00.000Z'
  });
  assert.equal(ambiguousWithoutClass.ok, false);
  assert.equal(ambiguousWithoutClass.error, 'WRITING_CLASS_AMBIGUOUS');

  // Record thử/fake dừng trước khi tạo kết quả Writing và không thể đi tới Portal.
  const fakeIdentity = await service.receiveScore({
    idempotencyKey: 'fake-student-identity-event',
    sourceRecordId: 'rec-fake-student',
    classroomCourseId: 'shared-writing-course',
    classroomCourseworkId: 'phase-2-task-1',
    googleUserId: 'google-user-fake',
    score: 7,
    scoredAt: '2026-08-10T03:00:00.000Z'
  });
  assert.deepEqual(fakeIdentity, {
    ok: false,
    status: 'identity_not_mapped',
    error: 'WRITING_IDENTITY_NOT_MAPPED'
  });
  const missingRoster = await service.receiveScore({
    idempotencyKey: 'student-without-roster-event',
    sourceRecordId: 'rec-without-roster',
    classroomCourseId: 'shared-writing-course',
    classroomCourseworkId: 'phase-2-task-1',
    googleUserId: 'google-user-no-roster',
    score: 7,
    scoredAt: '2026-08-10T03:00:00.000Z'
  });
  assert.equal(missingRoster.ok, false);
  assert.equal(missingRoster.error, 'WRITING_CLASS_NOT_FOUND');
  const fakeResultCount = await database.query(
    "SELECT count(*)::int AS total FROM assessment.writing_test_result WHERE google_user_id IN ('google-user-fake', 'google-user-no-roster');"
  );
  assert.equal(fakeResultCount.rows[0].total, 0);

  const base = {
    classroomCourseId: 'shared-writing-course',
    googleUserId: 'google-user-1',
    scoredAt: '2026-08-10T03:00:00.000Z'
  };
  const first = await service.receiveScore({
    ...base,
    idempotencyKey: 'student-1-task-1-event',
    sourceRecordId: 'rec-student-1-task-1',
    classroomCourseworkId: 'phase-2-task-1',
    score: 6
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.record.status, 'waiting');
  assert.equal(first.record.missingComponent, 'task2');
  assert.equal(new Date(first.record.expiresAt).toISOString(), '2026-08-10T15:00:00.000Z');

  const second = await service.receiveScore({
    ...base,
    idempotencyKey: 'student-1-task-2-event',
    sourceRecordId: 'rec-student-1-task-2',
    classroomCourseworkId: 'phase-2-task-2',
    score: 7
  });
  assert.equal(second.record.status, 'ready');
  assert.equal(second.record.writingOverall, 7);
  const duplicate = await service.receiveScore({
    ...base,
    idempotencyKey: 'student-1-task-2-event',
    sourceRecordId: 'rec-student-1-task-2',
    classroomCourseworkId: 'phase-2-task-2',
    score: 7
  });
  assert.equal(duplicate.status, 'duplicate');

  const term2Task1 = await service.receiveScore({
    ...base,
    idempotencyKey: 'ic2146-term-2-task-1-event',
    sourceRecordId: 'rec-ic2146-term-2-task-1',
    classroomCourseId: 'ic2146-writing-course',
    classroomCourseworkId: 'term-2-task-1',
    className: 'IC2200',
    score: 6
  });
  assert.equal(term2Task1.record.status, 'waiting');
  assert.equal(term2Task1.record.missingComponent, 'task2');
  const term2Task2 = await service.receiveScore({
    ...base,
    idempotencyKey: 'ic2146-term-2-task-2-event',
    sourceRecordId: 'rec-ic2146-term-2-task-2',
    classroomCourseId: 'ic2146-writing-course',
    classroomCourseworkId: 'term-2-task-2',
    className: 'IC2200',
    score: 7
  });
  assert.equal(term2Task2.record.status, 'ready');
  assert.equal(term2Task2.record.testKey, 'course-56-term-2-weighted');
  assert.equal(term2Task2.record.testNumber, 2);
  assert.equal(term2Task2.record.portalTestName, 'Phase 2 Writing');
  assert.equal(term2Task2.record.writingOverall, 7);

  const lateBase = {
    classroomCourseId: 'shared-writing-course',
    googleUserId: 'google-user-2',
    scoredAt: '2026-08-10T03:00:00.000Z'
  };
  const waiting = await service.receiveScore({
    ...lateBase,
    idempotencyKey: 'student-2-task-1-event',
    sourceRecordId: 'rec-student-2-task-1',
    classroomCourseworkId: 'phase-2-task-1',
    score: 6
  });
  clock = new Date('2026-08-10T16:00:00.000Z');
  await database.exec("SET TIME ZONE 'UTC';");
  await database.query("UPDATE assessment.writing_test_result SET expires_at = '2020-01-01T00:00:00Z' WHERE id = $1::uuid;", [waiting.record.id]);
  const due = await service.processDue();
  const zeroed = due.processed.find(item => item.id === waiting.record.id);
  assert.equal(zeroed.status, 'ready_zero');
  assert.equal(zeroed.writingOverall, 2);
  assert.equal(zeroed.usedZero, true);

  await service.markPortalResult({
    resultId: zeroed.id,
    expectedGrade: 2,
    success: true,
    larkRecordId: 'rec-tracking-student-2'
  });
  const late = await service.receiveScore({
    ...lateBase,
    idempotencyKey: 'student-2-task-2-late-event',
    sourceRecordId: 'rec-student-2-task-2',
    classroomCourseworkId: 'phase-2-task-2',
    score: 7,
    scoredAt: '2026-08-10T16:00:00.000Z'
  });
  assert.equal(late.record.status, 'ready_late');
  assert.equal(late.record.writingOverall, 7);
  assert.equal(late.record.lastPortalGrade, 2);
  assert.equal(late.record.allowOverwrite, true);

  const eventCount = await database.query('SELECT count(*)::int AS total FROM assessment.writing_test_event;');
  assert.equal(eventCount.rows[0].total, 10);
  await database.close();
});
