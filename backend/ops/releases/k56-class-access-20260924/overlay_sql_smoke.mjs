// Dữ liệu vào: ba câu SQL K56 đã ghép từ source live, truyền qua stdin cục bộ.
// Việc chính: chạy trên PostgreSQL trong RAM để kiểm lớp mở/đóng, roster và mã tạm.
// Kết quả: chỉ số lượng ca đạt; không gọi production hoặc ghi file.
// Khi lỗi: exit khác 0 và chỉ báo tên ca, không xuất tên/ID học viên thật.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const sql = JSON.parse(input);
for (const name of ['listTermTestRosterSql', 'findStudentForTermTestSql',
  'registerTemporaryTermTestStudentSql']) {
  assert.equal(typeof sql[name], 'string');
}

const database = new PGlite();
try {
  await database.exec(`
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
      (1252, 'IC2264'), (2322, 'IC2322'), (2326, 'IC2326'), (2207, 'IC2207');
    INSERT INTO mapping.student_mapping_review VALUES
      ('00000000-0000-4000-8000-000000000001', 1252, 1, 'Người giả A', 'pending_review'),
      ('00000000-0000-4000-8000-000000000002', 2322, 2, 'Người giả B', 'pending_review'),
      ('00000000-0000-4000-8000-000000000003', 2326, 3, 'Người giả C', 'pending_review'),
      ('00000000-0000-4000-8000-000000000004', 2207, 4, 'Người giả D', 'pending_review');
    INSERT INTO assessment.test_definition (slug, title, version) VALUES
      ('term-test-1-k56', 'Term K56', 1),
      ('mini-test-k56', 'Mini K56', 1),
      ('term-test-1', 'Term K67', 1);
    INSERT INTO assessment.term_test_class_access VALUES
      ('term-test-1-k56', 1252, true), ('mini-test-k56', 1252, true),
      ('term-test-1-k56', 2322, false), ('mini-test-k56', 2322, false),
      ('term-test-1-k56', 2326, true), ('mini-test-k56', 2326, true);
    INSERT INTO assessment.term_test_roster VALUES
      ('term-test-1-k56', 1252, 1, '00000000-0000-4000-8000-000000000001', 'Người giả A'),
      ('mini-test-k56', 1252, 1, '00000000-0000-4000-8000-000000000011', 'Người giả A'),
      ('term-test-1-k56', 2322, 2, '00000000-0000-4000-8000-000000000002', 'Người giả B'),
      ('mini-test-k56', 2322, 2, '00000000-0000-4000-8000-000000000022', 'Người giả B'),
      ('term-test-1', 2207, 4, '00000000-0000-4000-8000-000000000004', 'Người giả D');
  `);
  let passed = 0;
  const roster = async (classCode, slug) =>
    (await database.query(sql.listTermTestRosterSql, [classCode, slug])).rows[0];
  const student = async (classCode, slug, ref) =>
    (await database.query(sql.findStudentForTermTestSql, [classCode, slug, ref])).rows;
  const temporary = async (classCode, slug, code) =>
    (await database.query(sql.registerTemporaryTermTestStudentSql,
      [classCode, slug, code, 'Người giả', 'người giả'])).rows[0];

  assert.equal(Number((await roster('IC2264', 'term-test-1-k56')).class_count), 1);
  assert.equal((await student('IC2264', 'term-test-1-k56',
    '00000000-0000-4000-8000-000000000001')).length, 1);
  passed += 2;
  assert.equal(Number((await roster('IC2322', 'term-test-1-k56')).class_count), 0);
  assert.equal((await student('IC2322', 'term-test-1-k56',
    '00000000-0000-4000-8000-000000000002')).length, 0);
  assert.equal((await temporary('IC2322', 'mini-test-k56', 'T01')).student_ref, null);
  passed += 3;
  assert.equal(Number((await roster('IC2326', 'term-test-1-k56')).class_count), 0);
  assert.equal((await student('IC2326', 'term-test-1-k56',
    '00000000-0000-4000-8000-000000000003')).length, 0);
  assert.equal((await temporary('IC2326', 'mini-test-k56', 'T02')).student_ref, null);
  passed += 3;
  assert.equal(Number((await roster('IC2207', 'term-test-1')).class_count), 1);
  assert.ok((await temporary('IC2264', 'mini-test-k56', 'T03')).student_ref);
  passed += 2;
  process.stdout.write(JSON.stringify({ toolOutcome: 'success', passed,
    database: 'pglite_in_memory', productionWrites: 0 }));
} finally {
  await database.close();
}
