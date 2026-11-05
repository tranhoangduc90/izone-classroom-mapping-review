import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {fixture,fixtureContent} from './helpers.js';
import {uuid} from '../src/domain.js';
import {localPool} from '../tools/local-pool.mjs';

test('checkpoint có sửa nội dung chỉ ghi sau COMMIT; các heartbeat không đổi không tạo log dày',async t=>{
 const calls=[];
 const f=await fixture(undefined,{journal:{async recordReceipt(scope,receipt){
  const saved=(await f.pool.query('SELECT state FROM reading_practice.work WHERE binding_id=$1',[f.registered.bindingId])).rows[0].state;
  calls.push({scope,receipt,savedSequence:saved.attempts.at(-1).draft.sequence});
 }}});t.after(f.close);
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();calls.length=0;
 const draft=f.draft();draft.answers={'14':'answer-canary'};draft.notes='notes-canary';draft.sequence=1;draft.activeMs=5000;f.advance(5000);
 await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft});await nextTurn();
 assert.equal(calls.length,1);assert.equal(calls[0].receipt.data.action,'checkpoint');assert.equal(calls[0].savedSequence,1);
 assert.equal(calls[0].receipt.data.answeredCount,1);assert.equal(calls[0].receipt.data.expectedQuestions,13);
 assert.equal(calls[0].receipt.data.contentChanged,true);assert.equal(calls[0].receipt.data.contentVersion,fixtureContent().version);
 for(let i=0;i<12;i++){f.advance(5000);draft.sequence++;draft.activeMs+=5000;await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft});}
 await nextTurn();assert.equal(calls.length,1);
 const paused=await f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft});await nextTurn();
 assert.equal(calls.length,2);assert.equal(calls[1].receipt.data.action,'pause');assert.equal(calls[1].receipt.data.usedMs,65000);
 assert.equal(paused.attempts.at(-1).answers['14'],'answer-canary');
 const wire=JSON.stringify(calls);
 for(const secret of ['answer-canary','notes-canary',f.token,start.lease.token,f.registration.documentId])assert.equal(wire.includes(secret),false);
});

test('resume nhận nháp local, giới hạn phần giờ chưa ACK và không nhận lại lease tab cũ',async t=>{
 const calls=[];const f=await fixture(undefined,{journal:{recordReceipt:(scope,receipt)=>calls.push({scope,receipt})}});t.after(f.close);
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();calls.length=0;f.advance(86400000);
 const recovered=await f.service.resume({token:f.token,attemptId:a.id,owner:'device2',operationId:uuid(),
  recovery:{lease:start.lease,snapshot:{...f.draft(),sequence:2,activeMs:9000,answers:{'14':'kept-answer'}}}});
 await nextTurn();assert.equal(calls.length,1);
 assert.equal(calls[0].receipt.data.recoverySupplied,true);assert.equal(calls[0].receipt.data.usedMs,5000);
 assert.equal(calls[0].receipt.data.leaseIssued,true);assert.equal(recovered.attempts.at(-1).answers['14'],'kept-answer');
 await assert.rejects(f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft()}),e=>e.code==='LEASE_LOST');
 await nextTurn();assert.equal(calls.length,1);
});

test('mất phản hồi rồi nộp lại không thêm biên nhận; Reset nối lượt cũ và giữ kết quả',async t=>{
 const calls=[];const f=await fixture(undefined,{journal:{recordReceipt:(scope,receipt)=>calls.push({scope,receipt})}});t.after(f.close);
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();calls.length=0;
 const input={token:f.token,attemptId:a.id,lease:start.lease,snapshot:{...f.draft(),sequence:1,answers:{'14':'i'}},operationId:uuid(),method:'manual'};
 const one=await f.service.submit(input);await f.service.submit(input);await nextTurn();assert.equal(calls.length,1);
 assert.equal(calls[0].receipt.operationId,input.operationId);assert.equal(calls[0].receipt.data.status,'submitted');
 const fresh=await f.service.reset({token:f.token,attemptId:a.id,owner:'device2',operationId:uuid()});await nextTurn();
 assert.equal(calls.length,2);assert.equal(calls[1].scope.attemptNo,2);assert.equal(calls[1].scope.attemptId,fresh.attempts.at(-1).id);
 assert.equal(calls[1].receipt.data.previousAttemptId,a.id);assert.equal(fresh.attempts[0].finalScore,one.attempts[0].finalScore);
});

test('rollback và input/lease bị từ chối không có biên nhận; lỗi logger không đổi mã lỗi native',async t=>{
 let failCommit=false;const calls=[];const pool=await localPool(),connect=pool.connect;
 pool.connect=async()=>{const client=await connect();return{...client,query:(sql,...args)=>{
  if(sql==='COMMIT'&&failCommit)throw Error('fixture commit failure');return client.query(sql,...args);
 },release:()=>client.release()};};
 const f=await fixture(undefined,{poolFactory:async()=>pool,journal:{recordReceipt:(...args)=>calls.push(args)}});t.after(f.close);
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();calls.length=0;
 await assert.rejects(f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:null}),e=>e.code==='INVALID_DRAFT');
 failCommit=true;await assert.rejects(f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft()}),/fixture commit failure/);
 await nextTurn();assert.equal(calls.length,0);assert.equal((await f.service.read({token:f.token})).attempts.at(-1).status,'running');
});

test('logger chậm hoặc ném lỗi không chặn native; activate gửi lặp chỉ có một mốc kích hoạt',async t=>{
 let throwing=false;const receipts=[];
 const f=await fixture(undefined,{journal:{recordReceipt(_scope,receipt){receipts.push(receipt);if(throwing)throw Error('fixture offline');return new Promise(()=>{});}}});t.after(f.close);
 const start=await f.begin(),a=start.attempts.at(-1);await nextTurn();
 assert.deepEqual(receipts.map(r=>r.data.action),['begin','activate']);
 await f.service.activate({token:f.token,attemptId:a.id,lease:start.lease});await nextTurn();assert.equal(receipts.length,2);
 throwing=true;const paused=await f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft()});
 assert.equal(paused.attempts.at(-1).status,'paused');await nextTurn();assert.equal(receipts.length,3);
});
