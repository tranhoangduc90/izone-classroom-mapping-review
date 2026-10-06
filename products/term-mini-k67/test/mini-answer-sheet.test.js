import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {supersedeStaleTermTestExamSessionsSql} from '../src/sql.js';
let db,pool,api;
const ref='11111111-1111-4111-8111-111111111111';
const ref2='44444444-4444-4444-8444-444444444444';
const prefix='/api/term-tests/mini-test-lesson-5/answer-sheet';
before(async()=>{
  // PostgreSQL nhúng chạy SQL thật và constraint thật; không mô phỏng việc lưu/chấm.
  db=new PGlite();await db.exec('CREATE SCHEMA assessment;CREATE SCHEMA mapping;');
  const schema=await readFile(new URL('../db/003-assessment.sql',import.meta.url),'utf8');
  for(const name of ['test_definition','term_test_attempt','term_test_exam_session','term_test_roster','term_test_temporary_student']){
    const block=schema.match(new RegExp(`CREATE TABLE assessment\\.${name} \\([\\s\\S]*?\\n\\);`));assert.ok(block,name);await db.exec(block[0]);
  }
  for(const [sql] of schema.matchAll(/^CREATE UNIQUE INDEX .*;$/gm))if(/ON assessment\.term_test_(attempt|exam_session) /.test(sql))await db.exec(sql);
  await db.exec(`CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,erp_class_name_snapshot text);
    CREATE TABLE mapping.student_mapping_review(public_id uuid,erp_course_class_id bigint,erp_student_contact_id bigint,erp_student_name_snapshot text,status text);
    CREATE TABLE mapping.k67_context_state(singleton boolean,api_version int,product_id text,captured_at timestamptz);
    INSERT INTO mapping.k67_context_state VALUES(true,1,'PRODUCT-TERM-MINI-K67',now());
    INSERT INTO mapping.classroom_course_mapping VALUES(1293,'IC2304'),(-8062028,'CODEXDEMO806');
    INSERT INTO mapping.student_mapping_review VALUES('${ref}',1293,900001,'Học viên mô phỏng','approved'),('${ref2}',1293,900002,'Người khác','approved');`);
  const section={questions:[{number:11,type:'Một câu thử',accepted:['A']}]};
  await db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES('mini-test-lesson-5','Đề mô phỏng',1,$1,$1,true)`,[JSON.stringify(section)]);
  // Bài cũ có hạn nhưng chưa biết mode: chỉ lớp làm giấy đã xác minh được chuyển.
  await db.exec(`INSERT INTO assessment.term_test_exam_session
    (id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot)
    VALUES('77777777-7777-4777-8777-777777777777','mini-test-lesson-5',1,1293,'IC2304',900013,'CBT cũ');
    INSERT INTO assessment.term_test_attempt
    (test_slug,definition_version,client_submission_id,erp_course_class_id,class_name_snapshot,erp_student_contact_id,
     student_name_snapshot,listening_answers,listening_result,listening_submitted_at,reading_started_at,reading_deadline_at,completed_at,combined_result,exam_session_id)
    VALUES
    ('mini-test-lesson-5',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',1293,'IC2304',900010,'Bài giấy dở','{}','{}',now(),now(),now()+interval '20 minutes',NULL,NULL,NULL),
    ('mini-test-lesson-5',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',1293,'IC2304',900011,'Bài đã nộp','{}','{}',now(),now(),now()+interval '20 minutes',NULL,NULL,NULL),
    ('mini-test-lesson-5',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',1226,'IC2238',900012,'Lượt chưa xác minh','{}','{}',now(),now(),now()+interval '20 minutes',NULL,NULL,NULL),
    ('mini-test-lesson-5',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',1293,'IC2304',900013,'CBT cũ','{}','{}',now(),now(),now()+interval '20 minutes',NULL,NULL,'77777777-7777-4777-8777-777777777777');
    UPDATE assessment.term_test_attempt SET completed_at=now(),reading_submitted_at=now(),
      reading_answers='{"14":"i"}',reading_result='{"correct":11}',combined_result='{"preserve":11}'
      WHERE erp_student_contact_id=900011;`);
  await db.exec(await readFile(new URL('../db/007-mini-answer-sheet.sql',import.meta.url),'utf8'));
  const query=async(sql,args)=>{try{const r=await db.query(sql,args);return{...r,rowCount:r.rows.length||r.affectedRows||0};}
    catch(error){console.error('SQL fixture:',error.code,error.message);throw error;}};
  pool={query,connect:async()=>({query,release(){}})};
  api=request(createApp({pool,config:{allowedOrigins:new Set(),trustProxyHops:0,authMode:'legacy',legacyReviewToken:'fixture-only-key'}}));
});
after(async()=>await db?.close());
let opened,attempt;
test('Migration chuyển đúng bài giấy IC2304, giữ điểm/hạn lịch sử và không chuyển lượt chưa xác minh/CBT',async()=>{
  const rows=(await db.query('SELECT * FROM assessment.term_test_attempt WHERE erp_student_contact_id>=900010 ORDER BY erp_student_contact_id')).rows;
  assert.equal(rows[0].attempt_mode,'answer_sheet');assert.equal(rows[0].reading_deadline_at,null);
  assert.equal(rows[1].attempt_mode,'answer_sheet');assert.ok(rows[1].reading_deadline_at);assert.deepEqual(rows[1].combined_result,{preserve:11});
  for(const row of rows.slice(2)){assert.equal(row.attempt_mode,'legacy');assert.ok(row.reading_deadline_at);}
  await db.exec(await readFile(new URL('../db/007-mini-answer-sheet.sql',import.meta.url),'utf8'));
  const again=(await db.query('SELECT * FROM assessment.term_test_attempt WHERE erp_student_contact_id>=900010 ORDER BY erp_student_contact_id')).rows;
  assert.deepEqual(again,rows);
});
test('Chỉ mở sau xác nhận, lớp thử bị ẩn và lớp/tên sai không tạo lượt',async()=>{
  const before=(await db.query('SELECT count(*) FROM assessment.term_test_exam_session')).rows[0].count;
  assert.equal((await api.post(prefix+'/open').send({classCode:'IC2304',studentRef:ref})).status,400);
  assert.equal((await api.post(prefix+'/open').send({classCode:'WRONG',studentRef:ref,identityConfirmed:true})).status,404);
  assert.equal((await db.query('SELECT count(*) FROM assessment.term_test_exam_session')).rows[0].count,before);
  const classes=await api.get(prefix+'/classes');assert.equal(classes.status,200);assert.deepEqual(classes.body.classes,[{name:'IC2304'}]);
  const first=await api.post(prefix+'/open').send({classCode:'IC2304',studentRef:ref,identityConfirmed:true});assert.equal(first.status,200,JSON.stringify(first.body));
  opened=first.body;assert.equal(opened.policy.timed,false);assert.equal(opened.listeningDeadlineAt,null);
  const second=await api.post(prefix+'/open').send({classCode:'IC2304',studentRef:ref,identityConfirmed:true});assert.equal(second.body.examSessionToken,opened.examSessionToken);
});
test('Listening lưu nháp và nộp lặp giữ một kết quả, không cấp hạn',async()=>{
  const body={examSessionToken:opened.examSessionToken,generation:0,revision:1,answers:{11:'A'}};
  assert.equal((await api.post(prefix+'/listening/draft').send(body)).status,200);
  const submit={...body,clientSubmissionId:'55555555-5555-4555-8555-555555555555'};
  const done=await api.post(prefix+'/listening').send(submit);assert.equal(done.status,201,JSON.stringify(done.body));attempt=done.body.attemptToken;
  const again=await api.post(prefix+'/listening').send({...submit,answers:{11:'B'}});assert.equal(again.body.attemptToken,attempt);
  const row=(await db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attempt])).rows[0];assert.equal(row.listening_result.correct,1);assert.equal(row.attempt_mode,'answer_sheet');
});
test('Quá 8 giờ vẫn nối đúng lượt, Reading nhận bản nháp không có hạn',async()=>{
  await db.query("UPDATE assessment.term_test_attempt SET created_at=now()-interval '2 days' WHERE id=$1",[attempt]);
  const resumed=await api.post(prefix+'/open').send({classCode:'IC2304',studentRef:ref,identityConfirmed:true});assert.equal(resumed.body.attemptToken,attempt);
  const start=await api.post(prefix+'/reading/start').send({attemptToken:attempt,generation:0});assert.equal(start.status,200,JSON.stringify(start.body));assert.equal(start.body.readingDeadlineAt,null);
  await db.query("UPDATE assessment.term_test_attempt SET reading_started_at=now()-interval '2 days' WHERE id=$1",[attempt]);
  const saved=await api.post(prefix+'/reading/draft').send({attemptToken:attempt,generation:0,revision:3,answers:{11:'A'}});assert.equal(saved.status,200);
  const old=await api.post(prefix+'/reading/draft').send({attemptToken:attempt,generation:0,revision:2,answers:{11:'B'}});assert.equal(old.body.accepted,false);assert.equal(old.body.draft[11],'A');
});
test('Đổi URL hoặc thế hệ cũ không bỏ hạn CBT hay nộp bài sau mở lại',async()=>{
  const oldRoute=await api.post('/api/term-tests/mini-test-lesson-5/reading/start').send({attemptToken:attempt});assert.equal(oldRoute.status,404);
  await db.query('UPDATE assessment.term_test_attempt SET generation=1 WHERE id=$1',[attempt]);
  await db.query('UPDATE assessment.term_test_exam_session SET generation=1 WHERE id=$1',[opened.examSessionToken]);
  const oldListening=await api.post(prefix+'/listening').send({examSessionToken:opened.examSessionToken,generation:0,
    clientSubmissionId:'55555555-5555-4555-8555-555555555555',answers:{11:'B'}});
  assert.equal(oldListening.status,409);assert.equal(oldListening.body.error,'STALE_GENERATION');
  const old=await api.post(prefix+'/reading').send({attemptToken:attempt,generation:0,answers:{11:'B'}});assert.equal(old.status,409);assert.equal(old.body.error,'STALE_GENERATION');
  assert.equal((await db.query('SELECT completed_at FROM assessment.term_test_attempt WHERE id=$1',[attempt])).rows[0].completed_at,null);
  await db.query("UPDATE assessment.term_test_attempt SET attempt_mode='legacy',reading_deadline_at=now()+interval '20 minutes' WHERE id=$1",[attempt]);
  const cbt=await api.post(prefix+'/reading').send({attemptToken:attempt,generation:1,answers:{11:'B'}});assert.equal(cbt.status,409);assert.equal(cbt.body.error,'MODE_CONFLICT');
  await db.query("UPDATE assessment.term_test_attempt SET attempt_mode='answer_sheet',reading_deadline_at=NULL WHERE id=$1",[attempt]);
});
test('Reading nộp chủ động và retry giữ điểm, người khác không nối nhầm bài',async()=>{
  const done=await api.post(prefix+'/reading').send({attemptToken:attempt,generation:1,answers:{11:'A'}});assert.equal(done.status,200);assert.equal(done.body.result.reading.correct,1);
  const again=await api.post(prefix+'/reading').send({attemptToken:attempt,generation:1,answers:{11:'B'}});assert.equal(again.body.result.reading.correct,1);
  const other=await api.post(prefix+'/open').send({classCode:'IC2304',studentRef:ref2,identityConfirmed:true});assert.equal(other.status,200);assert.notEqual(other.body.examSessionToken,opened.examSessionToken);assert.equal(other.body.attemptToken,null);
  await db.query("UPDATE assessment.term_test_exam_session SET prepared_at=now()-interval '2 days' WHERE id=$1",[other.body.examSessionToken]);
  await pool.query(supersedeStaleTermTestExamSessionsSql,['mini-test-lesson-5',1,1293,900002]);
  const nextDay=await api.post(prefix+'/open').send({classCode:'IC2304',studentRef:ref2,identityConfirmed:true});assert.equal(nextDay.body.examSessionToken,other.body.examSessionToken);
  await db.query("UPDATE assessment.term_test_exam_session SET attempt_mode='legacy',listening_deadline_at=now()+interval '30 minutes' WHERE id=$1",[other.body.examSessionToken]);
  const cbtOpen=await api.post(prefix+'/open').send({classCode:'IC2304',studentRef:ref2,identityConfirmed:true});
  assert.equal(cbtOpen.status,409);assert.equal(cbtOpen.body.error,'MODE_CONFLICT');
  assert.ok((await db.query('SELECT listening_deadline_at FROM assessment.term_test_exam_session WHERE id=$1',[other.body.examSessionToken])).rows[0].listening_deadline_at);
});
