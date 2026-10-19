import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {readTeacherSavedProgress} from '../src/teacher-saved-progress.js';

const ref='11111111-1111-4111-8111-111111111111',emptyRef='44444444-4444-4444-8444-444444444444';
const session='60000000-0000-4000-8000-000000000001',attempt='60000000-0000-4000-8000-000000000002';
const input={class:'IC2304',test:'mini-test-lesson-5',student:ref};
const email='teacher@fixture.test',authorization={source:'google_bearer',googleSubject:'subject-fixture'};

async function fixture(){
 const f=await createMiniFixture({examOrder:true,completeSchema:true});
 const schema=await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(schema.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
 await f.db.query(`INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,$2,'teacher','active')`,[email,authorization.googleSubject]);
 await f.db.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1293)',[email]);
 await f.db.exec("INSERT INTO mapping.classroom_course_mapping VALUES(1294,'IC2305')");
 await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
   erp_student_contact_id,student_name_snapshot,attempt_mode,listening_started_at,listening_deadline_at,listening_draft,listening_draft_updated_at)
   VALUES($1,'mini-test-lesson-5',1,1293,'IC2304',900001,'Học viên mô phỏng','cbt',now(),now()+interval '30 minutes','{"11":"B"}',now())`,[session]);
 return f;
}

test('K67: giảng viên thấy Listening đã lưu trước khi có attempt, không lộ token/đáp án đúng hoặc đổi đồng hồ',async()=>{
 const f=await fixture();try{
  const before=await f.db.query('SELECT row_to_json(s) AS value FROM assessment.term_test_exam_session s');
  const result=await readTeacherSavedProgress(f.pool,input,email,authorization);
  assert.equal(result.attempts.length,1);assert.deepEqual(result.attempts[0].listening.answers,{'11':'B'});
  assert.equal(result.attempts[0].listening.submittedAt,null);assert.equal(result.attempts[0].reading.startedAt,null);
  assert.equal(JSON.stringify(result).includes(session),false);assert.equal(JSON.stringify(result).includes('accepted'),false);
  assert.deepEqual((await f.db.query('SELECT row_to_json(s) AS value FROM assessment.term_test_exam_session s')).rows,before.rows);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
  const empty=await readTeacherSavedProgress(f.pool,{...input,student:emptyRef},email,authorization);assert.deepEqual(empty.attempts,[]);
 }finally{await f.db.close();}
});

test('K67: Reading trước và Writing chưa nộp đọc đúng snapshot; quyền bị rút có hiệu lực ngay',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE assessment.term_test_exam_session SET exam_mode='read_first' WHERE id=$1",[session]);
  await f.db.query(`INSERT INTO assessment.term_test_attempt(id,client_submission_id,test_slug,definition_version,erp_course_class_id,
   class_name_snapshot,erp_student_contact_id,student_name_snapshot,exam_session_id,attempt_mode,exam_mode,exam_delivery,
   reading_started_at,reading_deadline_at,reading_draft,reading_draft_updated_at)
   VALUES($1,$1,'mini-test-lesson-5',1,1293,'IC2304',900001,'Học viên mô phỏng',$2,'cbt','read_first','cbt',now(),now()+interval '60 minutes','{"14":"C"}',now())`,[attempt,session]);
  let result=await readTeacherSavedProgress(f.pool,input,email,authorization);
  assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].order,'read_first');assert.deepEqual(result.attempts[0].reading.answers,{'14':'C'});
  await f.db.query(`UPDATE assessment.term_test_attempt SET listening_answers='{"11":"D"}',listening_result='{}',listening_submitted_at=now(),
    reading_answers='{"14":"E"}',reading_result='{}',reading_submitted_at=now(),combined_result='{}',completed_at=now(),
    writing_started_at=now(),writing_updated_at=now(),writing_task_2='Bản Writing đang viết' WHERE id=$1`,[attempt]);
  const before=await f.db.query('SELECT row_to_json(a) AS value FROM assessment.term_test_attempt a');
  result=await readTeacherSavedProgress(f.pool,input,email,authorization);
  assert.deepEqual(result.attempts[0].reading.answers,{'14':'E'});assert.deepEqual(result.attempts[0].listening.answers,{'11':'D'});
  assert.equal(result.attempts[0].writing.task2,'Bản Writing đang viết');assert.equal(result.attempts[0].writing.submittedAt,null);
  assert.equal(JSON.stringify(result).includes(attempt),false);
  assert.deepEqual((await f.db.query('SELECT row_to_json(a) AS value FROM assessment.term_test_attempt a')).rows,before.rows);
  await assert.rejects(readTeacherSavedProgress(f.pool,{...input,class:'IC2305'},email,authorization),e=>e.status===403);
  await f.db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[email]);
  await assert.rejects(readTeacherSavedProgress(f.pool,input,email,authorization),e=>e.status===403);
 }finally{await f.db.close();}
});

test('K67 HTTP: phiên GV bắt buộc, query lạ bị từ chối và phản hồi không lưu đệm',async()=>{
 const f=await fixture();try{
  const url='/api/term-tests/teacher/saved-progress';
  await request(f.app).get(url).query(input).expect(401);
  await request(f.app).get(url).set('x-review-token','fixture-only-key').query({...input,extra:'bad'}).expect(400);
  const response=await request(f.app).get(url).set('x-review-token','fixture-only-key').query(input).expect(200);
  assert.match(response.headers['cache-control'],/no-store/);assert.equal(response.body.attempts[0].listening.answers['11'],'B');
 }finally{await f.db.close();}
});
