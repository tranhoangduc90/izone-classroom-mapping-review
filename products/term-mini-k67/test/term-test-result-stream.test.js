import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../src/app.js';
import {PGlite} from '@electric-sql/pglite';
import {resultStreamStatusSql} from '../src/term-test-result-stream.js';

const token='00000000-0000-4000-8000-000000000091';
const config={nodeEnv:'test',authMode:'legacy',legacyReviewToken:'fixture-only',allowedOrigins:new Set(),trustProxyHops:0};

// HTTP thật localhost với trạng thái giả: không gọi AI, Portal hoặc database production.
async function fixture(t, rows, options={}) {
  let queries=0;
  const app=createApp({config,pool:{query:async()=>{queries++;const row=typeof rows==='function'?await rows(queries):rows;return{rows:row?[row]:[],rowCount:row?1:0};}},resultStreamOptions:{pollIntervalMs:10,heartbeatMs:10,maxDurationMs:120,...options}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const url=`http://127.0.0.1:${server.address().port}/api/term-tests/result/stream`;
  const post=(body={attemptToken:token},signal)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  return{post,queries:()=>queries};
}

test('stream tồn tại: bài đã chấm trả ready ngay, không trả bài viết/định danh/điểm',async t=>{
  const f=await fixture(t,{status:'ready'});const response=await f.post();
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'),'no');
  const text=await response.text();assert.match(text,/event: ready\ndata: \{"status":"ready"\}/);
  assert.doesNotMatch(text,/student|essay|score|attemptToken/);assert.equal(f.queries(),1);
});
test('mã sai và lượt không tồn tại bị từ chối trước mở stream',async t=>{
  const f=await fixture(t,null);assert.equal((await f.post({attemptToken:'invalid'})).status,400);
  assert.equal(f.queries(),0);assert.equal((await f.post()).status,404);
});
test('chờ rồi ready: thông báo đúng một lần, không truy vấn chồng',async t=>{
  let busy=0,maxBusy=0;
  const f=await fixture(t,async count=>{busy++;maxBusy=Math.max(maxBusy,busy);await new Promise(r=>setTimeout(r,15));busy--;return{status:count<3?'waiting':'ready'};});
  const response=await f.post();const text=await response.text();assert.match(text,/event: waiting/);
  assert.equal((text.match(/event: ready/g)||[]).length,1);assert.equal(maxBusy,1);
});
test('review_required đánh thức giao diện; stream hết thời gian đóng có kiểm soát',async t=>{
  const reviewed=await fixture(t,{status:'review_required'});assert.match(await (await reviewed.post()).text(),/event: ready\ndata: \{"status":"review_required"\}/);
  const waiting=await fixture(t,{status:'waiting'},{maxDurationMs:35});assert.match(await (await waiting.post()).text(),/event: close/);
});
test('lỗi DB không phát ready giả và không trả nội dung lỗi',async t=>{
  const f=await fixture(t,count=>{if(count>1)throw Error('private-db-error');return{status:'waiting'};});
  const text=await(await f.post()).text();assert.match(text,/event: close/);assert.doesNotMatch(text,/event: ready|private-db-error/);
});
test('đóng tab giải phóng stream và hạn theo lượt, không giữ vòng đọc nền',async t=>{
  const f=await fixture(t,{status:'waiting'},{maxPerAttempt:1,maxDurationMs:300});
  const controller=new AbortController();const first=await f.post(undefined,controller.signal);
  assert.equal(first.status,200);assert.equal((await f.post()).status,429);
  controller.abort();await new Promise(r=>setTimeout(r,35));
  const count=f.queries();await new Promise(r=>setTimeout(r,35));assert.equal(f.queries(),count);
  const retry=await f.post();assert.equal(retry.status,200);await retry.body.cancel();
});

test('SQL thật chỉ đọc đúng lượt đã nộp Writing và trạng thái chấm của lượt đó',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE SCHEMA assessment;
      CREATE TABLE assessment.term_test_attempt(id uuid PRIMARY KEY,listening_submitted_at timestamptz,writing_submitted_at timestamptz);
      CREATE TABLE assessment.term_test_writing_grading_final(attempt_id uuid PRIMARY KEY,status text);
      INSERT INTO assessment.term_test_attempt VALUES ('${token}',now(),NULL),('00000000-0000-4000-8000-000000000092',now(),now());
      INSERT INTO assessment.term_test_writing_grading_final VALUES ('00000000-0000-4000-8000-000000000092','ready');`);
    const read=async id=>(await db.query(resultStreamStatusSql,[id])).rows;
    assert.deepEqual(await read(token),[]);
    await db.query('UPDATE assessment.term_test_attempt SET writing_submitted_at=now() WHERE id=$1',[token]);
    assert.deepEqual(await read(token),[{status:'waiting'}]);
    await db.query('INSERT INTO assessment.term_test_writing_grading_final VALUES ($1,$2)',[token,'ready']);
    assert.deepEqual(await read(token),[{status:'ready'}]);
    assert.deepEqual(await read('00000000-0000-4000-8000-000000000099'),[]);
  } finally {await db.close();}
});
