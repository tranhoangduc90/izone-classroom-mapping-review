import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { authorizeLearningSessionFeedbackTargetSql } from '../src/learning-sql.js';

test('API khóa đúng phiếu để gửi nhận xét với quyền production tối thiểu', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE ROLE learning_api;
      CREATE SCHEMA learning;
      CREATE SCHEMA mapping;
      CREATE TABLE learning.form_assignment (
        id uuid PRIMARY KEY, erp_course_class_id bigint NOT NULL,
        status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE learning.form_assignment_roster (
        assignment_id uuid NOT NULL, student_ref uuid NOT NULL,
        PRIMARY KEY (assignment_id, student_ref)
      );
      CREATE TABLE mapping.reviewer_class_access (
        reviewer_email text, erp_course_class_id bigint
      );
      CREATE TABLE mapping.reviewer_class_assignment (
        reviewer_email text, class_name text
      );
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id bigint, erp_class_name_snapshot text
      );
      INSERT INTO learning.form_assignment VALUES
        ('70000000-0000-4000-8000-000000000001',1294,'published',now());
      INSERT INTO learning.form_assignment_roster VALUES
        ('70000000-0000-4000-8000-000000000001',
         '70000000-0000-4000-8000-000000000002');
      INSERT INTO mapping.reviewer_class_access VALUES ('teacher@example.test',1294);
      GRANT USAGE ON SCHEMA learning,mapping TO learning_api;
      GRANT SELECT ON ALL TABLES IN SCHEMA learning,mapping TO learning_api;
      GRANT UPDATE (status,updated_at) ON learning.form_assignment TO learning_api;
    `);
    await database.exec('BEGIN; SET LOCAL ROLE learning_api;');
    const result = await database.query(authorizeLearningSessionFeedbackTargetSql, [
      '70000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000002',
      'teacher@example.test', false
    ]);
    assert.equal(result.rows.length, 1);
    await database.exec('ROLLBACK;');
  } finally {
    await database.close();
  }
});
