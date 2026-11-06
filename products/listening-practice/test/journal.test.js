import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {fixture} from './helpers.js';
import {uuid} from '../src/domain.js';
import {localPool} from '../tools/local-pool.mjs';

test('pause/resume receipts describe committed state; replay and pulse do not create extra control events',async t=>{
 const calls=[];
 const f=await fixture({journal:{async recordReceipt(scope,receipt){
  const saved=(await f.pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[f.registered.bindingId])).rows[0].state;
  calls.push({scope,receipt,savedStatus:saved.attempts.at(-1).status});
 }}});t.after(()=>f.close());
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();calls.length=0;
 f.advance(5000);const snapshot={...f.draft(),sequence:1,activeMs:5000,audioPosition:5,answers:{21:'answer-canary'},notes:'notes-canary'};
 await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot});await nextTurn();assert.equal(calls.length,0);
 snapshot.sequence++;const paused=await f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot});
 await nextTurn();assert.equal(calls.length,1);
 assert.deepEqual(calls[0].scope,{code:f.content.code,classCode:f.registration.classCode,studentRef:f.studentRef,attemptId:a.id,attemptNo:1});
 assert.equal(calls[0].savedStatus,'paused');assert.equal(calls[0].receipt.data.status,'paused');assert.equal(calls[0].receipt.data.audioPositionMs,5000);
 assert.equal(calls[0].receipt.data.nativeOperation,false);
 assert.equal(paused.attempts.at(-1).notes,'notes-canary');
 f.advance(60000);const input={token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()};
 const resumed=await f.service.resume(input),replayed=await f.service.resume(input);await nextTurn();
 assert.equal(calls.length,2);assert.equal(calls[1].receipt.operationId,input.operationId);assert.equal(calls[1].receipt.data.leaseIssued,true);
 assert.equal(calls[1].receipt.data.usedMs,5000);assert.deepEqual(replayed,resumed);
 const serialized=JSON.stringify(calls);
 for(const secret of ['answer-canary','notes-canary',f.token,start.lease.token])assert.equal(serialized.includes(secret),false);
 assert.equal(resumed.attempts.at(-1).id,a.id);assert.equal(resumed.attempts.at(-1).answers[21],'answer-canary');
});

test('unproven audio progress is logged as recovery pending without a resume lease',async t=>{
 const calls=[];const f=await fixture({journal:{recordReceipt:(_scope,receipt)=>calls.push(receipt)}});t.after(()=>f.close());
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();calls.length=0;
 f.advance(30000);const result=await f.service.resume({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid(),
  recovery:{lease:start.lease,snapshot:{...f.draft(),sequence:1,activeMs:30000,audioPosition:30,notes:'kept'}}});
 await nextTurn();assert.equal(calls.length,1);assert.equal(calls[0].data.recoveryPending,true);assert.equal(calls[0].data.leaseIssued,false);
 assert.equal(calls[0].data.status,'paused');assert.equal(calls[0].data.audioPositionMs,0);assert.equal(result.attempts.at(-1).notes,'kept');
});

test('lease denial and SQL COMMIT failure do not publish a control receipt',async t=>{
 let failCommit=false;const calls=[];
 const pool=await localPool(),connect=pool.connect;
 pool.connect=async()=>{const client=await connect();return{...client,query:(sql,...args)=>{
  if(sql==='COMMIT'&&failCommit)throw Error('fixture commit failure');return client.query(sql,...args);
 },release:()=>client.release()};};
 const f=await fixture({poolFactory:async()=>pool,journal:{recordReceipt:(...args)=>calls.push(args)}});t.after(()=>f.close());
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();calls.length=0;
 await assert.rejects(f.service.pause({token:f.token,attemptId:a.id,lease:{id:uuid(),token:'wrong'},snapshot:f.draft()}),e=>e.code==='LEASE_LOST');
 failCommit=true;
 await assert.rejects(f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft()}),/fixture commit failure/);
 await nextTurn();assert.equal(calls.length,0);
 const saved=await f.service.read({token:f.token});assert.equal(saved.attempts.at(-1).status,'running');
});

test('stalled or failed logging does not block the native pause and resume',async t=>{
 let fail=false,calls=0;
 const f=await fixture({journal:{recordReceipt(){calls++;if(fail)throw Error('fixture Collector unavailable');return new Promise(()=>{});}}});t.after(()=>f.close());
 const start=await f.begin(),a=start.attempts.at(-1);
 const paused=await f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft()});
 assert.equal(paused.attempts.at(-1).status,'paused');await nextTurn();assert.equal(calls,2);
 fail=true;const resumed=await f.service.resume({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});
 await nextTurn();assert.ok(resumed.lease);assert.equal(calls,3);
});


test('post-COMMIT metadata registers before deferred execution; a full barrier never falls back outside it',async t=>{
 const scheduled=[],calls=[];let reject=false,f;
 const journal={scheduleSource(work){if(reject)return false;scheduled.push(work);return true;},recordProgress(){return{ok:true};},
  async recordReceipt(scope,receipt){
   const saved=(await f.pool.query('SELECT state FROM listening_practice.work WHERE binding_id=$1',[f.registered.bindingId])).rows[0].state;
   calls.push({scope,receipt,committedAttempt:saved.attempts.at(-1).id});return{ok:true};
  }};
 f=await fixture({journal});t.after(()=>f.close());
 while(scheduled.length)await scheduled.shift()();calls.length=0;
 const started=await f.begin(),attempt=started.attempts.at(-1);
 assert.ok(scheduled.length>0,'registered before native begin response');
 await nextTurn();assert.equal(calls.length,0,'no callback starts outside source barrier');
 while(scheduled.length)await scheduled.shift()();
 assert.ok(calls.length>0);assert.ok(calls.every(value=>value.scope.attemptId===attempt.id&&value.committedAttempt===attempt.id));
 calls.length=0;reject=true;
 const paused=await f.service.pause({token:f.token,attemptId:attempt.id,lease:started.lease,snapshot:f.draft()});
 assert.equal(paused.attempts.at(-1).status,'paused');await nextTurn();assert.equal(calls.length,0,'rejected scheduling must not use setImmediate fallback');
});
