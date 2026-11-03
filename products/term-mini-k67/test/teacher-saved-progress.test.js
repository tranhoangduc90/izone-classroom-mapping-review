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

test('K67 compact saved progress: index omits content, selected views equal legacy data and detect same-timestamp edits',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO assessment.term_test_attempt(id,client_submission_id,test_slug,definition_version,erp_course_class_id,
   class_name_snapshot,erp_student_contact_id,student_name_snapshot,exam_session_id,attempt_mode,exam_mode,exam_delivery,
   reading_started_at,reading_deadline_at,reading_draft,reading_draft_updated_at,writing_started_at,writing_updated_at,writing_task_2,
   listening_answers,listening_result,listening_submitted_at,reading_answers,reading_result,reading_submitted_at,combined_result,completed_at)
   VALUES($1,$1,'mini-test-lesson-5',1,1293,'IC2304',900001,'Học viên mô phỏng',$2,'cbt','read_first','cbt',now(),now()+interval '60 minutes','{"14":"C"}',
    '2026-11-01T00:00:00Z',now(),'2026-11-01T00:00:00Z',$3,'{}','{}',now(),'{"14":"C"}','{}',now(),'{}',now())`,[attempt,session,'Bản Writing riêng '.repeat(1200)]);
  const read=extra=>readTeacherSavedProgress(f.pool,{...input,...extra},email,authorization);
  const legacy=await read({}),index=await read({mode:'index'}),summary=index.attempts[0];
  assert.equal(index.format,'saved-progress-index-v1');assert.equal(summary.viewId,legacy.attempts[0].viewId);
  assert.match(summary.revision,/^[a-f0-9]{32}$/);
  for(const key of ['listening','reading','writing'])assert.equal(Object.hasOwn(summary,key),false);
  assert.equal(JSON.stringify(index).includes('Bản Writing riêng'),false);assert.equal(JSON.stringify(index).includes(attempt),false);
  const before=(await f.db.query('SELECT to_jsonb(a) AS value FROM assessment.term_test_attempt a')).rows;
  const detail=await read({mode:'view',viewId:summary.viewId}),{revision,...original}=detail.attempts[0];
  assert.equal(detail.format,'saved-progress-view-v1');assert.equal(revision,summary.revision);assert.deepEqual(original,legacy.attempts[0]);
  assert.deepEqual((await f.db.query('SELECT to_jsonb(a) AS value FROM assessment.term_test_attempt a')).rows,before);
  const savedAt=detail.attempts[0].writing.savedAt;
  await f.db.query(`UPDATE assessment.term_test_attempt SET writing_task_2='Nội dung vừa sửa' WHERE id=$1`,[attempt]);
  const changed=await read({mode:'index'});assert.notEqual(changed.attempts[0].revision,revision);
  const latest=await read({mode:'view',viewId:summary.viewId});assert.equal(latest.attempts[0].writing.savedAt,savedAt);
  assert.equal(latest.attempts[0].writing.task2,'Nội dung vừa sửa');
  await assert.rejects(read({mode:'view',viewId:'0'.repeat(64)}),e=>e.status===404&&e.code==='SAVED_VIEW_NOT_FOUND');
  await assert.rejects(read({mode:'view',viewId:summary.viewId,student:emptyRef}),e=>e.status===404);
  await f.db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[email]);
  for(const mode of ['index','view'])await assert.rejects(read({mode,...(mode==='view'?{viewId:summary.viewId}:{})}),e=>e.status===403);
 }finally{await f.db.close();}
});

test('K67 compact saved progress: historical session views remain selectable and deletion invalidates only that view',async()=>{
 const f=await fixture();try{
  const read=extra=>readTeacherSavedProgress(f.pool,{...input,...extra},email,authorization);
  const old=(await read({mode:'index'})).attempts[0];
  await f.db.query('UPDATE assessment.term_test_exam_session SET superseded_at=now() WHERE id=$1',[session]);
  const second='60000000-0000-4000-8000-000000000003';
  await f.db.query(`INSERT INTO assessment.term_test_exam_session(id,test_slug,definition_version,erp_course_class_id,class_name_snapshot,
   erp_student_contact_id,student_name_snapshot,attempt_mode,listening_draft)
   VALUES($1,'mini-test-lesson-5',1,1293,'IC2304',900001,'Học viên mô phỏng','cbt','{"11":"Lượt mới"}')`,[second]);
  const index=await read({mode:'index'});assert.equal(index.attempts.length,2);
  const current=index.attempts.find(a=>a.viewId!==old.viewId);
  assert.equal((await read({mode:'view',viewId:old.viewId})).attempts[0].listening.answers['11'],'B');
  assert.equal((await read({mode:'view',viewId:current.viewId})).attempts[0].listening.answers['11'],'Lượt mới');
  await f.db.query('DELETE FROM assessment.term_test_exam_session WHERE id=$1',[session]);
  assert.deepEqual((await read({mode:'index'})).attempts,[current]);
  await assert.rejects(read({mode:'view',viewId:old.viewId}),e=>e.code==='SAVED_VIEW_NOT_FOUND');
 }finally{await f.db.close();}
});

test('K67 compact saved progress HTTP: strict selector contract, native auth, no-store and unchanged legacy response',async()=>{
 const f=await fixture();try{
  const api=()=>request(f.app).get('/api/term-tests/teacher/saved-progress').set('x-review-token','fixture-only-key');
  for(const extra of [{viewId:'a'.repeat(64)},{mode:'view'},{mode:'index',viewId:'a'.repeat(64)},
   {mode:'view',viewId:session},{mode:'unknown'},{mode:'index',extra:'bad'}])await api().query({...input,...extra}).expect(400);
  const legacy=await api().query(input).expect(200);assert.equal(Object.hasOwn(legacy.body,'format'),false);
  assert.equal(Object.hasOwn(legacy.body.attempts[0],'revision'),false);
  const index=await api().query({...input,mode:'index'}).expect(200);assert.match(index.headers['cache-control'],/no-store/);
  const selected=await api().query({...input,mode:'view',viewId:index.body.attempts[0].viewId}).expect(200);
  const {revision,...body}=selected.body.attempts[0];assert.equal(revision,index.body.attempts[0].revision);
  assert.deepEqual(body,legacy.body.attempts[0]);
 }finally{await f.db.close();}
});

test('Saved progress mode matrix: K67 answer-sheet and Reading-first views preserve native legacy data without changing clocks',async()=>{
 const f=await fixture();try{
  for(const [mode,order,delivery] of [['answer_sheet','lis_first','answer_sheet'],['cbt','read_first','cbt']]){
   await f.db.query('UPDATE assessment.term_test_exam_session SET attempt_mode=$1,exam_mode=$2 WHERE id=$3',[mode,order,session]);
   const before=(await f.db.query('SELECT to_jsonb(s) AS value FROM assessment.term_test_exam_session s')).rows;
   const legacy=await readTeacherSavedProgress(f.pool,input,email,authorization);
   const index=await readTeacherSavedProgress(f.pool,{...input,mode:'index'},email,authorization);
   assert.equal(index.attempts.length,1);assert.equal(index.attempts[0].order,order);assert.equal(index.attempts[0].delivery,delivery);
   const view=await readTeacherSavedProgress(f.pool,{...input,mode:'view',viewId:index.attempts[0].viewId},email,authorization);
   const {revision,...saved}=view.attempts[0];assert.equal(revision,index.attempts[0].revision);assert.deepEqual(saved,legacy.attempts[0]);
   assert.deepEqual((await f.db.query('SELECT to_jsonb(s) AS value FROM assessment.term_test_exam_session s')).rows,before);
  }
 }finally{await f.db.close();}
});
