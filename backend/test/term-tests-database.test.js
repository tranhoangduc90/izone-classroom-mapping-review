import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  completeReadingAttemptSql,
  fetchTermTestResultSql,
  findAttemptForReadingSql,
  findStudentForTermTestSql,
  insertListeningAttemptSql,
  listTermTestTeacherOptionsSql,
  listTermTestTeacherResultsSql,
  listTermTestRosterSql
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
    WHERE public_id = '00000000-0000-4000-8000-000000000005';
    INSERT INTO mapping.reviewer_account (email) VALUES ('teacher@gmail.com');
    INSERT INTO mapping.reviewer_class_access (reviewer_email, erp_course_class_id)
    VALUES ('teacher@gmail.com', 2139);
  `);
  await database.query(`
    INSERT INTO assessment.test_definition (
      slug, title, version, listening_definition, reading_definition, is_active
    ) VALUES ($1, $2, 1, $3::jsonb, $3::jsonb, true);
  `, ['term-test-1', 'Term Test 1', JSON.stringify(section)]);
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

  const attempt = await database.query(findAttemptForReadingSql, [attemptToken, 'term-test-1']);
  const reading = gradeSection(definition.reading_definition, answers, 0);
  const combined = buildCombinedResult(definition, listening, reading);
  await database.query(completeReadingAttemptSql, [
    attempt.rows[0].attempt_token,
    JSON.stringify(answers),
    JSON.stringify(reading),
    JSON.stringify(combined)
  ]);
  const result = await database.query(fetchTermTestResultSql, [attemptToken]);
  assert.equal(result.rows[0].combined_result.summary.totalCorrect, 80);

  const teacherOptions = await database.query(listTermTestTeacherOptionsSql, ['teacher@gmail.com', false]);
  assert.equal(teacherOptions.rows[0].response.classes.length, 1);
  assert.equal(teacherOptions.rows[0].response.classes[0].name, 'IC2139');

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
    JSON.stringify(answers),
    JSON.stringify(listening)
  ]);
  assert.equal(duplicate.rows[0].attempt_token, attemptToken);
  await database.close();
});
