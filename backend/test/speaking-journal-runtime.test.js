import test from 'node:test';
import assert from 'node:assert/strict';
import {startSpeakingJournalRuntime} from '../src/speaking-journal-runtime.js';

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
