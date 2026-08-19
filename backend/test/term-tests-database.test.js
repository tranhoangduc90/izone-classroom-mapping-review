import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  completeReadingAttemptSql,
  fetchTermTestResultSql,
  findTermTestListeningSubmissionSql,
  findAttemptForReadingSql,
  findStudentForTermTestSql,
  insertProtectedListeningAttemptSql,
  insertTermTestExamSessionSql,
  insertListeningAttemptSql,
  listTermTestTeacherOptionsSql,
  listTermTestTeacherResultsSql,
  listTermTestRosterSql,
  saveReadingDraftSql,
  saveTermTestListeningDraftSql,
  saveTermTestWritingSql,
  startReadingAttemptSql,
  startTermTestListeningSessionSql
} from '../src/sql.js';
import { buildCombinedResult, gradeSection, parseStoredTest } from '../src/term-tests.js';

function makeSection() {
  return {
    questions: Array.from({ length: 40 }, (_, index) => ({
      number: index + 1,
      type: index < 20 ? 'Completion' : 'Multiple choice',
      accepted: [`answer-${index + 1}`]
    })),
    pairGroups: {}
  };
}

const mappingSchema = `
  CREATE ROLE mapping_review_api;
  CREATE SCHEMA mapping;
  CREATE TABLE mapping.classroom_course_mapping (
    erp_course_class_id BIGINT PRIMARY KEY,
    erp_class_name_snapshot TEXT NOT NULL
  );
  CREATE TABLE mapping.student_mapping_review (
    id BIGSERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    erp_course_class_id BIGINT NOT NULL,
    erp_student_contact_id BIGINT NOT NULL,
    erp_student_name_snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review'
  );
  CREATE TABLE mapping.erp_class_membership_snapshot (
    erp_course_class_id BIGINT NOT NULL,
    erp_student_contact_id BIGINT NOT NULL,
    erp_class_name_snapshot TEXT NOT NULL,
    erp_student_name_snapshot TEXT NOT NULL,
    source_state TEXT NOT NULL DEFAULT 'active',
    PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
  );
  CREATE TABLE mapping.reviewer_account (
    email TEXT PRIMARY KEY
  );
  CREATE TABLE mapping.reviewer_class_access (
    reviewer_email TEXT NOT NULL,
    erp_course_class_id BIGINT NOT NULL,
    PRIMARY KEY (reviewer_email, erp_course_class_id)
  );
  GRANT USAGE ON SCHEMA mapping TO mapping_review_api;
  GRANT SELECT ON mapping.classroom_course_mapping, mapping.student_mapping_review,
    mapping.reviewer_class_access TO mapping_review_api;
`;

test('migration và luồng Listening → Reading → Result chạy trên PostgreSQL trong RAM', async () => {
  const database = new PGlite();
  await database.exec(mappingSchema);
  const migrationUrl = new URL('../../docs/migrations/2026-08-06-term-test-submissions.sql', import.meta.url);
  const migrationSql = await readFile(migrationUrl, 'utf8');
  await database.exec(migrationSql);
  await database.exec(migrationSql);
  const writingDraftMigration = await readFile(
    new URL('../../docs/migrations/2026-08-19-term-test-writing-drafts.sql', import.meta.url),
    'utf8'
  );
  await database.exec(writingDraftMigration);
  await database.exec(writingDraftMigration);
  const examControlsMigration = await readFile(
    new URL('../../docs/migrations/2026-08-19-term-test-exam-controls.sql', import.meta.url),
    'utf8'
  );
  await database.exec(examControlsMigration);
  await database.exec(examControlsMigration);
  const miniResultMigration = await readFile(
    new URL('../../docs/migrations/2026-08-09-mini-test-results.sql', import.meta.url),
    'utf8'
  );
  await database.exec(miniResultMigration);
  const miniWebMigration = await readFile(
    new URL('../../docs/migrations/2026-08-09-mini-test-web.sql', import.meta.url),
    'utf8'
  );
  await database.exec(miniWebMigration);
  await database.exec(miniWebMigration);

  const section = makeSection();
  await database.exec(`
    INSERT INTO mapping.classroom_course_mapping (erp_course_class_id, erp_class_name_snapshot)
    VALUES (2139, 'IC2139'), (9999, 'IC9999');
    INSERT INTO mapping.student_mapping_review (
      public_id, erp_course_class_id, erp_student_contact_id, erp_student_name_snapshot
    ) VALUES
      ('00000000-0000-4000-8000-000000000001', 2139, 9001, 'Học viên trong roster riêng'),
      ('00000000-0000-4000-8000-000000000003', 2139, 9002, 'Học viên thừa trong matching'),
      ('00000000-0000-4000-8000-000000000004', 9999, 9901, 'Học viên lấy từ matching'),
      ('00000000-0000-4000-8000-000000000005', 9999, 9902, 'Học viên đã supersede');
    UPDATE mapping.student_mapping_review
    SET status = 'superseded'
    WHERE public_id IN (
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000005'
    );
    INSERT INTO mapping.reviewer_account (email) VALUES ('teacher@gmail.com');
    INSERT INTO mapping.reviewer_class_access (reviewer_email, erp_course_class_id)
    VALUES ('teacher@gmail.com', 2139);
  `);
  await database.query(`
    INSERT INTO assessment.test_definition (
      slug, title, version, listening_definition, reading_definition, is_active
    ) VALUES ($1, $2, 1, $3::jsonb, $3::jsonb, true);
  `, ['term-test-1', 'Term Test 1', JSON.stringify(section)]);
  const miniListeningSection = {
    questions: Array.from({ length: 20 }, (_, index) => ({
      number: index + 11,
      type: 'Listening',
      accepted: [`listen-${index + 11}`]
    })),
    pairGroups: {}
  };
  const miniReadingSection = {
    questions: Array.from({ length: 13 }, (_, index) => ({
      number: index + 14,
      type: 'Reading',
      accepted: [`read-${index + 14}`]
    })),
    pairGroups: {}
  };
  await database.query(`
    INSERT INTO assessment.test_definition (
      slug, title, version, listening_definition, reading_definition, is_active
    ) VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, true);
  `, [
    'mini-test-lesson-5',
    'Mini Test Buổi 5',
    JSON.stringify(miniListeningSection),
    JSON.stringify(miniReadingSection)
  ]);
  await database.query(`
    INSERT INTO assessment.mini_test_result (
      source_submission_key, test_slug, erp_course_class_id, class_name_snapshot,
      erp_student_contact_id, student_name_snapshot, listening_correct, reading_correct, result
    ) VALUES
      ($1, $2, 2139, 'IC2139', 9001, 'Học viên trong roster riêng', 15, 9, $3::jsonb),
      ($4, $2, 2139, 'IC2139', 9002, 'Học viên có kết quả cũ', 15, 9, $3::jsonb);
  `, [
    'a'.repeat(64),
    'mini-test-lesson-5',
    JSON.stringify({
      testSlug: 'mini-test-lesson-5',
      listening: { correct: 15, total: 20, band: 7 },
      reading: { correct: 9, total: 13, band: 7 },
      summary: { totalCorrect: 24, totalQuestions: 33, averageBand: 7 },
      typeStats: [],
      performance: { best: [], needsImprovement: [], other: [] }
    }),
    'b'.repeat(64)
  ]);
  await database.exec(`
    INSERT INTO assessment.term_test_roster (
      test_slug, erp_course_class_id, erp_student_contact_id, student_ref, student_name_snapshot
    ) VALUES
      ('term-test-1', 2139, 9001, '00000000-0000-4000-8000-000000000001', 'Học viên trong roster riêng'),
      ('term-test-1', 2139, 9003, '00000000-0000-4000-8000-000000000006', 'Học viên chưa làm');
  `);

  // Từ đây chạy đúng bằng quyền của API production để bắt lỗi GRANT trước khi deploy.
  await database.exec('SET ROLE mapping_review_api;');

  const roster = await database.query(listTermTestRosterSql, ['IC2139', 'term-test-1']);
  assert.equal(roster.rows[0].students.length, 2);
  assert.deepEqual(
    roster.rows[0].students.map(studentRow => studentRow.name).sort(),
    ['Học viên chưa làm', 'Học viên trong roster riêng'].sort()
  );

  const fallbackRoster = await database.query(listTermTestRosterSql, ['IC9999', 'term-test-1']);
  assert.equal(fallbackRoster.rows[0].students.length, 1);
  assert.equal(fallbackRoster.rows[0].students[0].name, 'Học viên lấy từ matching');

  const student = await database.query(findStudentForTermTestSql, [
    'IC2139',
    'term-test-1',
    '00000000-0000-4000-8000-000000000001'
  ]);
  assert.equal(student.rows.length, 1);

  const fallbackStudent = await database.query(findStudentForTermTestSql, [
    'IC9999',
    'term-test-1',
    '00000000-0000-4000-8000-000000000004'
  ]);
  assert.equal(fallbackStudent.rows.length, 1);
  assert.equal(fallbackStudent.rows[0].student_id, '9901');
  assert.equal(fallbackStudent.rows[0].student_name, 'Học viên lấy từ matching');
  const definition = parseStoredTest(student.rows[0]);
  const answers = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
    String(index + 1),
    `answer-${index + 1}`
  ]));
  const listening = gradeSection(definition.listening_definition, answers, 0);

  const inserted = await database.query(insertListeningAttemptSql, [
    '00000000-0000-4000-8000-000000000002',
    'term-test-1',
    1,
    2139,
    'IC2139',
    9001,
    'Học viên thử nghiệm',
    JSON.stringify(answers),
    JSON.stringify(listening)
  ]);
  const attemptToken = inserted.rows[0].attempt_token;
  assert.match(attemptToken, /^[0-9a-f-]{36}$/);
  assert.equal(inserted.rows[0].listening_result.correct, 40);

  const listeningOnlyResult = await database.query(fetchTermTestResultSql, [attemptToken]);
  assert.equal(listeningOnlyResult.rows.length, 1);
  assert.equal(listeningOnlyResult.rows[0].listening_result.band, 9);
  assert.equal(listeningOnlyResult.rows[0].combined_result, null);
  assert.equal(listeningOnlyResult.rows[0].completed_at, null);

  const attempt = await database.query(findAttemptForReadingSql, [attemptToken, 'term-test-1']);
  const reading = gradeSection(definition.reading_definition, answers, 0);
  const combined = buildCombinedResult(definition, listening, reading);
  await database.query(completeReadingAttemptSql, [
    attempt.rows[0].attempt_token,
    JSON.stringify(answers),
    JSON.stringify(reading),
    JSON.stringify(combined)
  ]);
  const draft = await database.query(saveTermTestWritingSql, [
    attemptToken,
    'Bản nháp Task 1',
    'Bản nháp Task 2',
    'draft'
  ]);
  assert.equal(draft.rows[0].writing_task_1, 'Bản nháp Task 1');
  assert.equal(Boolean(draft.rows[0].writing_started_at), true);
  assert.equal(draft.rows[0].writing_submitted_at, null);

  const submittedWriting = await database.query(saveTermTestWritingSql, [
    attemptToken,
    'Bài nộp Task 1',
    'Bài nộp Task 2',
    'submit'
  ]);
  assert.equal(Boolean(submittedWriting.rows[0].writing_submitted_at), true);

  const duplicateWriting = await database.query(saveTermTestWritingSql, [
    attemptToken,
    'Không được ghi đè Task 1',
    'Không được ghi đè Task 2',
    'submit'
  ]);
  assert.equal(duplicateWriting.rows[0].writing_task_1, 'Bài nộp Task 1');
  assert.equal(duplicateWriting.rows[0].writing_task_2, 'Bài nộp Task 2');

  const result = await database.query(fetchTermTestResultSql, [attemptToken]);
  assert.equal(result.rows[0].combined_result.summary.totalCorrect, 80);
  assert.equal(result.rows[0].writing_task_1, 'Bài nộp Task 1');
  assert.equal(Boolean(result.rows[0].writing_submitted_at), true);

  const teacherOptions = await database.query(listTermTestTeacherOptionsSql, ['teacher@gmail.com', false]);
  assert.equal(teacherOptions.rows[0].response.classes.length, 1);
  assert.equal(teacherOptions.rows[0].response.classes[0].name, 'IC2139');
  assert.equal(teacherOptions.rows[0].response.tests.length, 2);

  const teacherResults = await database.query(listTermTestTeacherResultsSql, [
    'IC2139',
    'term-test-1',
    'teacher@gmail.com',
    false
  ]);
  assert.equal(teacherResults.rows[0].authorized_class_count, 1);
  assert.equal(teacherResults.rows[0].students.length, 2);
  assert.equal(teacherResults.rows[0].students.find(item => item.name === 'Học viên trong roster riêng').status, 'completed');
  assert.equal(teacherResults.rows[0].students.find(item => item.name === 'Học viên chưa làm').status, 'not_started');

  const miniTeacherResults = await database.query(listTermTestTeacherResultsSql, [
    'IC2139',
    'mini-test-lesson-5',
    'teacher@gmail.com',
    false
  ]);
  const legacyStudent = miniTeacherResults.rows[0].students.find(item => item.name === 'Học viên trong roster riêng');
  assert.equal(legacyStudent.status, 'completed');
  assert.equal(legacyStudent.result.testTitle, 'Mini Test Buổi 5');
  assert.equal(legacyStudent.result.summary.averageBand, 7);
  assert.equal(
    miniTeacherResults.rows[0].students.find(item => item.name === 'Học viên có kết quả cũ').status,
    'completed'
  );

  const deniedResults = await database.query(listTermTestTeacherResultsSql, [
    'IC2139',
    'term-test-1',
    'other@gmail.com',
    false
  ]);
  assert.equal(deniedResults.rows[0].authorized_class_count, 0);
  assert.deepEqual(deniedResults.rows[0].students, []);

  const duplicate = await database.query(insertListeningAttemptSql, [
    '00000000-0000-4000-8000-000000000002',
    'term-test-1',
    1,
    2139,
    'IC2139',
    9001,
    'Học viên thử nghiệm',
    JSON.stringify({}),
    JSON.stringify(gradeSection(definition.listening_definition, {}, 0))
  ]);
  assert.equal(duplicate.rows[0].attempt_token, attemptToken);
  assert.equal(duplicate.rows[0].listening_result.correct, 40);

  const protectedSession = await database.query(insertTermTestExamSessionSql, [
    'term-test-1', 1, 2139, 'IC2139', 9003, 'Học viên chưa làm', 0
  ]);
  const examSessionToken = protectedSession.rows[0].exam_session_token;
  await database.query(startTermTestListeningSessionSql, [examSessionToken, 'term-test-1', 200]);
  const protectedDraft = await database.query(saveTermTestListeningDraftSql, [
    examSessionToken, 'term-test-1', JSON.stringify(answers)
  ]);
  assert.equal(protectedDraft.rows.length, 1);
  await database.query(
    `UPDATE assessment.term_test_exam_session
     SET listening_started_at = now() - interval '10 seconds', listening_deadline_at = now() - interval '1 second'
     WHERE id = $1::uuid`,
    [examSessionToken]
  );
  const rejectedLateListening = await database.query(saveTermTestListeningDraftSql, [
    examSessionToken, 'term-test-1', JSON.stringify({ 1: 'late-change' })
  ]);
  assert.equal(rejectedLateListening.rows.length, 0);
  const lockedListening = await database.query(findTermTestListeningSubmissionSql, [examSessionToken, 'term-test-1']);
  assert.equal(lockedListening.rows[0].listening_timed_out, true);
  assert.equal(lockedListening.rows[0].listening_draft['1'], 'answer-1');
  const protectedListeningResult = gradeSection(definition.listening_definition, lockedListening.rows[0].listening_draft, 0);
  const protectedAttempt = await database.query(insertProtectedListeningAttemptSql, [
    '00000000-0000-4000-8000-000000000007',
    examSessionToken,
    'term-test-1',
    JSON.stringify(lockedListening.rows[0].listening_draft),
    JSON.stringify(protectedListeningResult)
  ]);
  assert.equal(protectedAttempt.rows[0].exam_session_token, examSessionToken);
  assert.equal(protectedAttempt.rows[0].listening_result.correct, 40);

  const protectedAttemptToken = protectedAttempt.rows[0].attempt_token;
  await database.query(startReadingAttemptSql, [protectedAttemptToken, 'term-test-1']);
  assert.equal((await database.query(saveReadingDraftSql, [protectedAttemptToken, JSON.stringify(answers)])).rows.length, 1);
  await database.query(
    `UPDATE assessment.term_test_attempt
     SET reading_started_at = now() - interval '10 seconds', reading_deadline_at = now() - interval '1 second'
     WHERE id = $1::uuid`,
    [protectedAttemptToken]
  );
  assert.equal((await database.query(saveReadingDraftSql, [protectedAttemptToken, JSON.stringify({ 1: 'late-change' })])).rows.length, 0);
  const lockedReading = await database.query(findAttemptForReadingSql, [protectedAttemptToken, 'term-test-1']);
  assert.equal(lockedReading.rows[0].reading_timed_out, true);
  assert.equal(lockedReading.rows[0].reading_draft['1'], 'answer-1');
  const protectedReadingResult = gradeSection(definition.reading_definition, lockedReading.rows[0].reading_draft, 0);
  const protectedCombined = buildCombinedResult(definition, protectedListeningResult, protectedReadingResult);
  await database.query(completeReadingAttemptSql, [
    protectedAttemptToken,
    JSON.stringify(lockedReading.rows[0].reading_draft),
    JSON.stringify(protectedReadingResult),
    JSON.stringify(protectedCombined)
  ]);
  const protectedWritingDraft = await database.query(saveTermTestWritingSql, [
    protectedAttemptToken, 'Task 1 đúng hạn', 'Task 2 đúng hạn', 'draft'
  ]);
  assert.equal(protectedWritingDraft.rows[0].writing_task_1, 'Task 1 đúng hạn');
  await database.query(
    `UPDATE assessment.term_test_attempt SET writing_deadline_at = now() - interval '1 second' WHERE id = $1::uuid`,
    [protectedAttemptToken]
  );
  const lateWritingSubmit = await database.query(saveTermTestWritingSql, [
    protectedAttemptToken, 'Task 1 sửa muộn', 'Task 2 sửa muộn', 'submit'
  ]);
  assert.equal(lateWritingSubmit.rows[0].writing_task_1, 'Task 1 đúng hạn');
  assert.equal(lateWritingSubmit.rows[0].writing_task_2, 'Task 2 đúng hạn');
  assert.equal(lateWritingSubmit.rows[0].writing_timed_out, true);
  assert.equal(Boolean(lateWritingSubmit.rows[0].writing_submitted_at), true);
  await database.close();
});
