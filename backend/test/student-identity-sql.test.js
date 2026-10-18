// PostgreSQL nhúng chạy SQL thật trên dữ liệu giả; không nối VPS hoặc database học viên.
// Kiểm quyền vào danh sách được giữ trong câu SQL; handler vẫn không cấp phiên làm bài.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mappingStudentIdentitySql, termStudentIdentitySql, parseStudentIdentityRequest,
  studentIdentityParameters, resolvedStudentIdentity } from '../src/student-identity.js';

const refs = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const alice = { authority: 'erp-contact', id: '12345' };
async function database({ k56 = false } = {}) {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA mapping; CREATE SCHEMA assessment;
    CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint PRIMARY KEY,
      erp_class_name_snapshot text,status text);
    CREATE TABLE mapping.student_mapping_review(public_id uuid PRIMARY KEY,erp_course_class_id bigint,
      erp_student_contact_id bigint,erp_student_name_snapshot text,status text);
    CREATE TABLE mapping.erp_class_membership_snapshot(erp_course_class_id bigint,
      erp_student_contact_id bigint,source_state text,registration_status text);
    CREATE TABLE assessment.test_definition(slug text PRIMARY KEY,is_active boolean);
    CREATE TABLE assessment.term_test_roster(test_slug text,erp_course_class_id bigint,
      erp_student_contact_id bigint,student_ref uuid,student_name_snapshot text,is_eligible boolean);
    INSERT INTO mapping.classroom_course_mapping VALUES(111,'LOPTHU','approved'),(222,'LOPKHAC','approved'),(-1,'CODEXDEMO','approved');
    INSERT INTO mapping.student_mapping_review VALUES
      ('${refs[0]}',111,12345,'Học viên thử','approved'),
      ('${refs[1]}',222,12345,'Học viên thử','approved'),
      ('${refs[2]}',111,67890,'Học viên thử','approved');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES(111,12345,'active','active'),
      (222,12345,'active','active'),(111,67890,'missing','dropped');
    INSERT INTO assessment.test_definition VALUES('term-test-1',true),('term-test-1-k56',true),('term-test-closed',false);`);
  if (k56) await db.exec(`CREATE TABLE assessment.term_test_class_access(test_slug text,erp_course_class_id bigint,enabled boolean);
    INSERT INTO assessment.term_test_class_access VALUES('term-test-1-k56',111,true),('term-test-1-k56',222,false);`);
  return db;
}

test('SQL Mapping nối nhiều UUID của cùng người và không nhận người nghỉ/lớp demo', async () => {
  const db = await database();
  try {
    const input = parseStudentIdentityRequest({ identity: alice });
    const found = await db.query(mappingStudentIdentitySql, studentIdentityParameters(input));
    const resolved = resolvedStudentIdentity(found.rows, input);
    assert.deepEqual(resolved.identity, alice);
    assert.deepEqual(resolved.aliases.map(row => row.classCode), ['LOPKHAC', 'LOPTHU']);
    const left = parseStudentIdentityRequest({ identity: { authority: 'erp-contact', id: '67890' } });
    assert.equal((await db.query(mappingStudentIdentitySql, studentIdentityParameters(left))).rows.length, 0);
    await db.exec(`UPDATE mapping.erp_class_membership_snapshot SET source_state='missing' WHERE erp_course_class_id=222;
      INSERT INTO mapping.student_mapping_review VALUES('${refs[3]}',-1,12345,'Người thử','approved');
      INSERT INTO mapping.erp_class_membership_snapshot VALUES(-1,12345,'active','active');`);
    assert.deepEqual((await db.query(mappingStudentIdentitySql, studentIdentityParameters(input))).rows.map(row => row.class_code), ['LOPTHU']);
  } finally { await db.close(); }
});

test('SQL Mapping tôn trọng lớp được yêu cầu và giữ chính xác mã bigint lớn', async () => {
  const db = await database();
  try {
    const input = parseStudentIdentityRequest({ studentRef: refs[0], classCode: 'LOPKHAC' });
    assert.equal((await db.query(mappingStudentIdentitySql, studentIdentityParameters(input))).rows.length, 0);
    await db.exec(`UPDATE mapping.student_mapping_review SET erp_student_contact_id=9007199254740993 WHERE public_id='${refs[0]}';
      UPDATE mapping.erp_class_membership_snapshot SET erp_student_contact_id=9007199254740993 WHERE erp_course_class_id=111 AND erp_student_contact_id=12345;`);
    const big = parseStudentIdentityRequest({ studentRef: refs[0], classCode: 'LOPTHU' });
    const result = resolvedStudentIdentity((await db.query(mappingStudentIdentitySql, studentIdentityParameters(big))).rows, big);
    assert.equal(result.identity.id, '9007199254740993');
  } finally { await db.close(); }
});

test('SQL K56 giữ is_eligible và quyền lớp, không fallback sang Mapping hoặc học viên tạm', async () => {
  const db = await database({ k56: true });
  try {
    await db.exec(`INSERT INTO assessment.term_test_roster VALUES
      ('term-test-1-k56',111,12345,'${refs[3]}','Học viên thử',true),
      ('term-test-1-k56',111,67890,'${refs[2]}','Người đã gỡ',false),
      ('term-test-1-k56',222,12345,'${refs[1]}','Lớp chưa mở',true),
      ('term-test-1-k56',111,-5,'${refs[0]}','Hồ sơ tạm',true);`);
    const input = parseStudentIdentityRequest({ identity: alice });
    const sql = termStudentIdentitySql({ k56: true });
    const result = await db.query(sql, [...studentIdentityParameters(input), 'term-test-1-k56']);
    assert.deepEqual(result.rows.map(row => row.student_ref), [refs[3]]);
    const removed = parseStudentIdentityRequest({ studentRef: refs[2], classCode: 'LOPTHU' });
    assert.equal((await db.query(sql, [...studentIdentityParameters(removed), 'term-test-1-k56'])).rows.length, 0);
    await db.exec(`DELETE FROM assessment.term_test_roster WHERE erp_student_contact_id=12345 AND erp_course_class_id=111;`);
    assert.equal((await db.query(sql, [...studentIdentityParameters(input), 'term-test-1-k56'])).rows.length, 0);
  } finally { await db.close(); }
});

test('SQL K67 chạy khi không có bảng quyền K56; roster đã chốt ưu tiên hơn Mapping', async () => {
  const db = await database();
  try {
    await db.exec(`INSERT INTO assessment.term_test_roster VALUES
      ('term-test-1',111,12345,'${refs[3]}','Học viên thử',true);`);
    const input = parseStudentIdentityRequest({ identity: alice });
    const sql = termStudentIdentitySql();
    const result = await db.query(sql, [...studentIdentityParameters(input), 'term-test-1']);
    assert.deepEqual(result.rows.map(row => row.student_ref).sort(), [refs[1], refs[3]].sort());
    const oldMapping = parseStudentIdentityRequest({ studentRef: refs[0], classCode: 'LOPTHU' });
    assert.equal((await db.query(sql, [...studentIdentityParameters(oldMapping), 'term-test-1'])).rows.length, 0);
    assert.equal((await db.query(sql, [...studentIdentityParameters(input), 'term-test-closed'])).rows.length, 0);
  } finally { await db.close(); }
});
