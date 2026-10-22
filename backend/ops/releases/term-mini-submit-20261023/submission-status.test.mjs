// SQL thật trên PostgreSQL thử hoặc PGlite cục bộ; không dùng bài/điểm production.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readSubmissionStatus,mountSubmissionStatus} from './submission-status.mjs';
const require=createRequire(process.env.SUBMIT_DEPS_PACKAGE||new URL('../../../../products/term-mini-k67/package.json',import.meta.url));
let db;const queries=[];
const pool={async query(text,args){queries.push(text);assert.match(text,/^SELECT /);return db.query(text,args);}};
const session='22222222-2222-4222-8222-222222222222',attempt='33333333-3333-4333-8333-333333333333',client='44444444-4444-4444-8444-444444444444';
const input=()=>({section:'listening',examSessionToken:session,clientSubmissionId:client,generation:0});
before(async()=>{
 if(process.env.SUBMIT_PG_URL){const {Pool}=require('pg');db=new Pool({connectionString:process.env.SUBMIT_PG_URL});}
 else{const {PGlite}=require('@electric-sql/pglite');db=new PGlite();}
 const setup=`CREATE SCHEMA assessment;
 CREATE TABLE assessment.term_test_exam_session(id uuid PRIMARY KEY,test_slug text,generation integer DEFAULT 0,superseded_at timestamptz,listening_started_at timestamptz,listening_deadline_at timestamptz,listening_submitted_at timestamptz,attempt_mode text DEFAULT 'cbt');
 CREATE TABLE assessment.term_test_attempt(id uuid PRIMARY KEY,exam_session_id uuid,client_submission_id uuid,test_slug text,generation integer DEFAULT 0,superseded_at timestamptz,listening_submitted_at timestamptz,reading_submitted_at timestamptz,completed_at timestamptz,listening_answers jsonb,reading_answers jsonb,listening_result jsonb,student_name_snapshot text,exam_mode text,attempt_mode text,reading_draft jsonb,reading_draft_revision int,reading_deadline_at timestamptz,writing_submitted_at timestamptz);
 INSERT INTO assessment.term_test_exam_session(id,test_slug,listening_started_at,listening_deadline_at)VALUES('${session}','term-test-1',now(),now()+interval '20 minutes');
 INSERT INTO assessment.term_test_attempt(id,exam_session_id,client_submission_id,test_slug,listening_answers,reading_answers,student_name_snapshot,exam_mode,attempt_mode)VALUES('${attempt}','${session}','${client}','term-test-1','{"1":"A"}','{"1":"B"}','Học viên giả','lis_first','cbt');`;
 for(const statement of setup.split(';').filter(s=>s.trim()))await db.query(statement);
});
after(async()=>{if(db.end)await db.end();else await db.close();});
test('Phiên chưa nộp trả chưa lưu; chỉ SELECT, không mở phiên/chấm/Portal',async()=>{assert.deepEqual(await readSubmissionStatus(pool,'term-test-1',input()),{ok:true,persisted:false});});
test('Bỏ qua roster: biên nhận lấy đúng snapshot đã commit; đọc không đổi hàng',async()=>{
 await db.query('UPDATE assessment.term_test_attempt SET listening_submitted_at=now() WHERE id=$1',[attempt]);
 const before=(await db.query('SELECT md5(to_jsonb(a)::text) AS hash FROM assessment.term_test_attempt a')).rows;
 const r=await readSubmissionStatus(pool,'term-test-1',input());assert.equal(r.persisted,true);assert.equal(r.receipt.attemptToken,attempt);assert.deepEqual(r.receipt.answers,{1:'A'});assert.equal(r.response.portalSyncStatus,'unknown');assert.match(r.receipt.snapshotHash,/^[a-f0-9]{64}$/);
 assert.deepEqual((await db.query('SELECT md5(to_jsonb(a)::text) AS hash FROM assessment.term_test_attempt a')).rows,before);
});
test('Reading chưa nộp không mượn biên nhận Listening',async()=>assert.equal((await readSubmissionStatus(pool,'term-test-1',{...input(),section:'reading'})).persisted,false));
test('Đọc Reading bằng attempt token sau commit và không ghi lại',async()=>{
 await db.query('UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),completed_at=now() WHERE id=$1',[attempt]);
 const r=await readSubmissionStatus(pool,'term-test-1',{section:'reading',attemptToken:attempt,generation:0});assert.equal(r.persisted,true);assert.deepEqual(r.receipt.answers,{1:'B'});assert.equal(r.response.completed,true);
});
for(const [name,data,code]of [
 ['generation khác',{...input(),generation:1},'STALE_GENERATION'],
 ['hai token khác lượt',{...input(),attemptToken:client},'TOKEN_MISMATCH'],
 ['mã gửi khác',{...input(),clientSubmissionId:attempt},'SUBMISSION_ID_CONFLICT'],
 ['không có token',{section:'listening'},'SUBMISSION_TOKEN_REQUIRED'],
 ['token lỗi',{...input(),examSessionToken:'bad'},'INVALID_SUBMISSION_STATUS']])test(name,async()=>assert.rejects(readSubmissionStatus(pool,'term-test-1',data),e=>e.code===code));
test('Sai test không trả dữ liệu của test khác',async()=>assert.rejects(readSubmissionStatus(pool,'term-test-2',input()),e=>e.status===404));
test('Guard audio chủ cũ vẫn được thực thi cả khi đọc bài đã nộp',async()=>assert.rejects(readSubmissionStatus(pool,'term-test-1',input(),()=>{throw Object.assign(Error('owner'),{code:'AUDIO_OWNER_REQUIRED'});}),e=>e.code==='AUDIO_OWNER_REQUIRED'));
test('Phiếu legacy tìm bằng mã gửi, không cần roster hoặc tạo bài',async()=>{const r=await readSubmissionStatus(pool,'term-test-1',{section:'listening',clientSubmissionId:client});assert.equal(r.receipt.attemptToken,attempt);});
test('Lượt đã thay thế không đọc thành biên nhận hiện hành',async()=>{await db.query('UPDATE assessment.term_test_attempt SET superseded_at=now() WHERE id=$1',[attempt]);await assert.rejects(readSubmissionStatus(pool,'term-test-1',{section:'reading',attemptToken:attempt}),e=>e.status===404);await db.query('UPDATE assessment.term_test_attempt SET superseded_at=NULL WHERE id=$1',[attempt]);});
test('Route HTTP chỉ đọc trả Cache-Control và lỗi validation đúng status',async()=>{
 const express=require('express'),app=express();app.use(express.json());mountSubmissionStatus(app,{pool,limiter:(_q,_s,n)=>n()});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const post=body=>fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/term-test-1/submission-status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{const r=await post(input());assert.equal(r.status,200);assert.equal((await r.json()).persisted,true);assert.match(r.headers.get('cache-control'),/no-store/);
 assert.equal((await post({section:'listening'})).status,400);}finally{await new Promise(r=>server.close(r));}
});

for(const slug of ['term-test-1','term-test-2','mini-test-lesson-5','term-test-1-k56','term-test-2-k56','mini-test-k56'])
for(const mode of ['lis_first','read_first'])test(`${slug}/${mode}: biên nhận L/R cùng lượt, giữ điểm 0`,async()=>{
 await db.query('UPDATE assessment.term_test_exam_session SET test_slug=$1',[slug]);
 await db.query("UPDATE assessment.term_test_attempt SET test_slug=$1,exam_mode=$2,listening_result='{\"correct\":0}',completed_at=CASE WHEN $2='lis_first' THEN now() ELSE NULL END",[slug,mode]);
 for(const section of ['listening','reading']){
  const r=await readSubmissionStatus(pool,slug,{...input(),section});
  assert.equal(r.persisted,true);assert.equal(r.response.examMode,mode);assert.equal(r.response.result.listening.correct,0);
  assert.equal(r.response.readingSubmitted,true);assert.equal(r.response.listeningSubmitted,true);
 }
});

if(process.env.SUBMIT_PG_URL)test('PostgreSQL nhiều connection: chưa commit không báo đã lưu; sau commit đọc đồng thời không mutation',async()=>{
 const a=await db.connect();
 try{
  await db.query("UPDATE assessment.term_test_exam_session SET test_slug='term-test-1'");
  await db.query("UPDATE assessment.term_test_attempt SET test_slug='term-test-1',listening_submitted_at=NULL");
  await a.query('BEGIN');await a.query('UPDATE assessment.term_test_attempt SET listening_submitted_at=now()');
  assert.equal((await readSubmissionStatus(pool,'term-test-1',input())).persisted,false);
  await a.query('COMMIT');
  const before=(await db.query('SELECT md5(to_jsonb(a)::text) AS hash FROM assessment.term_test_attempt a')).rows;
  const receipts=await Promise.all(Array.from({length:20},()=>readSubmissionStatus(pool,'term-test-1',input())));
  assert.ok(receipts.every(r=>r.persisted&&r.receipt.attemptToken===attempt));
  assert.deepEqual((await db.query('SELECT md5(to_jsonb(a)::text) AS hash FROM assessment.term_test_attempt a')).rows,before);
 }finally{await a.query('ROLLBACK');a.release();}
});
