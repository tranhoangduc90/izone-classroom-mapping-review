import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('migration tạo schema K56 đủ cấu trúc mà không đổi bảng bài thi K67', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE SCHEMA mapping;
      CREATE SCHEMA assessment;
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id BIGINT PRIMARY KEY,
        erp_class_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE mapping.erp_class_membership_snapshot (
        erp_course_class_id BIGINT NOT NULL,
        erp_student_contact_id BIGINT NOT NULL,
        erp_student_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE mapping.student_mapping_review (
        public_id UUID, erp_course_class_id BIGINT,
        erp_student_contact_id BIGINT, status TEXT
      );
      CREATE TABLE assessment.test_definition (slug TEXT PRIMARY KEY);
      INSERT INTO assessment.test_definition VALUES ('term-test-1');
    `);
    const migration = await readFile(new URL(
      '../ops/migrations/202609240003_k56_assessment_schema.sql', import.meta.url),
    'utf8');
    assert.match(migration, /CREATE SCHEMA assessment_k56;/);
    assert.doesNotMatch(migration, /CREATE SCHEMA assessment;/);
    await database.exec(migration);
    const tables = await database.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'assessment_k56' ORDER BY table_name`);
    assert.equal(tables.rows.length, 14);
    const views = await database.query(`SELECT table_name FROM information_schema.views
      WHERE table_schema = 'assessment_k56'`);
    assert.deepEqual(views.rows, [{ table_name: 'mini_test_student_lookup' }]);
    const functionExists = await database.query(`SELECT to_regprocedure(
      'assessment_k56.reset_demo_term_test_student(text,text,uuid)') IS NOT NULL AS exists`);
    assert.equal(functionExists.rows[0].exists, true);
    const k56Roster = await database.query(`SELECT count(*)::int AS rows
      FROM assessment_k56.term_test_roster`);
    assert.equal(k56Roster.rows[0].rows, 0);
    const k67Definition = await database.query('SELECT slug FROM assessment.test_definition');
    assert.deepEqual(k67Definition.rows, [{ slug: 'term-test-1' }]);
    await assert.rejects(database.exec(migration), /already exists/);
    await database.exec('ROLLBACK;');
    assert.deepEqual((await database.query('SELECT slug FROM assessment.test_definition')).rows,
      [{ slug: 'term-test-1' }]);
  } finally {
    await database.close();
  }
});

test('cổng K56 mặc định đóng; IC2322 và IC2326 mở được không cần Classroom', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE SCHEMA mapping;
      CREATE SCHEMA assessment;
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id BIGINT PRIMARY KEY,
        erp_class_name_snapshot TEXT NOT NULL,
        classroom_course_id TEXT
      );
      CREATE TABLE mapping.erp_class_membership_snapshot (
        erp_course_class_id BIGINT NOT NULL,
        erp_student_contact_id BIGINT NOT NULL,
        erp_student_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE mapping.student_mapping_review (
        public_id UUID, erp_course_class_id BIGINT,
        erp_student_contact_id BIGINT, status TEXT
      );
      CREATE TABLE assessment.test_definition (slug TEXT PRIMARY KEY);
      INSERT INTO assessment.test_definition VALUES ('term-test-1');
      INSERT INTO mapping.classroom_course_mapping VALUES
        (2322, 'IC2322', NULL), (2326, 'IC2326', NULL);
    `);
    for (const migrationName of [
      '202609240003_k56_assessment_schema.sql',
      '202609240004_k56_roster_eligibility.sql',
      '202609240005_k56_class_access.sql'
    ]) {
      const migration = await readFile(new URL(`../ops/migrations/${migrationName}`, import.meta.url), 'utf8');
      await database.exec(migration);
    }
    await database.exec(`INSERT INTO assessment_k56.test_definition
      (slug, title, version, listening_definition, reading_definition)
      VALUES ('term-test-1-k56', 'Term 1 K56', 1, '{}'::jsonb, '{}'::jsonb);`);
    assert.equal((await database.query(`SELECT count(*)::int AS count
      FROM assessment_k56.term_test_class_access`)).rows[0].count, 0);
    await database.exec(`INSERT INTO assessment_k56.term_test_class_access
      (test_slug, erp_course_class_id, source) VALUES
      ('term-test-1-k56', 2322, 'erp_on_going'),
      ('term-test-1-k56', 2326, 'erp_on_going');`);
    assert.deepEqual((await database.query(`SELECT erp_course_class_id::int AS id, enabled
      FROM assessment_k56.term_test_class_access ORDER BY erp_course_class_id`)).rows,
    [{ id: 2322, enabled: false }, { id: 2326, enabled: false }]);
    await database.exec(`UPDATE assessment_k56.term_test_class_access
      SET enabled = true WHERE erp_course_class_id IN (2322, 2326);`);
    assert.deepEqual((await database.query(`SELECT erp_course_class_id::int AS id
      FROM assessment_k56.term_test_class_access WHERE enabled ORDER BY erp_course_class_id`)).rows,
    [{ id: 2322 }, { id: 2326 }]);
    assert.deepEqual((await database.query('SELECT slug FROM assessment.test_definition')).rows,
      [{ slug: 'term-test-1' }]);
    for (const migrationName of [
      '202609240004_k56_roster_eligibility.sql',
      '202609240005_k56_class_access.sql'
    ]) {
      const migration = await readFile(new URL(`../ops/migrations/${migrationName}`, import.meta.url), 'utf8');
      await database.exec(migration);
    }
    assert.equal((await database.query(`SELECT count(*)::int AS count
      FROM assessment_k56.term_test_class_access WHERE enabled`)).rows[0].count, 2);
  } finally {
    await database.close();
  }
});

test('role API K56 đọc mapping và đề K56 nhưng bị chặn schema bài K67', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE ROLE k56_shared_api;
      CREATE ROLE mapping_review_api;
      CREATE SCHEMA mapping;
      CREATE SCHEMA assessment;
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id BIGINT PRIMARY KEY,
        erp_class_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE mapping.erp_class_membership_snapshot (
        erp_course_class_id BIGINT, erp_student_contact_id BIGINT,
        erp_student_name_snapshot TEXT
      );
      CREATE TABLE mapping.student_mapping_review (
        public_id UUID, erp_course_class_id BIGINT,
        erp_student_contact_id BIGINT, status TEXT
      );
      CREATE TABLE assessment.test_definition (slug TEXT PRIMARY KEY);
      INSERT INTO assessment.test_definition VALUES ('term-test-1');
      GRANT USAGE ON SCHEMA assessment TO mapping_review_api;
      GRANT SELECT ON assessment.test_definition TO mapping_review_api;
    `);
    for (const name of [
      'classroom_roster_snapshot', 'lark_replica_run', 'reviewer_class_access',
      'reviewer_class_assignment', 'sync_run', 'mapping_decision_event',
      'reviewer_account', 'reviewer_session', 'student_identity_mapping'
    ]) {
      await database.exec(`CREATE TABLE mapping.${name} (id BIGINT);`);
    }
    for (const migrationName of [
      '202609240003_k56_assessment_schema.sql',
      '202609240004_k56_roster_eligibility.sql',
      '202609240005_k56_class_access.sql',
      '202609240006_k56_shared_api_grants.sql'
    ]) {
      const migration = await readFile(new URL(`../ops/migrations/${migrationName}`, import.meta.url), 'utf8');
      await database.exec(migration);
    }
    await database.exec(`INSERT INTO assessment_k56.test_definition
      (slug, title, version, listening_definition, reading_definition)
      VALUES ('term-test-1-k56', 'Term 1 K56', 1, '{}'::jsonb, '{}'::jsonb);
      SET ROLE k56_shared_api;`);
    assert.deepEqual((await database.query(`SELECT slug FROM assessment_k56.test_definition`)).rows,
      [{ slug: 'term-test-1-k56' }]);
    assert.deepEqual((await database.query(`SELECT * FROM mapping.classroom_course_mapping`)).rows,
      []);
    await assert.rejects(database.query(`SELECT slug FROM assessment.test_definition`),
      /permission denied/);
    await database.exec('RESET ROLE;');
    assert.deepEqual((await database.query('SELECT slug FROM assessment.test_definition')).rows,
      [{ slug: 'term-test-1' }]);
    await database.exec('SET ROLE mapping_review_api;');
    assert.deepEqual((await database.query('SELECT slug FROM assessment.test_definition')).rows,
      [{ slug: 'term-test-1' }]);
    await assert.rejects(database.query('SELECT slug FROM assessment_k56.test_definition'),
      /permission denied/);
  } finally {
    await database.close();
  }
});
