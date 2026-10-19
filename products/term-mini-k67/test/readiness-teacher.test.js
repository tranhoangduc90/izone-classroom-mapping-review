import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {createReadinessFixture} from './helpers/readiness-fixture.js';
import {createReadinessTeacher} from '../src/readiness-teacher.js';

const ref='11111111-1111-4111-8111-111111111111',session='90000000-0000-4000-8000-000000000001';
const email='readiness-teacher@fixture.test',auth={source:'google_bearer',googleSubject:'readiness-subject'};
async function fixture(){
 const f=await createReadinessFixture({audioSource:()=>{throw new Error('Giảng viên không được tải audio');}});
 const schema=await readFile(new URL('../db/001-context.sql',import.meta.url),'utf8');
 for(const name of ['reviewer_account','reviewer_class_access','reviewer_session'])await f.db.exec(schema.match(new RegExp(`CREATE TABLE mapping\\.${name} \\([\\s\\S]*?\\n\\);`))[0].replace('CREATE TABLE mapping.','CREATE TABLE IF NOT EXISTS mapping.'));
 await f.db.query("INSERT INTO mapping.reviewer_account(email,google_subject,role,status) VALUES($1,$2,'teacher','active')",[email,auth.googleSubject]);
 await f.db.query('INSERT INTO mapping.reviewer_class_access VALUES($1,1293)',[email]);
 await f.db.query(`INSERT INTO assessment.k67_readiness_session(id,token_hash,class_id,student_ref,pack_version,same_computer,same_headphones,
  answers,draft_revision,heard_seconds,reading_draft,reading_revision,writing_draft,writing_revision,check_report,check_revision)
  VALUES($1,'student-token-hash-private',1293,$2,'listening-familiarisation-v1',true,false,'{"1":"B"}',1,12,'{"1":"C"}',1,'{"text":"Bản Writing thử"}',1,'{"version":"web-check-v1","checks":[{"id":"session","state":"warn","code":"SLOW","at":"2026-10-19T02:00:00Z"}]}',1)`,[session,ref]);
 return {...f,teacher:createReadinessTeacher({pool:f.pool,classes:new Set(['IC2304'])})};
}

test('Làm quen: roster có người chưa mở, metadata không tải cả bài; chi tiết giữ bản chưa nộp và không đổi dữ liệu',async()=>{
 const f=await fixture();try{
  const before=await f.db.query('SELECT row_to_json(r) AS value FROM assessment.k67_readiness_session r');
  const classes=await f.teacher.classes(email,auth);assert.equal(classes.classes[0].classCode,'IC2304');
  const list=await f.teacher.students({classId:'1293'},email,auth);assert.equal(list.students.length,2);
  assert.deepEqual(list.students.find(s=>s.studentRef!==ref).sessions,[]);assert.equal(JSON.stringify(list).includes('Bản Writing thử'),false);
  const detail=await f.teacher.detail({classId:'1293',studentRef:ref},email,auth);
  assert.equal(detail.sessions[0].writingText,'Bản Writing thử');assert.deepEqual(detail.sessions[0].listeningAnswers,{'1':'B'});
  assert.equal(detail.sessions[0].submittedAt,null);assert.equal(detail.sessions[0].sameHeadphones,false);
  assert.equal(JSON.stringify(detail).includes('student-token-hash-private'),false);assert.equal(JSON.stringify(detail).includes(session),false);
  assert.deepEqual((await f.db.query('SELECT row_to_json(r) AS value FROM assessment.k67_readiness_session r')).rows,before.rows);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt')).rows[0].n,0);
 }finally{await f.db.close();}
});

test('Làm quen: không vượt lớp/cấu hình lớp và quyền GV bị rút có hiệu lực ngay',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.teacher.detail({classId:'1294',studentRef:ref},email,auth),e=>e.status===403);
  const disabled=createReadinessTeacher({pool:f.pool,classes:new Set()});await assert.rejects(disabled.students({classId:'1293'},email,auth),e=>e.status===403);
  await f.db.query('DELETE FROM mapping.reviewer_class_access WHERE reviewer_email=$1',[email]);
  await assert.rejects(f.teacher.detail({classId:'1293',studentRef:ref},email,auth),e=>e.status===403);
 }finally{await f.db.close();}
});

test('Làm quen HTTP: router GV có thật, cookie/quyền riêng; không đi vào nhánh audio học viên',async()=>{
 const f=await fixture();try{
  const path='/api/k67-readiness/v1/teacher';await request(f.app).get(path+'/classes').expect(401);
  const cookie={'x-review-token':'fixture-only-key'};
  const list=await request(f.app).get(path+'/classes').set(cookie).expect(200);assert.equal(list.body.classes[0].classId,'1293');
  const result=await request(f.app).get(path+'/students/'+ref).set(cookie).query({classId:'1293'}).expect(200);
  assert.equal(result.body.sessions[0].writingText,'Bản Writing thử');assert.match(result.headers['cache-control'],/no-store/);
  await request(f.app).get(path+'/students/'+ref).set(cookie).query({classId:'1293',extra:'bad'}).expect(400);
 }finally{await f.db.close();}
});
