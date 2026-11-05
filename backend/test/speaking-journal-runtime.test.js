import test from 'node:test';
import assert from 'node:assert/strict';
import {startSpeakingJournalRuntime,withSpeakingJournalRequest,rememberSpeakingJournalScope,createSpeakingReadSummary} from '../src/speaking-journal-runtime.js';
import {randomUUID} from 'node:crypto';

test('Speaking read summary turns 100 successful polls into one count with bounded latency and no request IDs',()=>{
 const rows=[];let at=100,tick;
 const summary=createSpeakingReadSummary({emit:row=>rows.push(row),clock:()=>at,setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{}});
 for(let n=0;n<100;n++){at++;assert.equal(summary.record({scope:{unitId:'one'},started:at-3,requestId:randomUUID()},'open',200),true);}
 assert.equal(rows.length,0);tick();assert.equal(rows.length,1);assert.equal(rows[0].data.requests,100);assert.equal(rows[0].data.sumDurationMs,300);
 assert.equal(rows[0].data.maxDurationMs,3);assert.equal(rows[0].requestId,undefined);assert.equal(rows[0].data.outcome,'http_response_only');
 assert.equal(summary.snapshot().pendingGroups,0);
});
test('Speaking read summary preserves owner and route, flushes at capacity and leaves errors/writes for individual facts',()=>{
 const rows=[];const summary=createSpeakingReadSummary({emit:row=>rows.push(row),clock:()=>10,maxGroups:2,setTimer:()=>1,clearTimer:()=>{}});
 const frame=id=>({scope:{unitId:id},started:2});
 summary.record(frame('a'),'open',200);summary.record(frame('b'),'doctor_list',200);summary.record(frame('c'),'open',200);
 assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>[row.scope.unitId,row.data.route]),[['a','open'],['b','doctor_list']]);
 assert.equal(summary.record(frame('c'),'open',503),false);assert.equal(summary.record(frame('c'),'finish',202),false);
 summary.flush();assert.equal(rows.at(-1).scope.unitId,'c');assert.equal(summary.snapshot().pendingGroups,0);
});
test('Speaking read summary catches logger failure and exposes failed count',()=>{
 const summary=createSpeakingReadSummary({emit(){throw Error('PRIVATE');},clock:()=>10,setTimer:()=>1,clearTimer:()=>{}});
 summary.record({scope:{unitId:'a'},started:2},'open',200);summary.flush();assert.equal(summary.snapshot().failed,1);
});

test('Speaking HTTP contexts keep simultaneous/late native owners apart and sanitize supplied request IDs',async()=>{
 const a=randomUUID(),b=randomUUID();let release;
 const pending=new Promise(resolve=>{release=resolve;});
 const first=withSpeakingJournalRequest(a,async frame=>{
  const scope={subjectRef:'native-owner-a',unitId:randomUUID()};rememberSpeakingJournalScope(scope);scope.subjectRef='mutated';
  await pending;assert.equal(frame.requestId,a);assert.equal(frame.scope.subjectRef,'native-owner-a');return frame;
 });
 const second=withSpeakingJournalRequest(b,async frame=>{rememberSpeakingJournalScope({subjectRef:'native-owner-b'});release();await Promise.resolve();return frame;});
 const [one,two]=await Promise.all([first,second]);assert.equal(two.requestId,b);assert.equal(two.scope.subjectRef,'native-owner-b');assert.notEqual(one.scope,two.scope);
 rememberSpeakingJournalScope({subjectRef:'outside-request'});
 withSpeakingJournalRequest('PRIVATE_TOKEN',frame=>{assert.match(frame.requestId,/^[a-f0-9-]{36}$/);assert.equal(frame.scope,undefined);});
});

test('Speaking logging off does not import infrastructure or read its configuration',async()=>{
 for(const flag of [undefined,'0','false']){
  const runtime=await startSpeakingJournalRuntime({env:{EXAM_JOURNAL_ENABLED:flag,EXAM_JOURNAL_CONFIG_FILE:'missing'},load(){throw Error('MUST_NOT_LOAD');}});
  assert.equal(runtime.journal,false);await runtime.close();
  assert.deepEqual(runtime.snapshot(),{enabled:false,configured:false,failures:0,closed:true,shutdownUnknown:false});
 }
});
test('Speaking logging startup failures return a disabled callback and fixed diagnostic only',async()=>{
 for(const load of [()=>{throw Error('PRIVATE_SECRET');},()=>({createSpeakingProducerJournalFromEnv(){throw Error('PRIVATE_TOKEN');}}),()=>({})]){
  const health=[];const runtime=await startSpeakingJournalRuntime({env:{EXAM_JOURNAL_ENABLED:'1'},load,onHealth:row=>health.push(row)});
  assert.equal(runtime.journal,false);assert.equal(runtime.snapshot().failures,1);
  assert.deepEqual(health,[{type:'speaking_journal_health',status:'degraded',errorCode:'SPEAKING_JOURNAL_START_FAILED'}]);
  await runtime.close();
 }
});
test('Speaking configured startup preserves batch capability and does not await transport readiness',async()=>{
 const journal=()=>{};journal.close=async()=>{};journal.batch=async()=>{};journal.ready=new Promise(()=>{});
 const env={EXAM_JOURNAL_ENABLED:'1'},health=[];let options;
 const runtime=await startSpeakingJournalRuntime({env,load:()=>({createSpeakingProducerJournalFromEnv(input){options=input;return journal;}}),onHealth:row=>health.push(row)});
 assert.equal(runtime.journal,journal);assert.equal(runtime.journal.batch,journal.batch);assert.equal(options.env,env);
 options.onFailure();assert.equal(runtime.snapshot().failures,1);assert.equal(health[0].status,'configured');
 await runtime.close();
});
test('Speaking shutdown drains API then Docs before closing transport, once',async()=>{
 const order=[];const journal=()=>{};journal.close=async()=>{order.push('transport');};
 const runtime=await startSpeakingJournalRuntime({env:{EXAM_JOURNAL_ENABLED:'1'},load:()=>({createSpeakingProducerJournalFromEnv:()=>journal})});
 const close=runtime.close({flushers:[async()=>{order.push('api:start');await new Promise(r=>setImmediate(r));order.push('api:end');},async()=>order.push('docs')]});
 assert.equal(runtime.close({flushers:[()=>assert.fail('second shutdown')]}),close);await close;
 assert.deepEqual(order,['api:start','api:end','docs','transport']);assert.equal(runtime.snapshot().shutdownUnknown,false);
});
test('Speaking shutdown attempts remaining drains after failure and reports unknown without secrets',async()=>{
 const order=[],health=[];const journal=()=>{};journal.close=async()=>{order.push('transport');throw Error('PRIVATE');};
 const runtime=await startSpeakingJournalRuntime({env:{EXAM_JOURNAL_ENABLED:'1'},load:()=>({createSpeakingProducerJournalFromEnv:()=>journal}),onHealth:row=>{health.push(row);}});
 await runtime.close({flushers:[()=>{throw Error('PRIVATE');},()=>order.push('docs')]});
 assert.deepEqual(order,['docs','transport']);assert.equal(runtime.snapshot().failures,2);assert.equal(runtime.snapshot().shutdownUnknown,true);
 assert.deepEqual(health.at(-1),{type:'speaking_journal_health',status:'degraded',errorCode:'SPEAKING_JOURNAL_SHUTDOWN_UNKNOWN'});
});
test('Speaking shutdown with RAM retry remaining is unknown rather than a durable ACK',async()=>{
 const journal=()=>{};journal.close=async()=>{};journal.metrics=()=>({retryBatches:1});
 const runtime=await startSpeakingJournalRuntime({env:{EXAM_JOURNAL_ENABLED:'1'},load:()=>({createSpeakingProducerJournalFromEnv:()=>journal}),onHealth(){throw Error('OBSERVER');}});
 await runtime.close();assert.equal(runtime.snapshot().shutdownUnknown,true);
});
