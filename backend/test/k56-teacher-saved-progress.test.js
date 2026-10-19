import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {readFile} from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {isolatedSchemaDatabase} from '../../products/test-support/native-schema-database.mjs';
import {readTeacherSavedProgress,mountTeacherSavedProgress} from '../src/k56-teacher-saved-progress.js';
import {createAssessmentSchemaPool} from '../src/assessment-schema-pool.js';

const ref='11111111-1111-4111-8111-111111111111',session='80000000-0000-4000-8000-000000000001';
const input={class:'IC2305',test:'term-test-1-k56',student:ref},email='teacher@fixture.test',teacherToken='teacher-token-in-fixture-only';

for(const slug of ['term-test-1-k56','term-test-2-k56','mini-test-k56'])test(slug+': 100 hồ sơ cập nhật nháp qua SQL và 10 cửa sổ GV, giữ đúng thứ tự và đồng hồ',
 {skip:!process.env.TEACHER_NATIVE_SQL_URL,timeout:60000},async t=>{
 const f=await fixture();t.after(()=>f.db.close());
 if(slug!==input.test)await f.pool.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
  SELECT $1,$1,1,listening_definition,reading_definition,true FROM assessment.test_definition WHERE slug=$2`,[slug,input.test]);
 const people=[];
 for(let i=0;i<100;i++){
  const studentRef=randomUUID(),sessionId=randomUUID(),attemptId=randomUUID(),contact=1000000+i,readFirst=i%2===0;
  await f.db.query("INSERT INTO mapping.student_mapping_review VALUES($1,1294,$2,$3,'approved')",[studentRef,contact,'HV nháp giả '+i]);
  await f.pool.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
   erp_student_contact_id,student_name_snapshot,attempt_mode,listening_started_at,listening_deadline_at)
   VALUES($1,$2,1,1294,'IC2305',$3,$4,'cbt',CASE WHEN $5 THEN NULL ELSE now() END,CASE WHEN $5 THEN NULL ELSE now()+interval '30 minutes' END)`,[sessionId,slug,contact,'HV nháp giả '+i,readFirst]);
  if(readFirst)await f.pool.query(`INSERT INTO assessment.term_test_attempt(id,client_submission_id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
   erp_student_contact_id,student_name_snapshot,exam_session_id,exam_mode,reading_started_at,reading_deadline_at)
   VALUES($1,$1,$2,1,1294,'IC2305',$3,$4,$5,'read_first',now(),now()+interval '60 minutes')`,[attemptId,slug,contact,'HV nháp giả '+i,sessionId]);
  people.push({studentRef,sessionId,attemptId,readFirst,index:i});
 }
 const latency=[];
 async function read(person){const began=performance.now();const result=await request(f.app).get('/api/term-tests/teacher/saved-progress').set('Cookie','teacher=fixture')
  .query({class:input.class,test:slug,student:person.studentRef});latency.push(performance.now()-began);assert.equal(result.status,200);return result.body;}
 // Mô phỏng ghi nháp ở tầng DB. Đây không phải bài kiểm trọn HTTP của backend K56 cũ.
 const writes=people.map(async person=>{for(let revision=1;revision<=3;revision++){
  if(person.readFirst)await f.pool.query('UPDATE assessment.term_test_attempt SET reading_draft=$1,reading_draft_updated_at=now() WHERE id=$2',
   [JSON.stringify({'2':'R-'+person.index+'-'+revision}),person.attemptId]);
  else await f.pool.query('UPDATE assessment.term_test_exam_session SET listening_draft=$1,listening_draft_updated_at=now() WHERE id=$2',
   [JSON.stringify({'1':'L-'+person.index+'-'+revision}),person.sessionId]);
 }});
 const readers=Array.from({length:10},(_,index)=>(async()=>{for(let i=0;i<3;i++)await read(people[index*3+i]);})());
 const settled=await Promise.allSettled([...writes,...readers]),failures={};for(const row of settled)if(row.status==='rejected'){const message=String(row.reason);failures[message]=(failures[message]||0)+1;}
 assert.deepEqual(failures,{});
 const snapshot=async()=>({sessions:(await f.pool.query('SELECT row_to_json(s) AS row FROM assessment.term_test_exam_session s ORDER BY id')).rows,
  attempts:(await f.pool.query('SELECT row_to_json(a) AS row FROM assessment.term_test_attempt a ORDER BY id')).rows});
 const before=await snapshot();
 for(const person of people){const saved=(await read(person)).attempts;assert.equal(saved.length,1);
  assert.equal(saved[0].order,person.readFirst?'read_first':'lis_first');
  assert.equal(person.readFirst?saved[0].reading.answers['2']:saved[0].listening.answers['1'],(person.readFirst?'R-':'L-')+person.index+'-3');}
 assert.deepEqual(await snapshot(),before);
 const sorted=latency.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({environment:'local-native-PostgreSQL-reader-HTTP-student-SQL',students:100,teacherReaders:10,
  studentDraftWrites:300,teacherRequests:latency.length,teacherP95ms:Math.round(sorted[Math.ceil(sorted.length*.95)-1]),teacherMaxMs:Math.round(sorted.at(-1)),externalCalls:0,audioDownloads:0}));
});
async function fixture(){
 const db=process.env.TEACHER_NATIVE_SQL_URL?await isolatedSchemaDatabase({pg}):new PGlite();
 await db.exec('CREATE SCHEMA mapping;');
 const context=await readFile(new URL('../../products/term-mini-k67/db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['classroom_course_mapping','student_mapping_review','reviewer_account','reviewer_class_access','reviewer_session'])
  await db.exec(context.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0]);
 await db.exec('CREATE TABLE mapping.reviewer_class_assignment(reviewer_email text,class_name text);');
 await db.exec(await readFile(new URL('./fixtures/k56-teacher-source-schema.sql',import.meta.url),'utf8'));
 const pool=createAssessmentSchemaPool(db,{family:'k56'});
 await db.exec("INSERT INTO mapping.classroom_course_mapping VALUES(1294,'IC2305');");
 await db.query("INSERT INTO mapping.student_mapping_review VALUES($1,1294,900001,'Học viên thử','approved')",[ref]);
 await db.query("INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,'subject-fixture','teacher','active')",[email]);
 await db.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1294)',[email]);
 await db.query("INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at) VALUES($1,$2,'subject-fixture',now()+interval '90 days',now()+interval '365 days')",[createHash('sha256').update(teacherToken).digest(),email]);
 await pool.query("INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active) VALUES($1,'Term Test 1 K56',1,'{}','{}',true)",[input.test]);
 await pool.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
  erp_student_contact_id,student_name_snapshot,attempt_mode,listening_started_at,listening_deadline_at,listening_draft,listening_draft_updated_at)
  VALUES($1,$2,1,1294,'IC2305',900001,'Học viên thử','cbt',now(),now()+interval '30 minutes','{"1":"B"}',now())`,[session,input.test]);
 const req={authSource:'session',teacherSessionToken:teacherToken,reviewer:{email,canAccessAllClasses:false}};
 const app=express();mountTeacherSavedProgress(app,{pool,limiter:(_q,_s,next)=>next(),authenticate(q,s,next){if(q.get('cookie')!=='teacher=fixture')return s.sendStatus(401);Object.assign(q,req);next();}});
 return {db,pool,req,app};
}

test('K56: đọc session trước bài nộp, không cần cột delivery K67 và không đổi giờ/nháp',async()=>{
 const {db,pool,req}=await fixture();try{
  const before=await pool.query('SELECT row_to_json(s) AS value FROM assessment.term_test_exam_session s');
  const data=await readTeacherSavedProgress(pool,input,req);assert.equal(data.attempts.length,1);assert.equal(data.attempts[0].listening.answers['1'],'B');
  assert.equal(JSON.stringify(data).includes(session),false);assert.equal(JSON.stringify(data).includes(teacherToken),false);
  assert.deepEqual((await pool.query('SELECT row_to_json(s) AS value FROM assessment.term_test_exam_session s')).rows,before.rows);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
 }finally{await db.close();}
});

test('K56: thu hồi quyền/admin cũ/phiên đã thu hồi không đọc được dữ liệu',async()=>{
 const {db,pool,req}=await fixture();try{
  await db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[email]);
  await assert.rejects(readTeacherSavedProgress(pool,input,{...req,reviewer:{...req.reviewer,canAccessAllClasses:true}}),e=>e.status===403);
  await db.query('INSERT INTO mapping.reviewer_class_assignment VALUES($1,$2)',[email,'IC2305']);
  assert.equal((await readTeacherSavedProgress(pool,input,req)).attempts.length,1);
  await db.exec('UPDATE mapping.reviewer_session SET revoked_at=now()');
  await assert.rejects(readTeacherSavedProgress(pool,input,req),e=>e.httpStatus===401);
 }finally{await db.close();}
});

test('K56 HTTP: chỉ ba mã K56, cookie GV bắt buộc và dữ liệu không lưu dùng chung',async()=>{
 const {db,app}=await fixture();try{
  const path='/api/term-tests/teacher/saved-progress';await request(app).get(path).query(input).expect(401);
  await request(app).get(path).set('Cookie','teacher=fixture').query({...input,test:'term-test-1'}).expect(400);
  const data=await request(app).get(path).set('Cookie','teacher=fixture').query(input).expect(200);assert.match(data.headers['cache-control'],/no-store/);
  await db.exec('UPDATE mapping.reviewer_session SET revoked_at=now()');await request(app).get(path).set('Cookie','teacher=fixture').query(input).expect(401);
 }finally{await db.close();}
});

test('K56: Reading trước chưa nộp và lượt cũ có Writing giữ riêng, không làm mất snapshot',async()=>{
 const {db,pool,req}=await fixture();try{
  const current='80000000-0000-4000-8000-000000000002',old='80000000-0000-4000-8000-000000000003';
  await pool.query(`INSERT INTO assessment.term_test_attempt(id,client_submission_id,test_slug,definition_version,erp_course_class_id,
    class_name_snapshot,erp_student_contact_id,student_name_snapshot,exam_session_id,exam_mode,reading_started_at,reading_deadline_at,reading_draft,reading_draft_updated_at)
    VALUES($1,$1,$2,1,1294,'IC2305',900001,'Học viên thử',$3,'read_first',now(),now()+interval '60 minutes','{"2":"Đọc đang viết"}',now())`,[current,input.test,session]);
  await pool.query(`INSERT INTO assessment.term_test_attempt(id,client_submission_id,test_slug,definition_version,erp_course_class_id,
    class_name_snapshot,erp_student_contact_id,student_name_snapshot,listening_answers,listening_result,listening_submitted_at,
    reading_answers,reading_result,reading_submitted_at,combined_result,completed_at,writing_task_2,superseded_at,created_at)
    VALUES($1,$1,$2,1,1294,'IC2305',900001,'Học viên thử','{"1":"Cũ"}','{}',now()-interval '1 day',
    '{"2":"Đọc cũ"}','{}',now()-interval '1 day','{}',now()-interval '1 day','Writing lượt cũ',now(),now()-interval '1 day')`,[old,input.test]);
  const before=await pool.query('SELECT row_to_json(a) AS value FROM assessment.term_test_attempt a ORDER BY id');
  const data=await readTeacherSavedProgress(pool,input,req);assert.equal(data.attempts.length,2);
  const history=data.attempts.find(a=>a.superseded),working=data.attempts.find(a=>!a.superseded);
  assert.equal(history.writing.task2,'Writing lượt cũ');assert.equal(history.reading.answers['2'],'Đọc cũ');
  assert.equal(working.reading.answers['2'],'Đọc đang viết');assert.equal(working.reading.submittedAt,null);assert.equal(working.order,'read_first');
  assert.deepEqual((await pool.query('SELECT row_to_json(a) AS value FROM assessment.term_test_attempt a ORDER BY id')).rows,before.rows);
 }finally{await db.close();}
});
