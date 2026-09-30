import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { createSpeakingCatalog } from '../src/speaking-catalog.js';
import { createSpeakingHomeworkService } from '../src/speaking-homework.js';
import { speakingCopyUrl } from '../src/speaking-classroom-copies.js';
import { createSpeakingHomeworkRouter } from '../src/speaking-homework-routes.js';

const ref = '71000000-0000-4000-8000-000000000001';
const other = '71000000-0000-4000-8000-000000000002';
const dropped = '71000000-0000-4000-8000-000000000003';
const foreign = '71000000-0000-4000-8000-000000000004';
const code = '67-speaking-lam_ro';

// Hai lớp giả, tên trùng và hồ sơ nghỉ học: kiểm bằng mã, không ghép tên.
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping (erp_course_class_id bigint PRIMARY KEY,
      erp_class_name_snapshot text, classroom_course_id text, status text);
    CREATE TABLE mapping.student_mapping_review (public_id uuid PRIMARY KEY,
      erp_course_class_id bigint, erp_student_contact_id bigint,
      erp_student_name_snapshot text, classroom_user_id text, status text);
    CREATE TABLE mapping.erp_class_membership_snapshot (erp_course_class_id bigint,
      erp_student_contact_id bigint, registration_status text);
    INSERT INTO mapping.classroom_course_mapping VALUES (2304,'IC2304','100','approved'),
      (2305,'IC2305','200','approved'), (9999,'SW9999','300','approved');
    INSERT INTO mapping.student_mapping_review VALUES
      ('${ref}',2304,1,'Tên trùng','1','approved'), ('${other}',2305,2,'Tên trùng','2','approved'),
      ('${dropped}',2304,3,'Đã nghỉ','3','approved'), ('${foreign}',9999,4,'Ngoài khóa','4','approved');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES (2304,1,'on_going'),
      (2305,2,'on_going'),(2304,3,'dropped'),(9999,4,'on_going');`);
  await db.exec(`ALTER TABLE mapping.erp_class_membership_snapshot
    ADD COLUMN source_state text NOT NULL DEFAULT 'active',
    ADD COLUMN erp_class_name_snapshot text NOT NULL DEFAULT 'Fixture',
    ADD COLUMN erp_student_name_snapshot text NOT NULL DEFAULT 'Fixture',
    ADD COLUMN erp_student_email_snapshot text,
    ADD COLUMN registration_updated_at timestamptz,
    ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT '2026-09-01T00:00:00Z',
    ADD COLUMN missing_since timestamptz,
    ADD PRIMARY KEY (erp_course_class_id,erp_student_contact_id);`);
  for (const file of ['202609270001_speaking_homework_candidate.sql',
    '202609290001_speaking_doctor_lesson3.sql','202609290003_speaking_lesson4_practice.sql',
    '202609300001_speaking_direct_homework.sql']) {
    await db.exec(await readFile(new URL(`../ops/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await db.exec(`ALTER TABLE speaking_homework.assignment_document ADD COLUMN classroom_submission_id text,
    ADD COLUMN cta_verified_at timestamptz;
    INSERT INTO speaking_homework.assignment (class_id,course_id,course_work_id,assignment_code,title,status)
      VALUES (2304,'100','101','${code}','Homework Lesson 3','open'),
        (2305,'200','201','${code}','Homework Lesson 3','open');
    INSERT INTO speaking_homework.assignment_part
      SELECT id,'clarify_1','Làm rõ','https://example.invalid/practice',3,1 FROM speaking_homework.assignment;
    INSERT INTO speaking_homework.assignment_document
      (assignment_id,document_id,student_ref,classroom_submission_id,cta_verified_at)
      SELECT id, 'document-a', '${ref}', 'submission-a', now() FROM speaking_homework.assignment WHERE class_id=2304;
    INSERT INTO speaking_homework.assignment_document
      (assignment_id,document_id,student_ref,classroom_submission_id,cta_verified_at)
      SELECT id, 'document-b', '${other}', 'submission-b', now() FROM speaking_homework.assignment WHERE class_id=2305;
    CREATE ROLE speaking_homework_api;`);
  await db.exec(await readFile(new URL('../ops/migrations/202609301329_speaking_course67_catalog.sql', import.meta.url), 'utf8'));
  await db.exec(`INSERT INTO speaking_homework.class_scope
    (class_id,class_code,course_key,active,source_key,source_observed_at)
    VALUES (2304,'IC2304','67',true,'fixture:ERP-course',now()),
      (2305,'IC2305','67',true,'fixture:ERP-course',now());`);
  const query = async (sql, params) => { const r = await db.query(sql, params); return { ...r, rowCount: r.rowCount ?? r.rows.length }; };
  const pool = { query, async connect() { return { query, release() {} }; } };
  const service = createSpeakingHomeworkService({ pool, accessSecret: 'fixture-secret-only-32-characters-long' });
  return { db, pool, service, catalog: createSpeakingCatalog({ pool, service }) };
}

test('catalog chỉ trả lớp 67 đã đối soát, không chứa roster hoặc Doc cả khóa', async () => {
  const f = await fixture();
  try {
    const classes = await f.catalog.listClasses({ assignmentCode: code });
    assert.deepEqual(classes, [{ classCode:'IC2304',classRef:'2304',assignmentStatus:'open',ready:true },
      { classCode:'IC2305',classRef:'2305',assignmentStatus:'open',ready:true }]);
    assert.deepEqual(await f.catalog.listClasses({ assignmentCode:'unknown' }), []);
    await f.pool.query("UPDATE speaking_homework.class_scope SET active=false WHERE class_id=2305");
    assert.equal((await f.catalog.listClasses({ assignmentCode:code })).length,1);
  } finally { await f.db.close(); }
});

test('hồ sơ đã nhớ giải quyết bằng UUID qua lớp; không tạo grant và loại nghỉ học/ngoài67', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.catalog.resolveIdentity({ assignmentCode:code,studentRef:other }),
      { status:'unique',classCode:'IC2305',studentRef:other });
    for (const id of [dropped,foreign]) assert.deepEqual(await f.catalog.resolveIdentity({ assignmentCode:code,studentRef:id }),{status:'missing'});
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM speaking_homework.access_grant')).rows[0].n,0);
    const roster = await f.catalog.roster({classCode:'IC2304',assignmentCode:code});
    assert.deepEqual(roster.students,[{student_ref:ref,name:'Tên trùng'}]);
  } finally { await f.db.close(); }
});

test('mở link chung lớp thứ hai giữ Doc/người và không chấp nhận Doc lớp khác', async () => {
  const f = await fixture();
  try {
    const session = await f.catalog.startSelected({ classCode:'IC2305',assignmentCode:code,studentRef:other });
    assert.equal(session.documentId,'document-b');
    const opened = await f.service.open(session);
    assert.equal(String(opened.assignment.classId),'2305');
    assert.equal(opened.assignment.documentId,'document-b');
    assert.equal(opened.student.ref,other);
    await assert.rejects(f.catalog.startSelected({ classCode:'IC2305',assignmentCode:code,studentRef:other,documentId:'document-a' }),{code:'CLASS_MISMATCH'});
    await assert.rejects(f.catalog.startSelected({ classCode:'IC2305',assignmentCode:code,studentRef:ref }),{code:'STUDENT_DOCUMENT_REQUIRED'});
  } finally { await f.db.close(); }
});

test('CTA cùng lớp giữ đích gốc khi chọn học viên khác chủ Docs', async () => {
  const f = await fixture();
  try {
    await f.pool.query(`INSERT INTO speaking_homework.assignment_document
      (assignment_id,document_id,student_ref,classroom_submission_id,cta_verified_at)
      SELECT id,'document-owner-other','${dropped}','different-owner',now()
      FROM speaking_homework.assignment WHERE class_id=2304`);
    const session = await f.catalog.startSelected({ classCode:'IC2304',assignmentCode:code,studentRef:ref,documentId:'document-owner-other' });
    assert.equal(session.documentId,'document-owner-other');
    assert.equal((await f.service.open(session)).student.ref,ref);
  } finally { await f.db.close(); }
});

test('nháp, hồ sơ vừa nghỉ và nhiều Docs bị từ chối trước mở phiên', async () => {
  const f = await fixture();
  try {
    await f.pool.query("UPDATE speaking_homework.assignment SET status='draft' WHERE class_id=2305");
    await assert.rejects(f.catalog.startSelected({classCode:'IC2305',assignmentCode:code,studentRef:other}),{code:'HOMEWORK_DRAFT'});
    await f.pool.query("UPDATE speaking_homework.assignment SET status='open' WHERE class_id=2305");
    await f.pool.query("UPDATE mapping.erp_class_membership_snapshot SET registration_status='on_hold' WHERE erp_course_class_id=2305");
    await assert.rejects(f.catalog.startSelected({classCode:'IC2305',assignmentCode:code,studentRef:other}),{code:'STUDENT_NOT_FOUND'});
    await f.pool.query(`INSERT INTO speaking_homework.assignment_document
      (assignment_id,document_id,student_ref,classroom_submission_id,cta_verified_at)
      SELECT id,'another-doc','${ref}','another-submission',now() FROM speaking_homework.assignment WHERE class_id=2304`);
    await assert.rejects(f.catalog.startSelected({classCode:'IC2304',assignmentCode:code,studentRef:ref}),{code:'STUDENT_DOCUMENT_REQUIRED'});
  } finally { await f.db.close(); }
});

test('đăng ký sự kiện lặp là một bài, giữ nháp và không tự thay mã đã gắn', async () => {
  const f = await fixture();
  try {
    const pending = await f.catalog.register({courseId:'200',courseWorkId:'201',assignmentCode:code,classroomState:'DRAFT'});
    assert.equal(pending.status,'open');
    const existing = await f.catalog.register({courseId:'200',courseWorkId:'201',assignmentCode:code,classroomState:'PUBLISHED'});
    const retry = await f.catalog.register({courseId:'200',courseWorkId:'201',assignmentCode:code,classroomState:'PUBLISHED'});
    assert.equal(existing.assignmentId,retry.assignmentId);
    await f.pool.query("UPDATE speaking_homework.assignment SET status='draft' WHERE id=$1",[existing.assignmentId]);
    assert.equal((await f.catalog.register({courseId:'200',courseWorkId:'201',assignmentCode:code,classroomState:'PUBLISHED'})).status,'draft');
    await assert.rejects(f.catalog.register({courseId:'200',courseWorkId:'202',assignmentCode:code,classroomState:'PUBLISHED'}),{code:'ASSIGNMENT_BINDING_CONFLICT'});
    await assert.rejects(f.catalog.register({courseId:'300',courseWorkId:'301',assignmentCode:code,classroomState:'PUBLISHED'}),{code:'CLASS_SCOPE_INVALID'});
    assert.equal(new URL(speakingCopyUrl({documentId:'abcde',classCode:'IC2305',assignmentCode:'67-speaking-paraphrase'})).pathname,
      '/izone-ai-team-pages/speaking-homework/');
  } finally { await f.db.close(); }
});

test('mẫu dùng lại cho lớp mới; DRAFT không tạo bài và PUBLISHED tạo đủ cấu hình một lần', async () => {
  const f = await fixture();
  try {
    await f.pool.query("INSERT INTO mapping.classroom_course_mapping VALUES (2306,'IC2306','400','approved')");
    await f.pool.query(`INSERT INTO speaking_homework.class_scope
      (class_id,class_code,course_key,active,source_key,source_observed_at)
      VALUES (2306,'IC2306','67',true,'fixture:ERP-course',now())`);
    const input = {courseId:'400',courseWorkId:'401',assignmentCode:code};
    const draft = await f.catalog.register({...input,classroomState:'DRAFT'});
    assert.deepEqual(draft,{registered:false,status:'draft',assignmentId:null});
    const published = await f.catalog.register({...input,classroomState:'PUBLISHED'});
    assert.equal(published.classCode,'IC2306');
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM speaking_homework.assignment_part WHERE assignment_id=$1',[published.assignmentId])).rows[0].n,1);
    assert.equal((await f.catalog.register({...input,classroomState:'PUBLISHED'})).assignmentId,published.assignmentId);
    assert.equal((await f.catalog.register({...input,classroomState:'DELETED'})).status,'closed');
    assert.equal((await f.catalog.listClasses({assignmentCode:code})).find(c=>c.classCode==='IC2306').ready,false);
    await f.pool.query("UPDATE speaking_homework.assignment SET status='closed' WHERE id=$1",[published.assignmentId]);
    await assert.rejects(f.catalog.register({...input,classroomState:'PUBLISHED'}),{code:'HOMEWORK_CLOSED'});
  } finally { await f.db.close(); }
});

test('HTTP contract kiểm đầu vào, không lộ roster qua resolver và khóa route đăng ký nội bộ', async () => {
  const f = await fixture();
  try {
    const app=express(); app.use(express.json());
    app.use('/speaking',createSpeakingHomeworkRouter({pool:f.pool,
      accessSecret:'fixture-secret-only-32-characters-long',workerSecret:'fixture-worker-secret',authenticate:(_req,res)=>res.sendStatus(401)}));
    const list=await request(app).get('/speaking/classes').query({assignmentCode:code}).expect(200);
    assert.equal(list.body.classes.length,2);
    await request(app).post('/speaking/identity/resolve').send({assignmentCode:code,studentRef:'bad'}).expect(400);
    const identity=await request(app).post('/speaking/identity/resolve').send({assignmentCode:code,studentRef:ref}).expect(200);
    assert.equal(identity.body.classCode,'IC2304'); assert.equal(identity.body.students,undefined);
    await request(app).post('/speaking/session/start-selected').send({classCode:'IC2304',assignmentCode:code,studentRef:ref,identityConfirmed:false}).expect(400);
    const session=await request(app).post('/speaking/session/start-selected').send({classCode:'IC2304',assignmentCode:code,studentRef:ref,identityConfirmed:true}).expect(200);
    assert.equal(session.body.session.documentId,'document-a');
    await request(app).post('/speaking/internal/assignments/register').send({courseId:'200',courseWorkId:'201',assignmentCode:code,classroomState:'PUBLISHED'}).expect(401);
    await request(app).post('/speaking/internal/assignments/register').set('x-speaking-worker-secret','fixture-worker-secret')
      .send({courseId:'200',courseWorkId:'201',assignmentCode:code,classroomState:'PUBLISHED'}).expect(200);
  } finally { await f.db.close(); }
});

test('snapshot ERP khóa67 cập nhật lớp mới, khóa mapping chưa duyệt và từ chối ảnh chụp cũ', async () => {
  const f = await fixture();
  try {
    await f.pool.query("INSERT INTO mapping.classroom_course_mapping VALUES (2314,'IC2314',null,'pending_review')");
    const sourceObservedAt=new Date(Date.now()-2_000).toISOString();
    const snapshot={sourceObservedAt,classes:[{classId:'2304',classCode:'IC2304',active:true},
      {classId:'2305',classCode:'IC2305',active:true},{classId:'2314',classCode:'IC2314',active:true}]};
    assert.equal((await f.catalog.syncScope(snapshot)).enabled,2);
    assert.equal((await f.pool.query('SELECT active FROM speaking_homework.class_scope WHERE class_id=2314')).rows[0].active,false);
    await assert.rejects(f.catalog.syncScope({...snapshot,sourceObservedAt:new Date(Date.now()-5_000).toISOString()}),{code:'SCOPE_SNAPSHOT_STALE'});
    await f.pool.query("UPDATE mapping.classroom_course_mapping SET status='approved',classroom_course_id='500' WHERE erp_course_class_id=2314");
    const later={...snapshot,sourceObservedAt:new Date().toISOString(),classes:snapshot.classes.filter(c=>c.classId!=='2305')};
    assert.equal((await f.catalog.syncScope(later)).enabled,2);
    assert.equal((await f.pool.query('SELECT active FROM speaking_homework.class_scope WHERE class_id=2305')).rows[0].active,false);
    const classes=await f.catalog.listClasses({assignmentCode:code});
    assert.deepEqual(classes.map(c=>c.classCode),['IC2304','IC2314']);
    assert.equal(classes[1].assignmentStatus,'missing');
    assert.equal((await f.catalog.assignmentScopes()).length,1);
  } finally { await f.db.close(); }
});

test('CTA bài đã đóng giữ quyền luyện thêm đã có, không mở phiên mới từ link chung', async () => {
  const f=await fixture();
  try {
    const input={classCode:'IC2304',assignmentCode:code,studentRef:ref,documentId:'document-a'};
    await f.catalog.startSelected(input);
    await f.pool.query(`INSERT INTO speaking_homework.submission(access_grant_id,status,submitted_at)
      SELECT id,'submitted',now() FROM speaking_homework.access_grant WHERE student_ref=$1`,[ref]);
    await f.pool.query("UPDATE speaking_homework.assignment SET status='closed' WHERE class_id=2304");
    await f.pool.query("UPDATE speaking_homework.class_scope SET active=false WHERE class_id=2304");
    assert.equal((await f.catalog.roster(input)).assignmentStatus,'closed');
    assert.equal((await f.catalog.startSelected(input)).documentId,'document-a');
    await assert.rejects(f.catalog.startSelected({...input,documentId:undefined}),{code:'ASSIGNMENT_NOT_FOUND'});
    await f.pool.query("UPDATE mapping.erp_class_membership_snapshot SET registration_status='on_hold' WHERE erp_student_contact_id=1");
    await assert.rejects(f.catalog.startSelected(input),{code:'STUDENT_NOT_FOUND'});
  } finally {await f.db.close();}
});

test('refresh đăng ký giữ lịch sử, loại missing và không ghi sang lớp ngoài67', async () => {
  const f=await fixture();
  try {
    const input={sourceObservedAt:new Date(Date.now()-1000).toISOString(),classIds:['2304','2305'],
      memberships:[{classId:'2304',contactId:'1',studentName:'Tên mới từ ERP',email:null,registrationStatus:'on_going'}]};
    const result=await f.catalog.syncMemberships(input);
    assert.equal(result.observed,1); assert.equal(result.markedMissing,2);
    assert.equal((await f.catalog.syncMemberships(input)).alreadyCurrent,true);
    await assert.rejects(f.catalog.syncMemberships({...input,memberships:[]}),{code:'SCOPE_SNAPSHOT_STALE'});
    const rows=(await f.pool.query('SELECT erp_course_class_id,erp_student_contact_id,source_state,registration_status FROM mapping.erp_class_membership_snapshot ORDER BY erp_course_class_id,erp_student_contact_id')).rows;
    assert.equal(rows.find(x=>String(x.erp_student_contact_id)==='2').source_state,'missing');
    assert.equal(rows.find(x=>String(x.erp_student_contact_id)==='4').source_state,'active');
    assert.deepEqual(await f.catalog.resolveIdentity({assignmentCode:code,studentRef:other}),{status:'missing'});
    await assert.rejects(f.catalog.startSelected({classCode:'IC2305',assignmentCode:code,studentRef:other}),{code:'STUDENT_NOT_FOUND'});
    await assert.rejects(f.catalog.syncMemberships({...input,classIds:['9999']}),{code:'CLASS_SCOPE_INVALID'});
    await assert.rejects(f.catalog.syncMemberships({...input,sourceObservedAt:new Date(Date.now()-5000).toISOString()}),{code:'SCOPE_SNAPSHOT_STALE'});
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM mapping.student_mapping_review')).rows[0].n,4);
    const latest=new Date().toISOString();
    await f.catalog.syncMemberships({sourceObservedAt:latest,classIds:['2304'],memberships:[]});
    await assert.rejects(f.catalog.syncMemberships({...input,classIds:['2304']}),{code:'SCOPE_SNAPSHOT_STALE'});
    assert.equal((await f.pool.query('SELECT source_state FROM mapping.erp_class_membership_snapshot WHERE erp_course_class_id=2304 AND erp_student_contact_id=1')).rows[0].source_state,'missing');
  } finally {await f.db.close();}
});
