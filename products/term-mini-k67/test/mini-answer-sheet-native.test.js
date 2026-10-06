import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {before, after} from 'node:test';
import pg from 'pg';
import request from 'supertest';
import {createApp} from '../src/app.js';

// Chỉ chạy trên kho giả đã xác minh; dùng role ứng dụng thật và nhiều connection.
function url(field, role) {
  assert.equal(process.env.K67_TEST_FIXTURE_CONFIRMATION, 'synthetic-fixture-20261006');
  const value = new URL(process.env[field]);
  assert.equal(value.hostname, '127.0.0.1');
  assert.equal(value.pathname, '/term_mini_k67_test_database');
  assert.equal(value.username, role);
  return value.href;
}
const pool = new pg.Pool({connectionString:url('K67_TEST_DATABASE_URL','k67_app'),max:5,statement_timeout:10000});
const owner = new pg.Pool({connectionString:url('K67_TEST_OWNER_URL','k67_owner'),max:2});
const prefix='/api/term-tests/mini-test-lesson-5/answer-sheet';
const classId=9870678801, studentId=9870678802, ref=crypto.randomUUID();
const classCode='K67SIM_PAPER_'+crypto.randomBytes(4).toString('hex');
const config={allowedOrigins:new Set(),trustProxyHops:0,authMode:'legacy',legacyReviewToken:'fixture-only'};
let confirmed=false, opened, attempt;
const api=request(createApp({pool,config}));
before(async()=>{
  assert.deepEqual((await owner.query('SELECT * FROM mapping.k67_fixture_identity')).rows,
    [{product_id:'PRODUCT-TERM-MINI-K67',fixture_id:'synthetic-fixture-20261006'}]);
  confirmed=true;
  await owner.query('INSERT INTO mapping.classroom_course_mapping VALUES($1,$2)',[classId,classCode]);
  await owner.query(`INSERT INTO mapping.student_mapping_review(public_id,erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot,status)
    VALUES($1,$2,$3,'Học viên giả nhập giấy','approved')`,[ref,classId,studentId]);
  await owner.query(`INSERT INTO mapping.k67_context_state(api_version,product_id,source_revision,captured_at)
    VALUES(1,'PRODUCT-TERM-MINI-K67',repeat('a',64),now())
    ON CONFLICT(singleton) DO UPDATE SET captured_at=now()`);
  const section={questions:[{number:11,type:'Câu giả',accepted:['A']}]};
  await owner.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    VALUES('mini-test-lesson-5','Đề giả nhập giấy',1,$1,$1,true)
    ON CONFLICT(slug) DO UPDATE SET listening_definition=$1,reading_definition=$1`,[JSON.stringify(section)]);
});
after(async()=>{
  try {
    if(confirmed){
      // Giữ kho và schema; chỉ dọn học viên/lượt giả do ca này tạo.
      await owner.query('UPDATE assessment.term_test_attempt SET exam_session_id=NULL WHERE erp_course_class_id=$1',[classId]);
      await owner.query('UPDATE assessment.term_test_exam_session SET attempt_id=NULL WHERE erp_course_class_id=$1',[classId]);
      await owner.query('DELETE FROM assessment.term_test_exam_session WHERE erp_course_class_id=$1',[classId]);
      await owner.query('DELETE FROM assessment.term_test_attempt WHERE erp_course_class_id=$1',[classId]);
      await owner.query('DELETE FROM mapping.student_mapping_review WHERE public_id=$1',[ref]);
      await owner.query('DELETE FROM mapping.classroom_course_mapping WHERE erp_course_class_id=$1',[classId]);
      await owner.query('DELETE FROM mapping.k67_context_state');
    }
  }finally{await Promise.all([pool.end(),owner.end()]);}
});
test('PostgreSQL thật: hai lần mở đồng thời tạo một phiên giấy không hạn',async()=>{
  const body={classCode,studentRef:ref,identityConfirmed:true};
  const replies=await Promise.all([api.post(prefix+'/open').send(body),api.post(prefix+'/open').send(body)]);
  for(const reply of replies)assert.equal(reply.status,200,JSON.stringify(reply.body));
  opened=replies[0].body;
  assert.equal(replies[1].body.examSessionToken,opened.examSessionToken);
  assert.equal(opened.listeningDeadlineAt,null);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM assessment.term_test_exam_session WHERE erp_course_class_id=$1',[classId])).rows[0].n,1);
});
test('PostgreSQL thật: mở trang chờ nộp Listening rồi nối đúng attempt mới',async()=>{
  let release, reached;
  const pause=new Promise(resolve=>release=resolve), acquired=new Promise(resolve=>reached=resolve);
  const pausedPool={connect:async()=>{
    const client=await pool.connect();
    return {release:()=>client.release(),query:async(sql,args)=>{
      const result=await client.query(sql,args);
      if(sql.includes('pg_advisory_xact_lock')){reached();await pause;}
      return result;
    }};
  },query:(...args)=>pool.query(...args)};
  const paused=request(createApp({pool:pausedPool,config}));
  const submit=paused.post(prefix+'/listening').send({examSessionToken:opened.examSessionToken,generation:0,
    clientSubmissionId:crypto.randomUUID(),answers:{11:'A'}}).then(value=>value);
  let resume;
  try{
    await acquired;
    let settled=false;
    resume=api.post(prefix+'/open').send({classCode,studentRef:ref,identityConfirmed:true}).then(value=>{settled=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(settled,false);
    release();
    const [done,again]=await Promise.all([submit,resume]);
    assert.equal(done.status,201,JSON.stringify(done.body));assert.equal(again.status,200,JSON.stringify(again.body));
    attempt=done.body.attemptToken;
    assert.equal(again.body.attemptToken,attempt);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM assessment.term_test_attempt WHERE erp_course_class_id=$1',[classId])).rows[0].n,1);
  }finally{release();await Promise.allSettled([submit,resume]);}
});
test('PostgreSQL thật: Reading không hạn, nháp và nộp đồng thời giữ một kết quả',async()=>{
  const start=await api.post(prefix+'/reading/start').send({attemptToken:attempt,generation:0});
  assert.equal(start.status,200,JSON.stringify(start.body));assert.equal(start.body.readingDeadlineAt,null);
  await owner.query("UPDATE assessment.term_test_attempt SET reading_started_at=now()-interval '2 days' WHERE id=$1",[attempt]);
  const draft=await api.post(prefix+'/reading/draft').send({attemptToken:attempt,generation:0,revision:1,answers:{11:'A'}});
  assert.equal(draft.status,200,JSON.stringify(draft.body));
  const replies=await Promise.all([api.post(prefix+'/reading').send({attemptToken:attempt,generation:0,answers:{11:'A'}}),
    api.post(prefix+'/reading').send({attemptToken:attempt,generation:0,answers:{11:'B'}})]);
  for(const reply of replies)assert.equal(reply.status,200,JSON.stringify(reply.body));
  assert.deepEqual(replies[0].body.result,replies[1].body.result);
  const row=(await owner.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attempt])).rows[0];
  assert.ok(row.completed_at);assert.equal(row.reading_deadline_at,null);
  assert.equal(row.reading_result.correct,replies[0].body.result.reading.correct);
});
