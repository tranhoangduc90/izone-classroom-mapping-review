import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAssessmentSchemaPool, scopeAssessmentQuery } from '../src/assessment-schema-pool.js';
import { resolveDeploymentProfile } from '../src/deployment-profile.js';
import { listTermTestRosterSql } from '../src/sql.js';

test('K56 đổi đúng schema bài thi, giữ mapping và không sửa query config gốc', () => {
  const original = { text: `SELECT * FROM assessment.term_test_attempt
    JOIN mapping.classroom_course_mapping USING (erp_course_class_id)`, values: [1] };
  const scoped = scopeAssessmentQuery(original);
  assert.match(scoped.text, /assessment_k56\.term_test_attempt/);
  assert.match(scoped.text, /mapping\.classroom_course_mapping/);
  assert.equal(original.text.includes('assessment_k56'), false);
  assert.deepEqual(scoped.values, [1]);
  assert.equal(scopeAssessmentQuery(scoped.text), scoped.text);
  assert.throws(() => scopeAssessmentQuery({ values: [1] }), TypeError);
});

test('profile K67 giữ pool nguyên bản; K56 định tuyến cả query và transaction', async () => {
  const seen = [];
  const client = {
    query(input) { seen.push(['client', input]); return Promise.resolve({ rows: [] }); },
    release() { seen.push(['release']); }
  };
  const raw = {
    query(input) { seen.push(['pool', input]); return Promise.resolve({ rows: [] }); },
    connect() { return Promise.resolve(client); },
    end() { seen.push(['end']); return Promise.resolve(); }
  };
  assert.equal(createAssessmentSchemaPool(raw, resolveDeploymentProfile('k67')), raw);
  const k56 = createAssessmentSchemaPool(raw, resolveDeploymentProfile('k56-ic2264'));
  await k56.query('SELECT * FROM assessment.test_definition');
  const transaction = await k56.connect();
  await transaction.query('BEGIN');
  await transaction.query('INSERT INTO assessment.term_test_attempt DEFAULT VALUES');
  await transaction.query('ROLLBACK');
  transaction.release();
  await k56.end();
  assert.deepEqual(seen, [
    ['pool', 'SELECT * FROM assessment_k56.test_definition'],
    ['client', 'BEGIN'],
    ['client', 'INSERT INTO assessment_k56.term_test_attempt DEFAULT VALUES'],
    ['client', 'ROLLBACK'],
    ['release'], ['end']
  ]);
});

test('một database: role K56 chỉ đọc schema K56, K67 không bị đổi', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE ROLE k56_api;
      CREATE SCHEMA assessment;
      CREATE SCHEMA assessment_k56;
      CREATE SCHEMA mapping;
      CREATE TABLE assessment.test_definition (slug TEXT PRIMARY KEY);
      CREATE TABLE assessment_k56.test_definition (slug TEXT PRIMARY KEY);
      CREATE TABLE mapping.classroom_course_mapping (erp_course_class_id BIGINT PRIMARY KEY);
      INSERT INTO assessment.test_definition VALUES ('term-test-1');
      INSERT INTO assessment_k56.test_definition VALUES ('term-test-1-k56');
      GRANT USAGE ON SCHEMA assessment_k56, mapping TO k56_api;
      GRANT SELECT ON assessment_k56.test_definition TO k56_api;
      GRANT SELECT ON mapping.classroom_course_mapping TO k56_api;
    `);
    const k67 = createAssessmentSchemaPool(database, resolveDeploymentProfile('k67'));
    const k56 = createAssessmentSchemaPool(database, resolveDeploymentProfile('k56-ic2264'));
    assert.deepEqual((await k67.query('SELECT slug FROM assessment.test_definition')).rows,
      [{ slug: 'term-test-1' }]);
    await database.exec('SET ROLE k56_api;');
    assert.deepEqual((await k56.query('SELECT slug FROM assessment.test_definition')).rows,
      [{ slug: 'term-test-1-k56' }]);
    assert.deepEqual((await k56.query('SELECT * FROM mapping.classroom_course_mapping')).rows, []);
    await assert.rejects(database.query('SELECT slug FROM assessment.test_definition'),
      /permission denied/);
    await database.exec('RESET ROLE;');
  } finally {
    await database.close();
  }
});

test('hai bộ đề cùng database vẫn trả đúng roster và quyền theo từng schema', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE SCHEMA mapping;
      CREATE SCHEMA assessment;
      CREATE SCHEMA assessment_k56;
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id BIGINT PRIMARY KEY,
        erp_class_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE mapping.student_mapping_review (
        public_id UUID NOT NULL, erp_course_class_id BIGINT NOT NULL,
        erp_student_contact_id BIGINT NOT NULL,
        erp_student_name_snapshot TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE assessment.test_definition (
        slug TEXT PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true
      );
      CREATE TABLE assessment_k56.test_definition (
        LIKE assessment.test_definition INCLUDING ALL
      );
      CREATE TABLE assessment.term_test_roster (
        test_slug TEXT NOT NULL, erp_course_class_id BIGINT NOT NULL,
        erp_student_contact_id BIGINT NOT NULL, student_ref UUID NOT NULL,
        student_name_snapshot TEXT NOT NULL, is_eligible BOOLEAN NOT NULL DEFAULT true
      );
      CREATE TABLE assessment_k56.term_test_roster (
        LIKE assessment.term_test_roster INCLUDING ALL
      );
      CREATE TABLE assessment.term_test_class_access (
        test_slug TEXT NOT NULL, erp_course_class_id BIGINT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE assessment_k56.term_test_class_access (
        LIKE assessment.term_test_class_access INCLUDING ALL
      );
      INSERT INTO mapping.classroom_course_mapping VALUES
        (1252, 'IC2264'), (2207, 'IC2207'), (2322, 'IC2322');
      INSERT INTO assessment.test_definition VALUES
        ('term-test-1', 'Term K67', 1, true);
      INSERT INTO assessment_k56.test_definition VALUES
        ('term-test-1-k56', 'Term K56', 1, true);
      INSERT INTO assessment.term_test_roster VALUES
        ('term-test-1', 2207, 67,
         '00000000-0000-4000-8000-000000000067', 'Học viên K67', true);
      INSERT INTO assessment_k56.term_test_roster VALUES
        ('term-test-1-k56', 1252, 56,
         '00000000-0000-4000-8000-000000000056', 'Học viên K56', true);
      INSERT INTO assessment_k56.term_test_class_access VALUES
        ('term-test-1-k56', 1252, true);
    `);
    const k56 = createAssessmentSchemaPool(database, resolveDeploymentProfile('k56-ic2264'));
    const k67 = createAssessmentSchemaPool(database, resolveDeploymentProfile('k67'));
    const k56Roster = await k56.query(listTermTestRosterSql, ['IC2264', 'term-test-1-k56']);
    assert.equal(k56Roster.rows[0].class_count, 1);
    assert.deepEqual(k56Roster.rows[0].students.map(row => row.ref),
      ['00000000-0000-4000-8000-000000000056']);
    const k67Roster = await k67.query(listTermTestRosterSql, ['IC2207', 'term-test-1']);
    assert.equal(k67Roster.rows[0].class_count, 1);
    assert.deepEqual(k67Roster.rows[0].students.map(row => row.ref),
      ['00000000-0000-4000-8000-000000000067']);
    const k56Denied = await k56.query(listTermTestRosterSql, ['IC2322', 'term-test-1-k56']);
    assert.equal(k56Denied.rows[0].class_count, 0);
    assert.deepEqual(k56Denied.rows[0].students, []);
  } finally {
    await database.close();
  }
});
