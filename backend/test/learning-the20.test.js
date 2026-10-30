import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createLearningTestResultReader} from '../src/learning-test-results.js';
import {registerStudentPortalRoutes} from '../src/learning-student-portal.js';
import {LearningError} from '../src/learning-service.js';

const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002';
const attempt='20000000-0000-4000-8000-000000000001',token='30000000-0000-4000-8000-000000000001';
const run1='40000000-0000-4000-8000-000000000001',run2='40000000-0000-4000-8000-000000000002';
async function fixture(){
 const db=new PGlite();await db.exec(`
 CREATE SCHEMA assessment;CREATE SCHEMA mapping;CREATE SCHEMA learning;
 CREATE TABLE assessment.test_definition(slug text,title text);
 CREATE TABLE assessment.term_test_roster(test_slug text,erp_course_class_id bigint,student_ref uuid,erp_student_contact_id bigint);
 CREATE TABLE assessment.term_test_temporary_student(test_slug text,erp_course_class_id bigint,student_ref uuid,temporary_student_id bigint,active boolean);
 CREATE TABLE mapping.student_mapping_review(erp_course_class_id bigint,public_id uuid,erp_student_contact_id bigint,status text);
 CREATE TABLE assessment.term_test_attempt(id uuid,test_slug text,erp_course_class_id bigint,erp_student_contact_id bigint,combined_result jsonb,completed_at timestamptz,writing_submitted_at timestamptz,superseded_at timestamptz);
 CREATE TABLE assessment.mini_test_result(test_slug text,erp_course_class_id bigint,erp_student_contact_id bigint,result jsonb,updated_at timestamptz);
 CREATE TABLE assessment.term_test_writing_grading_final(attempt_id uuid,status text,writing_score numeric,task_1_score numeric,task_2_score numeric,task_1_run_id uuid,task_2_run_id uuid);
 CREATE TABLE assessment.term_test_writing_grading_run(id uuid,attempt_id uuid,task_number int,status text,task_score numeric,word_count int,prompt_text text,prompt_image_url text,essay_text text,result_json jsonb,grading_version int DEFAULT 1);
 CREATE TABLE learning.form_assignment(id uuid,public_token uuid,erp_course_class_id bigint,class_name_snapshot text,course_code text,session_number int,status text,created_at timestamptz DEFAULT now());
 CREATE TABLE learning.form_assignment_roster(assignment_id uuid,student_ref uuid,student_name_snapshot text,display_discriminator text);
 INSERT INTO assessment.test_definition VALUES('term-test-1','Term Test 1'),('term-test-2','Term Test 2');
 INSERT INTO mapping.student_mapping_review VALUES(1294,'${a}',101,'active'),(1294,'${b}',102,'active'),(9999,'${a}',103,'active');
 INSERT INTO assessment.term_test_attempt VALUES('${attempt}','term-test-1',1294,101,
  '{"listening":{"correct":1,"total":4,"typeStats":[{"type":"Matching","correct":1,"total":2},{"type":"Gap fill","correct":0,"total":2}]},"reading":{"correct":0,"total":2},"secretKey":"PRIVATE_KEY"}',
  '2026-10-01T10:00:00Z','2026-10-01T11:00:00Z',NULL),
 ('20000000-0000-4000-8000-000000000002','term-test-2',1294,101,'{"reading":{"correct":3,"total":4,"typeStats":[{"type":"TFNG","correct":1,"total":2},{"type":"Matching","correct":2,"total":2}]}}','2026-10-25T10:00:00Z',NULL,NULL),
 ('20000000-0000-4000-8000-000000000003','term-test-1',1294,102,'{"listening":{"correct":4,"total":4}}','2026-10-26T10:00:00Z',NULL,NULL),
 ('20000000-0000-4000-8000-000000000004','term-test-1',9999,103,'{"listening":{"correct":2,"total":4}}','2026-10-27T10:00:00Z',NULL,NULL),
 ('20000000-0000-4000-8000-000000000005','term-test-1',1294,101,'{"listening":{"correct":4,"total":4}}','2026-10-28T10:00:00Z',NULL,'2026-10-29T10:00:00Z');
 INSERT INTO assessment.term_test_writing_grading_final VALUES('${attempt}','ready',3.5,0,5.5,'${run1}','${run2}');
 INSERT INTO assessment.term_test_writing_grading_run(id,attempt_id,task_number,status,task_score,word_count,prompt_text,prompt_image_url,essay_text,result_json) VALUES
 ('${run1}','${attempt}',1,'complete',0,0,'Task 1 prompt',NULL,'','{"gradingMethod":"blank_rule","report":"Bài trắng","secret":"PRIVATE_KEY","attemptToken":"${attempt}","criteria":[]}'),
 ('${run2}','${attempt}',2,'complete',5.5,120,'Task 2 prompt',NULL,'The actual saved essay.','{"report":"<p>Nhận xét thật</p>","criteria":[{"code":"TR","name":"Task response","bandScore":5.5,"feedback":"Feedback","components":[{"label":"Ideas","summary":"Summary","feedback":"Detail"}]}]}');
 INSERT INTO learning.form_assignment VALUES('${token}','${token}',1294,'IC_TEST20','56',1,'published',now()),
 ('30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',1294,'IC_TEST20','56',2,'draft',now()),
 ('30000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000003',9999,'OTHER','67',1,'closed',now());
 INSERT INTO learning.form_assignment_roster VALUES('${token}','${a}','Học viên A',NULL),('${token}','${b}','Học viên B','Nhóm B');
 `);return db;
}

test('Thẻ 20 SQL lấy đủ bài đúng chủ và phân tích riêng kỹ năng; điểm 0 khác thiếu; không trả khóa/token',async()=>{
 const db=await fixture();try{
  const reader=createLearningTestResultReader({pool:db}),rows=await reader.readStudent({classId:'1294',studentRef:a});
  const all=await reader.readAllClass({classId:'1294',studentRefs:[a,b]});assert.deepEqual(all.filter(r=>r.studentRef===a).map(r=>r.result),rows);assert.ok(all.some(r=>r.studentRef===b));
  assert.equal(rows.length,2);const one=rows.find(r=>r.testSlug==='term-test-1'),two=rows.find(r=>r.testSlug==='term-test-2');
  assert.equal(one.listening.correct,1);assert.equal(one.reading.correct,0);assert.equal(two.listening,null);
  assert.deepEqual(one.listening.analysis.needsImprovement,[{type:'Gap fill',correct:0,total:2}]);
  assert.equal(two.reading.analysis.needsImprovement[0].type,'TFNG');
  assert.deepEqual(one.writing.tasks,{1:{score:0,status:'ready'},2:{score:5.5,status:'ready'}});
  assert.match(one.resultRef,/^[0-9a-f]{64}$/u);assert.doesNotMatch(JSON.stringify(rows),new RegExp(attempt+'|PRIVATE_KEY','u'));
  const result=await reader.readWriting({classId:'1294',studentRef:a,testSlug:one.testSlug,resultRef:one.resultRef});
  assert.equal(result.tasks.length,2);assert.equal(result.tasks[0].score,0);assert.equal(result.tasks[1].essay,'The actual saved essay.');
  assert.equal(result.tasks[1].criteria[0].components[0].name,'Ideas');assert.doesNotMatch(JSON.stringify(result),new RegExp(attempt+'|PRIVATE_KEY|attemptToken','u'));
  assert.equal(await reader.readWriting({classId:'1294',studentRef:b,testSlug:one.testSlug,resultRef:one.resultRef}),null);
  assert.equal(await reader.readWriting({classId:'9999',studentRef:a,testSlug:one.testSlug,resultRef:one.resultRef}),null);
  assert.equal(await reader.readWriting({classId:'1294',studentRef:a,testSlug:one.testSlug,resultRef:'f'.repeat(64)}),null);
  await db.exec(`UPDATE assessment.term_test_writing_grading_final SET status='pending'`);
  const pending=(await reader.readStudent({classId:'1294',studentRef:a})).find(r=>r.testSlug==='term-test-1');
  assert.deepEqual(pending.writing.tasks,{1:{score:null,status:'pending'},2:{score:null,status:'pending'}});
  assert.equal(await reader.readWriting({classId:'1294',studentRef:a,testSlug:one.testSlug,resultRef:one.resultRef}),null);
 }finally{await db.close();}
});

test('Thẻ 20 HTTP cổng lớp/tên và Writing chỉ đọc, kiểm Journey và từ chối đổi lớp/đổi người/bản cũ',async()=>{
 const db=await fixture();try{
  const reader=createLearningTestResultReader({pool:db}),rows=await reader.readStudent({classId:'1294',studentRef:a}),source=rows.find(r=>r.testSlug==='term-test-1');
  const service={async getStudentCourseJourney(input){
   if(input.publicToken!==token||input.studentRef!==a)throw new LearningError('PROGRESS_LINK_INVALID','Không có quyền Journey.',404);
   return {class:{classId:'1294',name:'IC_TEST20'},student:{studentRef:a,name:'Học viên A'},externalTests:rows,sessions:[]};
  }};
  const app=express();app.use(express.json());const router=express.Router();registerStudentPortalRoutes(router,{pool:db,service,testResultReader:reader,limiter:(_q,_s,next)=>next()});app.use(router);
  app.use((error,_req,res,_next)=>res.status(error.httpStatus||500).json({ok:false,error:error.code||'ERROR'}));
  const before=(await db.query(`SELECT count(*)::int AS n FROM assessment.term_test_attempt`)).rows[0].n;
  const list=await request(app).get('/student/portal-classes').expect(200);assert.deepEqual(list.body.classes,[{classId:'1294',name:'IC_TEST20'}]);
  const context=await request(app).post('/student/portal-context').send({classId:'1294'}).expect(200);assert.equal(context.body.students.length,2);assert.equal(context.body.students[0].publicToken,token);
  await request(app).post('/student/portal-context').send({classId:'9999'}).expect(404);
  // Mã khóa lịch sử hoặc chưa ghi mã khóa không được làm biến mất lớp đã phát hành.
  for(const courseCode of ['IC2174',null]){
    await db.query(`UPDATE learning.form_assignment SET course_code=$1 WHERE id=$2::uuid`,[courseCode,token]);
    const legacy=await request(app).get('/student/portal-classes').expect(200);assert.equal(legacy.body.classes[0].classId,'1294');
    const legacyContext=await request(app).post('/student/portal-context').send({classId:'1294'}).expect(200);assert.equal(legacyContext.body.students.length,2);
  }
  const input={publicToken:token,studentRef:a,identityConfirmed:true,testSlug:source.testSlug,resultRef:source.resultRef};
  const ready=await request(app).post('/student/writing-test-result').send(input).expect(200);assert.equal(ready.body.result.readOnly,true);assert.equal(ready.headers['cache-control'],'no-store');
  await request(app).post('/student/writing-test-result').send({...input,classId:'9999'}).expect(400);
  await request(app).post('/student/writing-test-result').send({...input,studentRef:b}).expect(404);
  await request(app).post('/student/writing-test-result').send({...input,resultRef:'f'.repeat(64)}).expect(409);
  await request(app).post('/student/writing-test-result').send({...input,attemptToken:attempt}).expect(400);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM assessment.term_test_attempt`)).rows[0].n,before);
 }finally{await db.close();}
});
