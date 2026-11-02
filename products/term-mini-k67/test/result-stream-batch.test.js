import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../src/app.js';
import {resultStreamBatchStatusSql} from '../src/term-test-result-stream.js';
import {createResultSqlFixture} from './result-sql-fixture.mjs';
const tokens=[91,92,93].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
const config={nodeEnv:'test',authMode:'legacy',legacyReviewToken:'fixture-only',allowedOrigins:new Set(),trustProxyHops:0};
async function fixture(t,{queryDelayMs=0,...streamOptions}={}){
 const status=new Map(tokens.map(token=>[token,'waiting'])),queries=[];let invalid=false,busy=0,maxBusy=0;
 const pool={query:async input=>{
  const ids=Array.isArray(input.values[0])?input.values[0]:[input.values[0]];queries.push([...ids]);busy++;maxBusy=Math.max(maxBusy,busy);
  try{
   if(queryDelayMs)await new Promise(resolve=>setTimeout(resolve,queryDelayMs));
   const rows=ids.map(id=>id.toLowerCase()).filter(id=>status.has(id)).reverse().map(id=>({attempt_token:id,status:status.get(id)}));
   if(invalid)rows.push({attempt_token:'00000000-0000-4000-8000-000000000099',status:'ready'});
   return{rows,rowCount:rows.length};
  }finally{busy--;}
 }};
 const app=createApp({config,pool,resultStreamOptions:{pollIntervalMs:20,heartbeatMs:20,maxDurationMs:2000,...streamOptions}}),server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));const controllers=[];
 t.after(async()=>{controllers.forEach(c=>c.abort());await app.locals.termTestResultStream?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const post=token=>{const controller=new AbortController();controllers.push(controller);return fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/result/stream`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attemptToken:token}),signal:controller.signal});};
 return{app,post,status,queries,maxBusy:()=>maxBusy,abortLast(){controllers.at(-1).abort();},invalid(){invalid=true;}};
}
async function until(check,message){const deadline=Date.now()+700;while(!check()){assert.ok(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,5));}}

// Dữ liệu giả, HTTP thật; nhận ngược thứ tự và nhóm có số lượng thay đổi.
// Đếm những lượt database phải nhận, đồng thời đọc đúng thông báo từng trình duyệt.
test('Waiting attempts share a status batch and reversed rows keep each response bound to its attempt',async t=>{
 const f=await fixture(t),responses=await Promise.all(tokens.map(f.post));responses.forEach(r=>assert.equal(r.status,200));
 await until(()=>f.queries.some(ids=>tokens.every(token=>ids.includes(token))),'All active waiting attempts must share a database status read');
 f.status.set(tokens[0],'ready');f.status.set(tokens[1],'review_required');
 const [a,b]=await Promise.all(responses.slice(0,2).map(r=>r.text()));
 assert.match(a,/event: ready\ndata: \{"status":"ready"\}/);assert.doesNotMatch(a,/review_required/);
 assert.match(b,/event: ready\ndata: \{"status":"review_required"\}/);assert.doesNotMatch(a+b,/attempt_token|attemptToken|00000000|score|essay/);
 await responses[2].body.cancel();await new Promise(resolve=>setTimeout(resolve,40));const before=f.queries.length;
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(f.queries.length,before,'No SQL polling survives the last closed stream');
});
test('Missing attempts get their own404 without closing another waiting attempt',async t=>{
 const f=await fixture(t);f.status.delete(tokens[1]);
 const [waiting,missing]=await Promise.all([f.post(tokens[0]),f.post(tokens[1])]);assert.equal(waiting.status,200);assert.equal(missing.status,404);
 f.status.set(tokens[0],'ready');assert.match(await waiting.text(),/event: ready/);
});
test('Foreign batch rows never deliver another attempt ready and close safely',async t=>{
 const f=await fixture(t),response=await f.post(tokens[0]);assert.equal(response.status,200);f.invalid();
 const body=await response.text();assert.doesNotMatch(body,/event: ready|000000000099|private-db/);assert.match(body,/event: close/);
});
test('Slow status reads remain single-flight across multiple streams and shutdown reconnects them',async t=>{
 const f=await fixture(t,{queryDelayMs:25,pollIntervalMs:5});const responses=await Promise.all(tokens.map(f.post));
 await until(()=>f.queries.length>=3,'Observe repeated shared scans');assert.equal(f.maxBusy(),1);
 await f.app.locals.termTestResultStream.close();const bodies=await Promise.all(responses.map(r=>r.text()));
 bodies.forEach(body=>{assert.match(body,/event: close\ndata: \{"status":"reconnect"\}/);assert.doesNotMatch(body,/event: ready/);});
 const before=f.queries.length;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.queries.length,before);
});
test('An aborted handshake cannot deliver its late ready state to another attempt',async t=>{
 const f=await fixture(t,{queryDelayMs:35}),pending=f.post(tokens[0]);
 const aborted=pending.catch(error=>error);await until(()=>f.queries.length>0,'Initial SQL started');f.abortLast();
 f.status.set(tokens[0],'ready');const surviving=await f.post(tokens[1]);assert.equal(surviving.status,200);
 f.status.set(tokens[1],'review_required');const body=await surviving.text();
 assert.match(body,/"status":"review_required"/);assert.doesNotMatch(body,/"status":"ready"/);assert.equal((await aborted).name,'AbortError');assert.equal(f.maxBusy(),1);
});
test('UUID letter casing shares the native attempt limit and preserves readiness',async t=>{
 const f=await fixture(t,{maxPerAttempt:1}),token='abcdef00-0000-4000-8000-000000000091';f.status.set(token,'waiting');
 const response=await f.post(token.toUpperCase());assert.equal(response.status,200);assert.equal((await f.post(token)).status,429);
 f.status.set(token,'ready');assert.match(await response.text(),/event: ready\ndata: \{"status":"ready"\}/);
});
test('Batch SQL reads only each eligible submitted attempt and performs no writes',async()=>{
 const {db}=await createResultSqlFixture();
 try{
  await db.query('INSERT INTO assessment.term_test_attempt VALUES($1,now(),NULL),($2,now(),now()),($3,now(),now())',tokens);
  await db.query('INSERT INTO assessment.term_test_writing_grading_final VALUES($1,$2)',[tokens[1],'ready']);
  const before=(await db.query('SELECT * FROM assessment.term_test_attempt ORDER BY id')).rows;
  await db.exec('BEGIN READ ONLY');
  const rows=(await db.query(resultStreamBatchStatusSql,[[...tokens,tokens[1],'00000000-0000-4000-8000-000000000099']])).rows;
  await db.exec('COMMIT');
  assert.deepEqual(rows.sort((a,b)=>a.attempt_token.localeCompare(b.attempt_token)),[{attempt_token:tokens[1],status:'ready'},{attempt_token:tokens[2],status:'waiting'}]);
  assert.deepEqual((await db.query('SELECT * FROM assessment.term_test_attempt ORDER BY id')).rows,before);
 }finally{await db.close();}
});
if(process.env.PRACTICE_FIXTURE_DATABASE_URL)test('Native PG16 role drives real HTTP streams in shared batches without writing',async()=>{
 const {db,pool}=await createResultSqlFixture();let server;const controllers=[];
 try{
  await db.query('INSERT INTO assessment.term_test_attempt VALUES($1,now(),now()),($2,now(),now()),($3,now(),NULL)',tokens);
  const calls=[],observed={query:input=>{calls.push([...input.values[0]]);return pool.query(input);}};
  const app=createApp({config,pool:observed,resultStreamOptions:{pollIntervalMs:25,heartbeatMs:25,maxDurationMs:3000}});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const post=token=>{const controller=new AbortController();controllers.push(controller);return fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/result/stream`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attemptToken:token}),signal:controller.signal});};
  try{
   const [a,b,missing]=await Promise.all(tokens.map(post));assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(missing.status,404);
   await until(()=>calls.some(ids=>ids.includes(tokens[0])&&ids.includes(tokens[1])),'Native PostgreSQL receives combined current attempts');
   await db.query('INSERT INTO assessment.term_test_writing_grading_final VALUES($1,$2),($3,$4)',[tokens[1],'ready',tokens[0],'review_required']);
   const [one,two]=await Promise.all([a.text(),b.text()]);assert.match(one,/"status":"review_required"/);assert.doesNotMatch(one,/"status":"ready"/);assert.match(two,/"status":"ready"/);
   assert.doesNotMatch(one+two,/00000000|attemptToken|student|essay|score/);
   assert.equal((await db.query('SELECT count(*)::int n FROM assessment.term_test_attempt')).rows[0].n,3);
  }finally{controllers.forEach(c=>c.abort());await app.locals.termTestResultStream.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await db.close();}
});
