import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { findStudentForMiniTestSql, upsertMiniTestResultSql } from '../src/sql.js';
import { buildMiniTestResult } from '../src/mini-tests.js';

test('migration Mini Test và upsert chống trùng chạy trên PostgreSQL trong RAM', async () => {
  const database = new PGlite();
  await database.exec(`
    CREATE ROLE mapping_review_api;
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      erp_class_name_snapshot TEXT NOT NULL,
      erp_student_name_snapshot TEXT NOT NULL,
      source_state TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
    );
  `);
  const migrationUrl = new URL('../../docs/migrations/2026-08-09-mini-test-results.sql', import.meta.url);
  const migrationSql = await readFile(migrationUrl, 'utf8');
  await database.exec(migrationSql);
  await database.exec(migrationSql);
  await database.exec(`
    INSERT INTO mapping.classroom_course_mapping VALUES (1187, 'IC2200');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES
      (1187, 9001, 'IC2200', 'Học viên thử nghiệm', 'missing');
    SET ROLE mapping_review_api;
  `);

  const student = await database.query(findStudentForMiniTestSql, ['ic2200', '  Học viên   thử nghiệm ']);
  assert.equal(student.rows.length, 1);
  assert.equal(student.rows[0].student_id, '9001');

  const firstResult = buildMiniTestResult({
    testSlug: 'mini-test-lesson-5',
    listeningCorrect: 15,
    readingCorrect: 9,
    typeStats: [
      { type: 'Listening', correct: 15, total: 20 },
      { type: 'Reading', correct: 9, total: 13 }
    ]
  });
  const params = [
    'a'.repeat(64), 'mini-test-lesson-5', 1187, 'IC2200', 9001, 'Học viên thử nghiệm',
    '01/01/2026 09:00:00', 15, 9, JSON.stringify(firstResult)
  ];
  await database.query(upsertMiniTestResultSql, params);
  params[7] = 16;
  params[9] = JSON.stringify({ ...firstResult, listening: { ...firstResult.listening, correct: 16 } });
  await database.query(upsertMiniTestResultSql, params);

  const saved = await database.query('SELECT listening_correct, count(*) OVER ()::int AS total FROM assessment.mini_test_result;');
  assert.equal(saved.rows.length, 1);
  assert.equal(saved.rows[0].listening_correct, 16);
  assert.equal(saved.rows[0].total, 1);
  await database.close();
});
