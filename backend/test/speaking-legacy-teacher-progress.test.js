import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {isolatedSchemaDatabase} from '../../products/test-support/native-schema-database.mjs';
import {createLegacySpeakingTeacherProgress} from '../src/speaking-legacy-teacher-progress.js';
import express from 'express';
import request from 'supertest';
import {createSpeakingHomeworkRouter} from '../src/speaking-homework-routes.js';
import {createIndependentSourceClient} from '../src/speaking-independent-server.js';

const id=n=>`50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const code='67-speaking-paraphrase';
// SQL thật trên kho giả: nhiều lớp, bài đã nộp/chưa nộp và hai revision của một link.
async function fixture(){
 const db=process.env.TEACHER_NATIVE_SQL_URL?await isolatedSchemaDatabase({pg}):new PGlite();
 await db.exec(`CREATE SCHEMA speaking_homework;CREATE SCHEMA mapping;
  CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,erp_class_name_snapshot text);
  CREATE TABLE mapping.student_mapping_review(public_id uuid,erp_course_class_id bigint,erp_student_name_snapshot text);
  CREATE TABLE speaking_homework.assignment(id uuid,class_id bigint,course_id text,assignment_code text,title text,required_practice_count integer);
  CREATE TABLE speaking_homework.assignment_document(document_id text,assignment_id uuid,student_ref uuid);
  CREATE TABLE speaking_homework.access_grant(id uuid,assignment_id uuid,student_ref uuid,document_id text,revoked_at timestamptz,token_hash text);
  CREATE TABLE speaking_homework.submission(id uuid,access_grant_id uuid,status text,submitted_at timestamptz,created_at timestamptz DEFAULT now());
  CREATE TABLE speaking_homework.receipt(id uuid,submission_id uuid);
  CREATE TABLE speaking_homework.assignment_part(assignment_id uuid,part_key text,display_title text,min_questions integer,position integer);
  CREATE TABLE speaking_homework.submission_link(submission_id uuid,part text,share_url text,check_status text,check_code text,question_count integer,checked_at timestamptz,created_at timestamptz DEFAULT now(),revision integer,evidence jsonb);
  CREATE TABLE speaking_homework.practice_link(access_grant_id uuid,slot integer,share_url text,status text,check_code text,question_count integer,checked_at timestamptz,submitted_at timestamptz DEFAULT now(),revision integer,exercise_id uuid);
  CREATE TABLE speaking_homework.doctor_exercise(id uuid,title text);
  CREATE TABLE speaking_homework.outbox(id uuid,receipt_id uuid,kind text,status text,created_at timestamptz DEFAULT now());
  INSERT INTO mapping.classroom_course_mapping VALUES(1124,'IC2304'),(1125,'IC2305');`);
 for(const n of [1,2]){
  await db.query('INSERT INTO mapping.student_mapping_review VALUES($1,$2,$3)',[id(n),1123+n,'Học viên thử '+n]);
  await db.query('INSERT INTO speaking_homework.assignment VALUES($1,$2,$3,$4,$5,1)',[id(n),1123+n,'course-'+n,code,'Bài thử '+n]);
  await db.query('INSERT INTO speaking_homework.assignment_document VALUES($1,$2,$2)',['doc-fixture-'+n,id(n)]);
  await db.query('INSERT INTO speaking_homework.access_grant VALUES($1,$1,$1,$2,NULL,$3)',[id(n),'doc-fixture-'+n,'private-student-token']);
  await db.query("INSERT INTO speaking_homework.submission(id,access_grant_id,status) VALUES($1,$1,'draft')",[id(n)]);
  await db.query("INSERT INTO speaking_homework.assignment_part VALUES($1,'paraphrase','Luyện diễn đạt',3,1)",[id(n)]);
 }
 await db.query(`INSERT INTO speaking_homework.submission_link(submission_id,part,share_url,check_status,question_count,revision,evidence)
  VALUES($1,'paraphrase','https://chatgpt.com/share/old','accepted',3,1,'{"private":"private-evidence"}'),
  ($1,'paraphrase','https://chatgpt.com/share/new','pending',NULL,2,'{}')`,[id(1)]);
 await db.query('INSERT INTO speaking_homework.doctor_exercise VALUES($1,$2)',[id(9),'Bài bổ trợ']);
 await db.query("INSERT INTO speaking_homework.practice_link(access_grant_id,slot,share_url,status,question_count,revision,exercise_id) VALUES($1,1,'https://chatgpt.com/share/practice','accepted',3,1,$2)",[id(1),id(9)]);
 let allowed=true;
 const source={teacher:async({classId,reviewer})=>allowed&&classId==='1124'&&reviewer.email==='teacher@fixture.test',context:async()=>({scope:{class_id:'1124',class_code:'IC2304',course_id:'course-1'},students:[{student_ref:id(1),name:'Học viên thử 1'},{student_ref:id(3),name:'Chưa mở bài'}]})};
 const reader=createLegacySpeakingTeacherProgress({pool:db,source});
 return {db,reader,reviewer:{email:'teacher@fixture.test'},deny(){allowed=false;},close:()=>db.close()};
}

test('Speaking cũ: liệt kê trước biên nhận, đúng revision và không tạo bài cho người chưa mở',async()=>{
 const f=await fixture();try{
  const before=await f.db.query('SELECT row_to_json(s) AS value FROM speaking_homework.submission s ORDER BY id');
  const response=await f.reader.students({assignmentCode:code,classCode:'IC2304'},f.reviewer);
  assert.equal(response.students.length,2);const a=response.students.find(s=>s.studentRef===id(1));
  assert.equal(a.units[0].id,'legacy_'+id(1));assert.equal(a.units[0].receiptId,null);
  assert.equal(a.units[0].sentLinks,2);assert.equal(a.units[0].acceptedLinks,1);assert.ok(a.units[0].savedAt);
  assert.deepEqual(response.students.find(s=>s.studentRef===id(3)).units,[]);
  assert.equal(JSON.stringify(response).includes('private-student-token'),false);
  assert.deepEqual((await f.db.query('SELECT row_to_json(s) AS value FROM speaking_homework.submission s ORDER BY id')).rows,before.rows);
 }finally{await f.close();}
});

test('CTA kho cũ chỉ chọn đúng file/bài/lớp và giữ nguyên grant',async()=>{
 const f=await fixture();try{
  const before=await f.db.query('SELECT row_to_json(g) AS value FROM speaking_homework.access_grant g ORDER BY id');
  const result=await f.reader.entry({assignmentCode:code,documentId:'doc-fixture-1'},f.reviewer);
  assert.equal(result.entry.classId,'1124');assert.equal(result.entry.studentRef,id(1));assert.deepEqual(result.entry.unitIds,['legacy_'+id(1)]);
  assert.equal((await f.reader.entry({assignmentCode:'another-code',documentId:'doc-fixture-1'},f.reviewer)).entry,null);
  await assert.rejects(f.reader.entry({assignmentCode:code,documentId:'doc-fixture-2'},f.reviewer),e=>e.httpStatus===403);
  assert.deepEqual((await f.db.query('SELECT row_to_json(g) AS value FROM speaking_homework.access_grant g ORDER BY id')).rows,before.rows);
 }finally{await f.close();}
});

test('Speaking cũ: đọc main/bổ trợ đã lưu, chặn vượt lớp và quyền bị rút; không ghi job/biên nhận',async()=>{
 const f=await fixture();try{
  const response=await f.reader.detail({id:id(1)},f.reviewer);
  assert.equal(response.status,'draft');assert.equal(response.links.length,2);
  assert.equal(response.links.find(l=>l.kind==='main').url,'https://chatgpt.com/share/new');
  assert.equal(response.links.find(l=>l.kind==='main').status,'pending');
  assert.equal(response.links.find(l=>l.kind==='practice').title,'Bài bổ trợ');
  assert.equal(response.student.name,'Học viên thử 1');assert.equal(response.assignment.parts[0].part_key,'paraphrase');
  assert.equal(JSON.stringify(response).includes('private-'),false);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM speaking_homework.receipt')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM speaking_homework.outbox')).rows[0].n,0);
  await assert.rejects(f.reader.detail({id:id(2)},f.reviewer),e=>e.httpStatus===403);
  f.deny();await assert.rejects(f.reader.detail({id:id(1)},f.reviewer),e=>e.httpStatus===403);
 }finally{await f.close();}
});

test('Đường đọc cũ cần cả khóa nội bộ và phiên Google; dữ liệu sai bị chặn trước SQL',async()=>{
 const app=express();app.use(express.json());let reads=0;
 const pool={query(){reads++;throw new Error('Không được đọc SQL khi chưa đủ quyền/đầu vào');}};
 app.use('/speaking',createSpeakingHomeworkRouter({pool,workerSecret:'fixture-worker-secret',accessSecret:'fixture-access-secret',
  authenticate(req,res,next){if(req.get('cookie')!=='teacher=fixture')return res.sendStatus(401);req.reviewer={email:'teacher@fixture.test'};next();}}));
 const url='/speaking/internal/independent/teacher-progress/students';
 await request(app).get(url).set('Cookie','teacher=fixture').query({assignmentCode:code,classCode:'IC2304'}).expect(401);
 await request(app).get(url).set('x-speaking-worker-secret','fixture-worker-secret').query({assignmentCode:code,classCode:'IC2304'}).expect(401);
 await request(app).get(url).set('Cookie','teacher=fixture').set('x-speaking-worker-secret','fixture-worker-secret').query({assignmentCode:code,classCode:'IC2304',extra:'forbidden'}).expect(400);
 await request(app).get('/speaking/internal/independent/teacher-progress/units/bad').set('Cookie','teacher=fixture').set('x-speaking-worker-secret','fixture-worker-secret').expect(400);
 assert.equal(reads,0);
});

test('Bộ nối giữ phiên GV và khóa nội bộ trong header, không gọi đường mở bài học viên',async()=>{
 const calls=[];
 const source=createIndependentSourceClient({base:'https://source.fixture/speaking',secret:'s'.repeat(32),call:async(url,options)=>{calls.push({url:new URL(url),options});return {ok:true,status:200,json:async()=>({ok:true,students:[]})};}});
 await source.legacyProgress('students',{assignmentCode:code,classCode:'IC2304'},{cookie:'teacher=fixture',origin:'https://pages.fixture'});
 await source.legacyProgress('detail',{id:id(1)},{cookie:'teacher=fixture'});
 assert.equal(calls[0].url.pathname,'/speaking/internal/independent/teacher-progress/students');
 assert.equal(calls[0].url.searchParams.get('assignmentCode'),code);assert.equal(calls[0].options.method,'GET');
 assert.equal(calls[0].options.headers.cookie,'teacher=fixture');assert.equal(calls[0].options.headers['x-speaking-worker-secret'],'s'.repeat(32));
 assert.equal(calls[1].url.pathname,'/speaking/internal/independent/teacher-progress/units/'+id(1));
 assert.equal(calls.some(c=>c.url.href.includes('teacher=fixture')||c.options.body),false);
});
