import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  findStudentForTermTestSql,
  listTermTestRosterSql,
  registerTemporaryTermTestStudentSql
} from '../src/sql.js';

// Dữ liệu vào: lớp có mapping nhưng chỉ một cặp lớp–đề K56 được cấp quyền.
// Việc chính: chạy ba đường vào bài với quyền API thật trong PostgreSQL thử nghiệm.
// Kết quả: lớp K56 chưa duyệt bị đóng; K67 và lớp K56 đã duyệt giữ hành vi cũ.
// Khi lỗi: test chỉ rõ đường roster, xác minh học viên hoặc đăng ký Mini bị hở.
test('K56 chỉ mở đúng cặp lớp–đề đã được duyệt trên cả ba đường vào', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE ROLE mapping_review_api;
      CREATE SCHEMA mapping;
      CREATE SCHEMA assessment;
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id BIGINT PRIMARY KEY,
        erp_class_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE mapping.student_mapping_review (
        public_id UUID PRIMARY KEY,
        erp_course_class_id BIGINT NOT NULL,
        erp_student_contact_id BIGINT NOT NULL,
        erp_student_name_snapshot TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE assessment.test_definition (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        listening_band_adjustment NUMERIC NOT NULL DEFAULT 0,
        listening_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
        reading_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true
      );
      CREATE TABLE assessment.term_test_roster (
        test_slug TEXT NOT NULL,
        erp_course_class_id BIGINT NOT NULL,
        erp_student_contact_id BIGINT NOT NULL,
        student_ref UUID NOT NULL,
        student_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE assessment.term_test_class_access (
        test_slug TEXT NOT NULL,
        erp_course_class_id BIGINT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (test_slug, erp_course_class_id)
      );
      CREATE TABLE assessment.term_test_temporary_student (
        temporary_student_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        test_slug TEXT NOT NULL,
        erp_course_class_id BIGINT NOT NULL,
        temporary_code_normalized TEXT NOT NULL,
        student_name_snapshot TEXT NOT NULL,
        student_name_key TEXT NOT NULL,
        student_ref UUID NOT NULL DEFAULT gen_random_uuid(),
        active BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (test_slug, erp_course_class_id, temporary_code_normalized)
      );
      INSERT INTO mapping.classroom_course_mapping VALUES
        (1252, 'IC2264'), (1165, 'IC2180'), (2207, 'IC2207'), (2322, 'IC2322');
      INSERT INTO mapping.student_mapping_review VALUES
        ('00000000-0000-4000-8000-000000000001', 1252, 1, 'K56 được duyệt', 'pending_review'),
        ('00000000-0000-4000-8000-000000000002', 1165, 2, 'K56 chưa duyệt', 'pending_review'),
        ('00000000-0000-4000-8000-000000000003', 2207, 3, 'K67', 'pending_review'),
        ('00000000-0000-4000-8000-000000000004', 2322, 4, 'K56 chưa nhập roster', 'pending_review');
      INSERT INTO assessment.test_definition (slug, title, version) VALUES
        ('term-test-1-k56', 'Term K56', 1),
        ('term-test-2-k56', 'Term 2 K56', 1),
        ('mini-test-k56', 'Mini K56', 1),
        ('term-test-1', 'Term K67', 1);
      INSERT INTO assessment.term_test_class_access VALUES
        ('term-test-1-k56', 1252, true),
        ('mini-test-k56', 1252, true),
        ('term-test-1-k56', 2322, true),
        ('mini-test-k56', 2322, true);
      INSERT INTO assessment.term_test_roster VALUES
        ('term-test-1-k56', 1252, 1, '00000000-0000-4000-8000-000000000001', 'K56 được duyệt'),
        ('mini-test-k56', 1252, 1, '00000000-0000-4000-8000-000000000011', 'K56 được duyệt');
      GRANT USAGE ON SCHEMA mapping, assessment TO mapping_review_api;
      GRANT SELECT ON ALL TABLES IN SCHEMA mapping TO mapping_review_api;
      GRANT SELECT ON assessment.test_definition, assessment.term_test_roster TO mapping_review_api;
      GRANT SELECT ON assessment.term_test_class_access TO mapping_review_api;
      GRANT SELECT, INSERT, UPDATE ON assessment.term_test_temporary_student TO mapping_review_api;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA assessment TO mapping_review_api;
    `);
    await database.exec('SET ROLE mapping_review_api;');

    const deniedRoster = await database.query(listTermTestRosterSql, ['IC2180', 'term-test-1-k56']);
    assert.equal(Number(deniedRoster.rows[0]?.class_count), 0);
    assert.deepEqual(deniedRoster.rows[0]?.students, []);

    const deniedStudent = await database.query(findStudentForTermTestSql, [
      'IC2180', 'term-test-1-k56', '00000000-0000-4000-8000-000000000002'
    ]);
    assert.equal(deniedStudent.rows.length, 0);

    const deniedMini = await database.query(registerTemporaryTermTestStudentSql, [
      'IC2180', 'mini-test-k56', 'T01', 'Học viên thử', 'học viên thử'
    ]);
    assert.equal(Number(deniedMini.rows[0]?.class_count), 0);
    assert.equal(deniedMini.rows[0]?.student_ref, null);

    const missingRoster = await database.query(listTermTestRosterSql, ['IC2322', 'term-test-1-k56']);
    assert.equal(Number(missingRoster.rows[0]?.class_count), 0);
    assert.deepEqual(missingRoster.rows[0]?.students, []);
    const missingRosterStudent = await database.query(findStudentForTermTestSql, [
      'IC2322', 'term-test-1-k56', '00000000-0000-4000-8000-000000000004'
    ]);
    assert.equal(missingRosterStudent.rows.length, 0);
    const missingMiniRoster = await database.query(registerTemporaryTermTestStudentSql, [
      'IC2322', 'mini-test-k56', 'T02', 'Học viên thử', 'học viên thử'
    ]);
    assert.equal(Number(missingMiniRoster.rows[0]?.class_count), 0);
    assert.equal(missingMiniRoster.rows[0]?.student_ref, null);

    const approvedRoster = await database.query(listTermTestRosterSql, ['IC2264', 'term-test-1-k56']);
    assert.equal(Number(approvedRoster.rows[0]?.class_count), 1);
    assert.equal(approvedRoster.rows[0]?.students.length, 1);
    const approvedStudent = await database.query(findStudentForTermTestSql, [
      'IC2264', 'term-test-1-k56', '00000000-0000-4000-8000-000000000001'
    ]);
    assert.equal(approvedStudent.rows.length, 1);
    const otherTestRoster = await database.query(listTermTestRosterSql, ['IC2264', 'term-test-2-k56']);
    assert.equal(Number(otherTestRoster.rows[0]?.class_count), 0);
    const otherTestStudent = await database.query(findStudentForTermTestSql, [
      'IC2264', 'term-test-2-k56', '00000000-0000-4000-8000-000000000001'
    ]);
    assert.equal(otherTestStudent.rows.length, 0);
    const approvedMini = await database.query(registerTemporaryTermTestStudentSql, [
      'IC2264', 'mini-test-k56', 'T01', 'Học viên thử', 'học viên thử'
    ]);
    assert.ok(approvedMini.rows[0]?.student_ref);

    const legacyRoster = await database.query(listTermTestRosterSql, ['IC2207', 'term-test-1']);
    assert.equal(Number(legacyRoster.rows[0]?.class_count), 1);
    assert.equal(legacyRoster.rows[0]?.students.length, 1);
    const legacyStudent = await database.query(findStudentForTermTestSql, [
      'IC2207', 'term-test-1', '00000000-0000-4000-8000-000000000003'
    ]);
    assert.equal(legacyStudent.rows.length, 1);
  } finally {
    await database.close();
  }
});

// Dữ liệu vào: một lớp pilot đang phục vụ và một lớp K56 chưa được duyệt.
// Việc chính: chạy migration hai lần rồi đọc lại bằng quyền của API.
// Kết quả: chỉ pilot được mở; chạy lại không đảo quyền đã bị tắt.
// Khi lỗi: phát hiện thiếu seed, thiếu GRANT hoặc migration không idempotent.
test('migration K56 chỉ seed IC2264 và giữ nguyên quyết định tắt khi chạy lại', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE ROLE mapping_review_api;
      CREATE SCHEMA mapping;
      CREATE SCHEMA assessment;
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id BIGINT PRIMARY KEY,
        erp_class_name_snapshot TEXT NOT NULL
      );
      CREATE TABLE assessment.test_definition (
        slug TEXT PRIMARY KEY,
        is_active BOOLEAN NOT NULL
      );
      INSERT INTO mapping.classroom_course_mapping VALUES
        (1252, 'IC2264'), (1165, 'IC2180');
      INSERT INTO assessment.test_definition VALUES
        ('term-test-1-k56', true), ('term-test-2-k56', true), ('mini-test-k56', true);
      GRANT USAGE ON SCHEMA assessment TO mapping_review_api;
    `);
    const migration = await readFile(
      new URL('../ops/migrations/202609240001_term_test_k56_class_access.sql', import.meta.url),
      'utf8'
    );
    await database.exec(migration);
    assert.deepEqual((await database.query(`
      SELECT test_slug, erp_course_class_id::text AS class_id, enabled
      FROM assessment.term_test_class_access ORDER BY test_slug
    `)).rows, [
      { test_slug: 'mini-test-k56', class_id: '1252', enabled: true },
      { test_slug: 'term-test-1-k56', class_id: '1252', enabled: true },
      { test_slug: 'term-test-2-k56', class_id: '1252', enabled: true }
    ]);
    await database.exec(`
      UPDATE assessment.term_test_class_access
      SET enabled = false
      WHERE test_slug = 'mini-test-k56' AND erp_course_class_id = 1252;
    `);
    await database.exec(migration);
    await database.exec('SET ROLE mapping_review_api;');
    const readback = await database.query(`
      SELECT test_slug, enabled FROM assessment.term_test_class_access
      WHERE erp_course_class_id = 1252 ORDER BY test_slug
    `);
    assert.deepEqual(readback.rows, [
      { test_slug: 'mini-test-k56', enabled: false },
      { test_slug: 'term-test-1-k56', enabled: true },
      { test_slug: 'term-test-2-k56', enabled: true }
    ]);
  } finally {
    await database.close();
  }
});
