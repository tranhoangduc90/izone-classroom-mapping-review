import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import {
  listTermTestRosterSql, listTermTestTeacherOptionsSql,
  insertTermTestExamSessionSql, startTermTestListeningSessionSql,
  saveTermTestListeningDraftSql, insertListeningAttemptSql
} from '../src/sql.js';
import { createTermTestWritingGradingService } from '../src/term-test-writing-grading.js';

// Nhận URL qua harness riêng; bắt buộc đúng DB/marker fixture trước bất kỳ ghi nào.
// SQL chạy trên PostgreSQL 16 thật với role thật; không thay grant bằng pool mock.
function checkedUrl(field, role) {
  assert.equal(process.env.K67_TEST_FIXTURE_CONFIRMATION, 'synthetic-fixture-20261006');
  const url = new URL(process.env[field]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/term_mini_k67_test_database');
  assert.equal(url.username, role);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  return url.href;
}
const appPool = new pg.Pool({ connectionString: checkedUrl('K67_TEST_DATABASE_URL', 'k67_app'), max: 5, statement_timeout: 10000 });
const ownerPool = new pg.Pool({ connectionString: checkedUrl('K67_TEST_OWNER_URL', 'k67_owner'), max: 2, statement_timeout: 10000 });
const contextPool = new pg.Pool({ connectionString: checkedUrl('K67_TEST_CONTEXT_URL', 'k67_context_sync'), max: 2, statement_timeout: 10000 });
const suffix = crypto.randomBytes(4).toString('hex');
const classA = 9870676101;
const classB = 9870676102;
const classCode = `K67SIM_${suffix.toUpperCase()}`;
const teacherEmail = `k67-${suffix}@example.test`;
const studentRef = crypto.randomUUID();
const studentId = 9870676201;
let fixtureConfirmed = false;
async function transaction(pool, callback) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); return await callback(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
before(async () => {
  const marker = (await appPool.query('SELECT * FROM mapping.k67_fixture_identity')).rows;
  assert.deepEqual(marker, [{ product_id: 'PRODUCT-TERM-MINI-K67', fixture_id: 'synthetic-fixture-20261006' }]);
  fixtureConfirmed = true;
  await ownerPool.query(`INSERT INTO mapping.classroom_course_mapping VALUES ($1,$2),($3,$4)`, [classA, classCode, classB, `${classCode}_OTHER`]);
  await ownerPool.query(`INSERT INTO mapping.reviewer_account(email,google_subject,display_name) VALUES ($1,$2,'Giảng viên mô phỏng K67')`, [teacherEmail, `subject-${suffix}`]);
  await ownerPool.query('INSERT INTO mapping.reviewer_class_access VALUES ($1,$2)', [teacherEmail, classA]);
  await ownerPool.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES ('term-test-1','Đề mô phỏng K67',1,'{}','{}',true) ON CONFLICT DO NOTHING`);
  await ownerPool.query(`INSERT INTO assessment.term_test_roster(test_slug,erp_course_class_id,erp_student_contact_id,student_ref,student_name_snapshot)
    VALUES ('term-test-1',$1,$2,$3,'Học viên mô phỏng K67')`, [classA, studentId, studentRef]);
});
after(async () => {
  try {
    if (fixtureConfirmed) {
      // Chỉ dọn bản ghi giả của hai mã lớp cố định trong DB fixture; không đụng lịch sử hoặc dữ liệu live.
      await ownerPool.query('DELETE FROM assessment.term_test_writing_grading_final WHERE attempt_id IN (SELECT id FROM assessment.term_test_attempt WHERE erp_course_class_id=$1)', [classA]);
      await ownerPool.query('UPDATE assessment.term_test_attempt SET exam_session_id=NULL WHERE erp_course_class_id=$1', [classA]);
      await ownerPool.query('UPDATE assessment.term_test_exam_session SET attempt_id=NULL WHERE erp_course_class_id=$1', [classA]);
      await ownerPool.query('DELETE FROM assessment.term_test_attempt WHERE erp_course_class_id=$1', [classA]);
      await ownerPool.query('DELETE FROM assessment.term_test_exam_session WHERE erp_course_class_id=$1', [classA]);
      await ownerPool.query('DELETE FROM assessment.term_test_roster WHERE erp_course_class_id=$1', [classA]);
      await ownerPool.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1', [teacherEmail]);
      await ownerPool.query('DELETE FROM mapping.reviewer_account WHERE email=$1', [teacherEmail]);
      await ownerPool.query('DELETE FROM mapping.classroom_course_mapping WHERE erp_course_class_id=ANY($1::bigint[])', [[classA, classB]]);
    }
  } finally { await Promise.all([appPool.end(), ownerPool.end(), contextPool.end()]); }
});
test('PostgreSQL thật có đúng 13 bảng thi K67 và không có bảng sản phẩm khác', async () => {
  const tables = (await appPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='assessment' AND table_type='BASE TABLE'`)).rows;
  assert.equal(tables.length, 13);
  assert.equal(tables.some(row => row.table_name.startsWith('writing_test_')), false);
  const identity = (await appPool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
  assert.deepEqual(identity, { db: 'term_mini_k67_test_database', role: 'k67_app' });
  const other = (await appPool.query(`SELECT datname FROM pg_database WHERE datname IN ('mapping_db','assessment_k56')`)).rows;
  assert.equal(other.length, 0);
});
test('Role ứng dụng không sửa quyền giảng viên, tạo bảng hoặc đọc nhật ký quản trị', async () => {
  for (const sql of ["UPDATE mapping.reviewer_account SET role='admin'", 'CREATE TABLE assessment.forbidden_fixture(id int)', 'SELECT * FROM collaboration.audit_event', 'SELECT * FROM pg_authid']) {
    await assert.rejects(transaction(appPool, client => client.query(sql)), error => error.code === '42501');
  }
});
test('Role đồng bộ ngữ cảnh không sửa bài thi và role ứng dụng không sửa roster nguồn', async () => {
  await assert.rejects(transaction(contextPool, client => client.query('UPDATE assessment.term_test_attempt SET student_name_snapshot=$1', ['Tên sai'])), error => error.code === '42501');
  await assert.rejects(transaction(appPool, client => client.query('UPDATE mapping.classroom_course_mapping SET erp_class_name_snapshot=$1', ['Lớp sai'])), error => error.code === '42501');
  await transaction(contextPool, client => client.query('UPDATE mapping.classroom_course_mapping SET erp_class_name_snapshot=erp_class_name_snapshot WHERE erp_course_class_id=$1', [classA]));
});
test('SQL roster và quyền lớp dùng dữ liệu ngữ cảnh riêng, không mở lớp khác', async () => {
  const roster = (await appPool.query(listTermTestRosterSql, [classCode, 'term-test-1'])).rows[0];
  assert.equal(roster.class_count, 1);
  assert.deepEqual(roster.students, [{ ref: studentRef, name: 'Học viên mô phỏng K67' }]);
  const options = (await appPool.query(listTermTestTeacherOptionsSql, [teacherEmail, { source: 'google_bearer', googleSubject: `subject-${suffix}` }])).rows[0].response;
  assert.equal(options.classes.length, 1);
  assert.equal(options.classes[0].name, classCode);
});
test('Listening giữ hạn bắt đầu và bản nháp mới khi gửi lại revision cũ trên SQL thật', async () => {
  await transaction(appPool, async client => {
    const created = (await client.query(insertTermTestExamSessionSql, ['term-test-1', 1, classA, classCode, studentId, 'Học viên mô phỏng K67', 0])).rows[0];
    const id = created.exam_session_token;
    const first = (await client.query(startTermTestListeningSessionSql, [id, 'term-test-1', 1800])).rows[0];
    const again = (await client.query(startTermTestListeningSessionSql, [id, 'term-test-1', 1800])).rows[0];
    assert.equal(first.listening_deadline_at.toISOString(), again.listening_deadline_at.toISOString());
    const newer = (await client.query(saveTermTestListeningDraftSql, [id, 'term-test-1', JSON.stringify({ 1: 'bản mới' }), 2])).rows[0];
    const older = (await client.query(saveTermTestListeningDraftSql, [id, 'term-test-1', JSON.stringify({ 1: 'bản cũ' }), 1])).rows[0];
    assert.equal(newer.accepted, true);
    assert.equal(older.accepted, false);
    assert.deepEqual(older.listening_draft, { 1: 'bản mới' });
  });
});
test('Nộp Listening lặp không tạo bài thứ hai và không ghi đè điểm đã lưu trên SQL thật', async () => {
  await transaction(appPool, async client => {
    const submission = crypto.randomUUID();
    const params = [submission, 'term-test-1', 1, classA, classCode, studentId, 'Học viên mô phỏng K67', '{"1":"first"}', '{"score":5}'];
    const first = (await client.query(insertListeningAttemptSql, params)).rows[0];
    params[7] = '{"1":"changed"}';
    params[8] = '{"score":9}';
    const repeated = (await client.query(insertListeningAttemptSql, params)).rows[0];
    assert.equal(repeated.attempt_token, first.attempt_token);
    assert.deepEqual(repeated.listening_result, { score: 5 });
    const count = (await client.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt WHERE client_submission_id=$1', [submission])).rows[0].n;
    assert.equal(count, 1);
  });
});
test('Hàm reset demo từ chối lớp khác trước khi xóa dữ liệu', async () => {
  await assert.rejects(transaction(appPool, client => client.query('SELECT * FROM assessment.reset_demo_term_test_student($1,$2,$3)', [classCode, 'term-test-1', studentRef])), error => error.code === '42501');
});
test('Trigger ghi lịch sử actor quản trị, không chép khóa phiên hoặc cho ứng dụng sửa lịch sử', async () => {
  await transaction(ownerPool, async client => {
    const prior = (await client.query('SELECT coalesce(max(event_id),0)::text AS id FROM collaboration.audit_event')).rows[0].id;
    await client.query('UPDATE mapping.reviewer_account SET display_name=$1 WHERE email=$2', ['Tên mô phỏng mới', teacherEmail]);
    const events = (await client.query('SELECT action,session_actor,changed_columns,key_after FROM collaboration.audit_event WHERE event_id>$1 AND object_name=$2', [prior, 'reviewer_account'])).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].session_actor, 'k67_owner');
    assert.deepEqual(events[0].changed_columns, ['display_name']);
    assert.deepEqual(events[0].key_after, { email: teacherEmail });
    await client.query(`CREATE TABLE mapping.fixture_token_history(token_hash text PRIMARY KEY, value int)`);
    await client.query(`INSERT INTO mapping.fixture_token_history VALUES ('secret-never-in-history',1)`);
    const token = (await client.query("SELECT key_after FROM collaboration.audit_event WHERE object_name='fixture_token_history' AND action='INSERT' ORDER BY event_id DESC LIMIT 1")).rows[0];
    assert.equal(token.key_after, null);
  });
});
test('Hàng chấm thật giữ trần bốn job, lease 180 phút và từ chối callback chủ cũ', async () => {
  const service = createTermTestWritingGradingService({ pool: appPool });
  for (let i = 0; i < 5; i++) {
    const row = (await appPool.query(insertListeningAttemptSql, [crypto.randomUUID(), 'term-test-1', 1, classA, classCode, studentId + 10 + i, 'Học viên mô phỏng chấm', '{}', '{}'])).rows[0];
    await appPool.query(`UPDATE assessment.term_test_attempt
      SET reading_answers='{}',reading_result='{}',combined_result='{}',reading_submitted_at=now(),
          completed_at=now(),writing_started_at=now(),writing_updated_at=now(),
          writing_submitted_at=now(),writing_task_1='Bài mô phỏng'
      WHERE id=$1`, [row.attempt_token]);
    await service.ensureSubmission({ attemptToken: row.attempt_token, testSlug: 'term-test-1', task1: 'Bài mô phỏng', task2: '', taskDefinitions: [{ id: 'task1', prompt: 'Đề mô phỏng K67' }] });
  }
  const claimed = await service.claimJobs({ workerId: 'k67-fixture-a', limit: 10 });
  assert.equal(claimed.length, 4);
  assert.deepEqual(await service.claimJobs({ workerId: 'k67-fixture-b', limit: 10 }), []);
  const lease = (await appPool.query('SELECT extract(epoch FROM (lease_until-leased_at))::int AS seconds FROM assessment.term_test_writing_grading_job WHERE id=$1', [claimed[0].jobId])).rows[0];
  assert.equal(lease.seconds, 10800);
  await appPool.query("UPDATE assessment.term_test_writing_grading_job SET lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 hour' WHERE id=$1", [claimed[0].jobId]);
  const reclaimed = await service.claimJobs({ workerId: 'k67-fixture-b', limit: 1 });
  assert.equal(reclaimed[0].jobId, claimed[0].jobId);
  await assert.rejects(service.completeDispatch({ jobId: claimed[0].jobId, workerId: 'k67-fixture-a' }), error => error.code === 'WRITING_GRADING_JOB_LEASE_MISMATCH');
  const result = await service.completeDispatch({ jobId: reclaimed[0].jobId, workerId: 'k67-fixture-b', sourceRecordId: `K67SIM_${suffix}` });
  assert.equal(result.status, 'accepted');
  assert.equal((await service.completeDispatch({ jobId: reclaimed[0].jobId, workerId: 'k67-fixture-b' })).status, 'duplicate');
});
