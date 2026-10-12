import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {uuid} from '../src/domain.js';

const latest=response=>response.attempts.at(-1);
test('8 phút đang làm, đóng máy một ngày, tiếp tục còn đúng 12 phút và toàn bộ nháp',async t=>{
 const f=await fixture();t.after(f.close);let state=await f.begin(),a=latest(state),draft=f.draft();const lease=state.lease;
 draft.answers={'14':'i','24':'word'};draft.notes='Nén ý';draft.flags=[21];draft.scroll={passage:321,questions:{all:654}};
 draft.annotations=[{id:'mark1',rootKey:'passage:A',skill:'reading',start:0,end:9,quote:'Paragraph',questionRef:'',kind:'highlight'}];
 for(let i=0;i<96;i++){f.advance(5000);draft.activeMs+=5000;draft.sequence++;state=await f.service.pulse({token:f.token,attemptId:a.id,lease,snapshot:draft});}
 assert.equal(latest(state).remainingMs,720000);
 state=await f.service.pause({token:f.token,attemptId:a.id,lease,snapshot:draft});
 f.advance(86400000);
 const resumed=await f.service.resume({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});
 assert.equal(latest(resumed).remainingMs,720000);assert.deepEqual(latest(resumed).answers,draft.answers);
 assert.deepEqual(latest(resumed).annotations,draft.annotations);assert.deepEqual(latest(resumed).scroll,draft.scroll);assert.equal(latest(resumed).notes,'Nén ý');
});
test('nộp lại cùng mã thao tác chỉ một kết quả và một job Docs; chưa nộp không lấy được key',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),a=latest(start);
 assert.equal(start.key,undefined);assert.equal(start.explanations,undefined);
 await assert.rejects(f.service.result({token:f.token,attemptId:a.id}),e=>e.code==='RESULT_NOT_AVAILABLE');
 const draft=f.draft();draft.sequence=1;draft.answers={'14':'i','21':'a','24':'word'};f.advance(1000);draft.activeMs=1000;
 const input={token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft,operationId:uuid(),method:'manual'};
 const one=await f.service.submit(input),two=await f.service.submit(input);assert.deepEqual(two,one);
 assert.equal(latest(one).finalScore,3);assert.equal(one.events.length,2);
 const result=await f.service.result({token:f.token,attemptId:a.id});assert.deepEqual(result.key,f.content.key);
 assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM reading_practice.doc_job WHERE kind='status'")).rows[0].n,2);
});
test('reset tạo lượt 2 với 20 phút, nháp trống; bản lưu và submit lượt 1 bị chặn',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),a=latest(start),draft=f.draft();draft.sequence=1;draft.answers={'14':'i'};
 const input={token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft,owner:'device1',operationId:uuid()};
 const fresh=await f.service.reset(input);assert.equal(latest(fresh).no,2);assert.equal(latest(fresh).remainingMs,1200000);assert.deepEqual(latest(fresh).answers,{});
 assert.equal(fresh.attempts[0].status,'reset');assert.deepEqual(await f.service.reset(input),fresh);
 await assert.rejects(f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft}),e=>e.code==='ATTEMPT_CHANGED');
 await assert.rejects(f.service.submit({...input,operationId:uuid(),method:'manual'}),e=>e.code==='ATTEMPT_CHANGED');
 assert.match(fresh.events.at(-1).message,/số 2.*reset 1/);
});
test('hai tab: tiếp tục chuyển epoch, bản cũ không ghi đè; sai chủ Docs không đăng nhập',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),a=latest(start);
 const resumed=await f.service.resume({token:f.token,attemptId:a.id,owner:'device2',operationId:uuid()});
 assert.notEqual(resumed.lease.id,start.lease.id);
 await assert.rejects(f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft()}),e=>e.code==='LEASE_LOST');
 await assert.rejects(f.service.login({entryToken:f.entryToken,studentRef:uuid(),classCode:'FIXTURE 67'}),e=>e.code==='IDENTITY_MISMATCH');
 assert.equal((await f.service.read({token:f.token})).attempts.length,1);
});
test('giữ lần hoàn thành đầu tiên; GV chỉ đọc đúng lớp kể cả HV đã rời lớp',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),a=latest(start),draft=f.draft();
 const one=await f.service.submit({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft,operationId:uuid(),method:'manual'});
 const reset=await f.service.reset({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});
 const two=await f.service.submit({token:f.token,attemptId:latest(reset).id,lease:reset.lease,snapshot:f.draft(),operationId:uuid(),method:'manual'});
 assert.equal(two.firstCompleted,1);assert.match(two.events.at(-1).message,/Lần hoàn thành đầu tiên: lượt 1/);
 const submissionId=latest(one).submissionId;
 f.setEligible(false);assert.equal((await f.service.teacherResult({submissionId,email:'teacher@example.test',subject:'google-fixture'})).attempt.submissionId,submissionId);
 f.setTeacher(false);await assert.rejects(f.service.teacherResult({submissionId,email:'teacher@example.test',subject:'google-fixture'}),e=>e.code==='ACCESS_DENIED');
});
test('pulse chậm vẫn dùng thời gian máy chủ; client gửi activeMs=0 không đứng đồng hồ',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),a=latest(start),draft=f.draft();
 f.advance(6500);draft.sequence=1;draft.activeMs=0;
 const saved=await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft});
 assert.equal(latest(saved).usedMs,6500);
});
test('replay start sau reset chỉ trả lượt hiện tại, không phát lại lease cũ',async t=>{
 const f=await fixture();t.after(f.close);const input={token:f.token,owner:'device1',operationId:uuid()},start=await f.service.begin(input),a=latest(start);
 const reset=await f.service.reset({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft(),owner:'device1',operationId:uuid()});
 const replay=await f.service.begin(input);assert.equal(latest(replay).id,latest(reset).id);assert.equal(replay.lease,undefined);assert.equal(replay.attempts.length,2);
});
test('submit và reset tranh chấp: chỉ chuyển trạng thái đang làm một lần',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),a=latest(start);
 const [submit,reset]=await Promise.allSettled([
  f.service.submit({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft(),operationId:uuid(),method:'manual'}),
  f.service.reset({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft(),owner:'device1',operationId:uuid()})]);
 assert.equal([submit,reset].filter(r=>r.status==='fulfilled').length,1);
});
test('đủ 20 phút tự chốt một kết quả timeout; pulse/submit cũ không sửa bài đã nộp',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),a=latest(start),draft=f.draft();draft.answers={'14':'i'};let response;
 for(let i=0;i<240;i++){f.advance(5000);draft.sequence++;draft.activeMs+=5000;response=await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft});}
 const final=latest(response);assert.equal(final.status,'submitted');assert.equal(final.method,'timeout');assert.equal(final.remainingMs,0);assert.equal(final.finalScore,1);
 const result=await f.service.result({token:f.token,attemptId:a.id});assert.equal(result.attempt.submissionId,final.submissionId);
 await assert.rejects(f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft}),e=>e.code==='ATTEMPT_CLOSED');
 await assert.rejects(f.service.submit({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft,method:'manual',operationId:uuid()}),e=>e.code==='ATTEMPT_CLOSED');
 assert.equal(response.events.filter(e=>e.type==='completed').length,1);
});
test('ACK start/resume chậm không trừ giờ; kích hoạt gửi lại không dời mốc, không tự mở lại lease đã pause',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.service.begin({token:f.token,owner:'device1',operationId:uuid()}),a=latest(start);
 f.advance(3000);assert.equal(latest(await f.service.read({token:f.token})).usedMs,0);
 await f.service.activate({token:f.token,attemptId:a.id,lease:start.lease});
 const draft=f.draft();draft.activeMs=4500;draft.sequence=1;f.advance(4500);
 await f.service.activate({token:f.token,attemptId:a.id,lease:start.lease});
 let state=await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft});assert.equal(latest(state).usedMs,4500);
 await f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:draft});
 await assert.rejects(f.service.activate({token:f.token,attemptId:a.id,lease:start.lease}),e=>e.code==='LEASE_REACTIVATION_REQUIRED');
 const resumed=await f.service.resume({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});f.advance(3000);
 await f.service.activate({token:f.token,attemptId:a.id,lease:resumed.lease});f.advance(4500);draft.activeMs=4500;draft.sequence=2;
 state=await f.service.pulse({token:f.token,attemptId:a.id,lease:resumed.lease,snapshot:draft});assert.equal(latest(state).usedMs,9000);
});
test('pause trước activation hủy lease chờ; activation muộn không mở lại và resume sinh lease mới',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.service.begin({token:f.token,owner:'device1',operationId:uuid()}),a=latest(start);
 await f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:f.draft()});f.advance(3000);
 await assert.rejects(f.service.activate({token:f.token,attemptId:a.id,lease:start.lease}),e=>e.code==='LEASE_REACTIVATION_REQUIRED');
 assert.equal(latest(await f.service.read({token:f.token})).status,'paused');
 const next=await f.service.resume({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});await f.service.activate({token:f.token,attemptId:a.id,lease:next.lease});
 assert.equal(latest(await f.service.read({token:f.token})).status,'running');assert.notEqual(next.lease.id,start.lease.id);
});
