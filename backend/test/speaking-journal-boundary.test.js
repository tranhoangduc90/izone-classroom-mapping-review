import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createSpeakingJournalBoundary,speakingJournalTime} from '../src/speaking-journal-boundary.js';

test('Speaking tắt log giữ nguyên native transaction, không gọi bên gửi',()=>{
 const transaction=()=>{};
 for(const journal of [undefined,null,false]){
 const boundary=createSpeakingJournalBoundary({transaction,journal});
 assert.equal(boundary.transaction,transaction);assert.equal(boundary.record({},{}),false);
 assert.deepEqual(boundary.snapshot(),{enabled:false,staged:0,committed:0,pending:0,delivered:0,unknown:0,overflow:0,discardedOnTransactionError:0});
 }
});

test('chỉ chuyển projection sau native COMMIT; không chờ mạng và giữ snapshot trước await',async()=>{
 const client={},pool={},order=[];let release;
 const held=new Promise(resolve=>{release=resolve;});
 const transaction=async(actual,work)=>{assert.equal(actual,pool);order.push('begin');const result=await work(client);order.push('commit');return result;};
 const boundary=createSpeakingJournalBoundary({transaction,journal:async row=>{order.push('log');assert.equal(row.owner,'original');await held;return{persisted:true};}});
 const native={id:'native-receipt'},projection={owner:'original'};
 const result=await boundary.transaction(pool,async db=>{boundary.record(db,projection);projection.owner='late-owner';return native;});
 assert.equal(result,native);assert.deepEqual(order,['begin','commit']);
 await nextTurn();assert.deepEqual(order,['begin','commit','log']);assert.equal(boundary.snapshot().pending,1);
 release();await nextTurn();assert.equal(boundary.snapshot().delivered,1);
});

test('rollback hoặc COMMIT lỗi không phát log; native error giữ nguyên',async()=>{
 for(const commitFails of [false,true]){
  const client={},error=new Error('fixture-native-error');let sent=0;
  const transaction=async(pool,work)=>{await work(client);throw error;};
  const boundary=createSpeakingJournalBoundary({transaction,journal:()=>{sent++;return{persisted:true};}});
  await assert.rejects(boundary.transaction({},async db=>{boundary.record(db,{kind:'native'});if(!commitFails)throw error;}),value=>value===error);
  await nextTurn();assert.equal(sent,0);assert.equal(boundary.snapshot().discardedOnTransactionError,1);
 }
});

test('sự kiện của hai transaction và bên gửi lỗi không đổi kết quả nghiệp vụ',async()=>{
 const nativeResults=[],sent=[];
 const transaction=async(pool,work)=>{const result=await work({});nativeResults.push(result);return result;};
 const boundary=createSpeakingJournalBoundary({transaction,journal:async row=>{sent.push(row);throw Error('fixture-lost-ack');},onFailure:()=>{throw Error('fixture-health');}});
 const results=await Promise.all(['a','b'].map(owner=>boundary.transaction({},async db=>{boundary.record(db,{owner});return owner;})));
 await nextTurn();await nextTurn();assert.deepEqual(results,['a','b']);assert.deepEqual(nativeResults,['a','b']);
 assert.deepEqual(sent.map(row=>row.owner).sort(),['a','b']);assert.equal(boundary.snapshot().unknown,2);
});

test('giới hạn hữu hạn có bộ đếm, không báo đã lưu khi ACK chưa rõ',async()=>{
 const client={};let release;const held=new Promise(resolve=>{release=resolve;});
 const boundary=createSpeakingJournalBoundary({transaction:async(pool,work)=>work(client),
  journal:async()=>{await held;return{persisted:false};},maxTransactionEvents:2,maxPendingEvents:1});
 const result=await boundary.transaction({},async db=>{
  assert.equal(boundary.record(db,{id:1}),true);assert.equal(boundary.record(db,{id:2}),true);
  assert.equal(boundary.record(db,{id:3}),false);return'committed-business';
 });
 assert.equal(result,'committed-business');assert.equal(boundary.snapshot().overflow,2);
 release();await nextTurn();await nextTurn();assert.equal(boundary.snapshot().delivered,0);assert.equal(boundary.snapshot().unknown,1);
});

test('thời gian phải lấy từ native có timezone, không tự thay bằng đồng hồ lúc gửi',()=>{
 assert.equal(speakingJournalTime(new Date('2026-11-05T12:00:00Z')),'2026-11-05T12:00:00.000Z');
 assert.equal(speakingJournalTime('2026-11-05T19:00:00+07:00'),'2026-11-05T12:00:00.000Z');
 assert.throws(()=>speakingJournalTime('2026-11-05T19:00:00'),/NATIVE_TIME_REQUIRED/);
});

test('lỗi dựng projection metadata không rollback kết quả nghiệp vụ',async()=>{
 const boundary=createSpeakingJournalBoundary({transaction:async(pool,work)=>work({}),journal:()=>({persisted:true})});
 const result=await boundary.transaction({},async db=>{
  assert.equal(boundary.record(db,()=>{throw Error('fixture invalid metadata');}),false);return'native-saved';
 });
 assert.equal(result,'native-saved');assert.equal(boundary.snapshot().unknown,1);
});
