import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createSpeakingTeacherProgress } from '../src/speaking-teacher-progress.js';
import { createIndependentApp } from '../src/speaking-independent-server.js';

const code = '67-speaking-diem_giua';
const student = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const unit = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// SQL thật trên dữ liệu giả: bảo vệ xem trước nộp, đúng lớp và không tạo/sửa bài khi xem.
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA speaking_independent;
    CREATE TABLE speaking_independent.profile(id uuid,identity_ref uuid,student_ref uuid,student_name text,class_id bigint,class_code text);
    CREATE TABLE speaking_independent.work_unit(id uuid,profile_id uuid,assignment_code text,template jsonb,status text,
      submitted_at timestamptz,document_id text,context_key text,created_at timestamptz DEFAULT now(),revoked_at timestamptz,token_hash text);
    CREATE TABLE speaking_independent.receipt(id uuid,work_unit_id uuid);
    CREATE TABLE speaking_independent.link(id uuid DEFAULT gen_random_uuid(),work_unit_id uuid,kind text,part text,slot integer,exercise_title text,
      share_url text,status text,question_count integer,check_code text,checked_at timestamptz,created_at timestamptz DEFAULT now(),revision integer);
    CREATE TABLE speaking_independent.job(work_unit_id uuid,kind text,status text,link_id uuid,created_at timestamptz DEFAULT now(),id uuid);
    CREATE TABLE speaking_independent.document_binding(document_id text,assignment_code text,work_unit_id uuid);
    CREATE TABLE speaking_independent.source_assignment(course_id text,course_work_id text,class_id bigint,class_code text,state text);
    CREATE TABLE speaking_independent.source_binding(course_id text,course_work_id text,document_id text,assignment_code text,student_ref uuid,work_unit_id uuid);
  `);
  const template = { title: 'Bài mẫu', parts: [{ part_key: 'freestyle' }], requiredPracticeCount: 2 };
  for (const n of [1, 2]) {
    await db.query('INSERT INTO speaking_independent.profile VALUES($1,$1,$1,$2,$3,$4)',
      [student(n), `Học viên ${n}`, n === 1 ? '1293' : '1294', n === 1 ? 'IC2304' : 'OTHER']);
    await db.query(`INSERT INTO speaking_independent.work_unit
      (id,profile_id,assignment_code,template,status,context_key,token_hash) VALUES($1,$2,$3,$4,'draft','web','private-student-proof')`,
      [unit(n), student(n), code, template]);
  }
  await db.query(`INSERT INTO speaking_independent.link(work_unit_id,kind,part,share_url,status,question_count,revision)
    VALUES($1,'main','freestyle','https://chatgpt.com/share/fixture-old','accepted',2,1),
          ($1,'main','freestyle','https://chatgpt.com/share/fixture-current','pending',NULL,2)`, [unit(1)]);
  let allowed = true;
  const source = {
    legacyProgress: async method=>method==='entry'?{entry:null}:{students:[]},
    context: async input => ({ template, classes: [{ class_id: '1293', class_code: 'IC2304' }],
      scope: { class_id: '1293', class_code: 'IC2304' },
      students: [{ student_ref: student(1), name: 'Học viên 1' }, { student_ref: student(3), name: 'Chưa mở bài' }],
      selectionStudents: [] }),
    teacher: async (id, headers) => allowed && id === '1293' && headers.cookie === 'teacher=allowed'
  };
  const pool = { query: (sql, args) => db.query(sql, args) };
  const teacher = createSpeakingTeacherProgress({ pool, source });
  const app = createIndependentApp({ service: { pool }, teacher });
  return { db, teacher, app, deny: () => { allowed = false; }, close: () => db.close() };
}

test('Giảng viên vào cùng bài trước khi có biên nhận, có cả học viên chưa mở bài', async () => {
  const f = await fixture();
  try {
    const before = await f.db.query('SELECT row_to_json(u) AS value FROM speaking_independent.work_unit u ORDER BY id');
    const response = await request(f.app).get('/api/speaking-homework-independent/teacher/progress/students')
      .query({ assignmentCode: code, classCode: 'IC2304' }).set('Cookie', 'teacher=allowed');
    assert.equal(response.status, 200);
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.body.students.length, 2);
    const a = response.body.students.find(row => row.studentRef === student(1));
    assert.equal(a.units.length, 1);
    assert.equal(a.units[0].status, 'draft');
    assert.equal(a.units[0].sentLinks, 1);
    assert.equal(a.units[0].acceptedLinks, 0);
    assert.equal(a.units[0].receiptId, null);
    assert.deepEqual(response.body.students.find(row => row.studentRef === student(3)).units, []);
    assert.equal(JSON.stringify(response.body).includes('private-student-proof'), false);
    assert.deepEqual((await f.db.query('SELECT row_to_json(u) AS value FROM speaking_independent.work_unit u ORDER BY id')).rows, before.rows);
  } finally { await f.close(); }
});

test('CTA cá nhân tìm đúng lớp/lượt từ binding, không gọi mở bài và không tạo lượt mới',async()=>{
 const f=await fixture();try{
  await f.db.query('INSERT INTO speaking_independent.document_binding VALUES($1,$2,$3)',['fixture-doc',code,unit(1)]);
  const before=await f.db.query('SELECT row_to_json(u) AS value FROM speaking_independent.work_unit u ORDER BY id');
  const route='/api/speaking-homework-independent/teacher/progress/entry';
  const response=await request(f.app).get(route).query({assignmentCode:code,documentId:'fixture-doc'}).set('Cookie','teacher=allowed');
  assert.equal(response.status,200);assert.equal(response.body.classId,'1293');assert.deepEqual(response.body.unitIds,[unit(1)]);assert.equal(response.body.studentRef,student(1));
  assert.equal(JSON.stringify(response.body).includes('private-student-proof'),false);
  await request(f.app).get(route).query({assignmentCode:code,documentId:'fixture-doc'}).expect(403);
  await request(f.app).get(route).query({assignmentCode:code,documentId:'unknown-doc'}).set('Cookie','teacher=allowed').expect(404);
  assert.deepEqual((await f.db.query('SELECT row_to_json(u) AS value FROM speaking_independent.work_unit u ORDER BY id')).rows,before.rows);
  f.deny();await request(f.app).get(route).query({assignmentCode:code,documentId:'fixture-doc'}).set('Cookie','teacher=allowed').expect(403);
 }finally{await f.close();}
});

test('Chi tiết chưa nộp chọn đúng revision, không lộ token hoặc tự tạo receipt/job', async () => {
  const f = await fixture();
  try {
    const detail = await f.teacher.detail({ id: unit(1) }, { cookie: 'teacher=allowed' });
    assert.equal(detail.status, 'draft');
    assert.equal(detail.links.length, 1);
    assert.equal(detail.links[0].url, 'https://chatgpt.com/share/fixture-current');
    assert.equal(detail.links[0].status, 'pending');
    assert.equal(detail.receiptId, null);
    assert.equal(JSON.stringify(detail).includes('private-student-proof'), false);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM speaking_independent.job')).rows[0].n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM speaking_independent.receipt')).rows[0].n, 0);
    await assert.rejects(f.teacher.detail({ id: unit(2) }, { cookie: 'teacher=allowed' }), { code: 'TEACHER_ACCESS_DENIED' });
    f.deny();
    await assert.rejects(f.teacher.detail({ id: unit(1) }, { cookie: 'teacher=allowed' }), { code: 'TEACHER_ACCESS_DENIED' });
  } finally { await f.close(); }
});

test('Đường đọc lớp kiểm lại quyền và từ chối query lạ/UUID sai', async () => {
  const f = await fixture();
  try {
    const base = '/api/speaking-homework-independent/teacher/progress';
    assert.equal((await request(f.app).get(base + '/classes').query({ assignmentCode: code }).set('Cookie', 'teacher=allowed')).status, 200);
    assert.equal((await request(f.app).get(base + '/classes').query({ assignmentCode: code })).status, 403);
    assert.equal((await request(f.app).get(base + '/classes').query({ assignmentCode: code, admin: 'true' }).set('Cookie', 'teacher=allowed')).status, 400);
    assert.equal((await request(f.app).get(base + '/units/not-a-uuid').set('Cookie', 'teacher=allowed')).status, 400);
    f.deny();
    assert.equal((await request(f.app).get(base + '/classes').query({ assignmentCode: code }).set('Cookie', 'teacher=allowed')).status, 403);
  } finally { await f.close(); }
});

test('Lượt kiểm dừng để review hiện đúng trên link mới nhất, không trộn revision và không sửa dữ liệu', async () => {
  const f = await fixture();
  try {
    const links = (await f.db.query('SELECT id,revision FROM speaking_independent.link ORDER BY revision')).rows;
    await f.db.query(`INSERT INTO speaking_independent.job(work_unit_id,link_id,kind,status)
      VALUES($1,$2,'check_main','review')`, [unit(1), links[0].id]);
    assert.equal((await f.teacher.detail({ id: unit(1) }, { cookie: 'teacher=allowed' })).links[0].status, 'pending');
    await f.db.query(`INSERT INTO speaking_independent.job(work_unit_id,link_id,kind,status)
      VALUES($1,$2,'check_main','review')`, [unit(1), links[1].id]);
    const before = await f.db.query('SELECT row_to_json(j) AS value FROM speaking_independent.job j');
    const detail = await f.teacher.detail({ id: unit(1) }, { cookie: 'teacher=allowed' });
    assert.equal(detail.links[0].status, 'rejected');
    assert.equal(detail.links[0].checkCode, 'CHECK_REVIEW_REQUIRED');
    assert.deepEqual((await f.db.query('SELECT row_to_json(j) AS value FROM speaking_independent.job j')).rows, before.rows);
    assert.equal((await f.db.query('SELECT status FROM speaking_independent.link WHERE id=$1', [links[1].id])).rows[0].status, 'pending');
  } finally { await f.close(); }
});
