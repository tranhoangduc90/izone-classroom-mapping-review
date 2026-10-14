import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {uuid,AUDIO_MS} from '../src/domain.js';
const last=s=>s.attempts.at(-1);
// Kiểm SQL thật, nghe/gián đoạn/reset/thu bài; toàn bộ danh tính là fixture.
async function advance(f,start,draft,ms){let state;for(let rest=ms;rest>0;){const delta=Math.min(5000,rest);rest-=delta;f.advance(delta);draft.sequence++;draft.activeMs+=delta;draft.audioPosition=Math.min(AUDIO_MS/1000,draft.activeMs/1000);state=await f.service.pulse({token:f.token,attemptId:last(start).id,lease:start.lease,snapshot:draft});}return state;}
test('nghe 4 phút, nghỉ một ngày, giữ vị trí/nháp; reset về đầu',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),draft=f.draft();draft.answers={'21':'A','26':'A'};draft.notes='Ghi chú';
 let s=await advance(f,start,draft,240000);assert.equal(last(s).remainingMs,339207);assert.equal(last(s).audioPosition,240);
 await f.service.pause({token:f.token,attemptId:last(start).id,lease:start.lease,snapshot:draft});f.advance(86400000);
 s=await f.service.resume({token:f.token,attemptId:last(start).id,owner:'device2',operationId:uuid()});assert.equal(last(s).audioPosition,240);assert.equal(last(s).remainingMs,339207);assert.deepEqual(last(s).answers,draft.answers);
 const fresh=await f.service.reset({token:f.token,attemptId:last(s).id,lease:s.lease,snapshot:{...draft,activeMs:0},owner:'device2',operationId:uuid()});assert.equal(last(fresh).no,2);assert.equal(last(fresh).remainingMs,579207);assert.equal(last(fresh).audioPosition,0);assert.deepEqual(last(fresh).answers,{});
});
test('kết thúc audio mở đúng 2 phút; gửi lặp không tăng giờ; tự thu đúng một bài',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),d=f.draft();d.answers={'21':'A'};await advance(f,start,d,AUDIO_MS);d.sequence++;d.phase='review';
 let s=await f.service.pulse({token:f.token,attemptId:last(start).id,lease:start.lease,snapshot:d});assert.equal(last(s).phase,'review');assert.equal(last(s).reviewRemainingMs,120000);
 s=await f.service.pulse({token:f.token,attemptId:last(start).id,lease:start.lease,snapshot:d});assert.equal(last(s).reviewRemainingMs,120000);
 for(let i=0;i<24;i++){f.advance(5000);d.activeMs+=5000;d.sequence++;s=await f.service.pulse({token:f.token,attemptId:last(start).id,lease:start.lease,snapshot:d});}
 assert.equal(last(s).status,'submitted');assert.equal(last(s).method,'timeout');assert.equal(last(s).finalScore,1);assert.equal(s.events.filter(e=>e.type==='completed').length,1);
});
test('chặn tua, chuyển rà và thu bài sớm',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),id=last(start).id,d=f.draft(),input={token:f.token,attemptId:id,lease:start.lease};
 await assert.rejects(f.service.pulse({...input,snapshot:{...d,sequence:1,audioPosition:400}}),e=>e.code==='AUDIO_POSITION_INVALID');
 await assert.rejects(f.service.pulse({...input,snapshot:{...d,sequence:1,phase:'review'}}),e=>e.code==='AUDIO_NOT_FINISHED');
 await assert.rejects(f.service.submit({...input,snapshot:d,method:'timeout',operationId:uuid()}),e=>e.code==='TIME_NOT_EXHAUSTED');
 await advance(f,start,d,10000);await assert.rejects(f.service.pulse({...input,snapshot:{...d,sequence:3,audioPosition:0}}),e=>e.code==='AUDIO_REWIND_DENIED');
});
test('hai thiết bị và replay bắt đầu sau reset giữ lượt hiện tại',async t=>{
 const f=await fixture();t.after(f.close);const input={token:f.token,owner:'device1',operationId:uuid()},start=await f.service.begin(input),id=last(start).id;
 const resumed=await f.service.resume({token:f.token,attemptId:id,owner:'device2',operationId:uuid()});await assert.rejects(f.service.pulse({token:f.token,attemptId:id,lease:start.lease,snapshot:f.draft()}),e=>e.code==='LEASE_LOST');
 const reset=await f.service.reset({token:f.token,attemptId:id,lease:resumed.lease,snapshot:f.draft(),owner:'device2',operationId:uuid()});const replay=await f.service.begin(input);assert.equal(last(replay).id,last(reset).id);assert.equal(replay.lease,undefined);
});
test('key chỉ sau nộp; nộp lặp một kết quả; nộp xong không tải lại audio',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),id=last(start).id;assert.equal(start.key,undefined);await assert.rejects(f.service.result({token:f.token,attemptId:id}),e=>e.code==='RESULT_NOT_AVAILABLE');
 const d=f.draft();d.sequence=1;d.answers={'21':'A','22':'A','26':'A'};const input={token:f.token,attemptId:id,lease:start.lease,snapshot:d,method:'manual',operationId:uuid()};const one=await f.service.submit(input),two=await f.service.submit(input);assert.deepEqual(one,two);assert.equal(last(one).finalScore,3);assert.equal(one.events.length,2);await assert.rejects(f.service.audioAccess({token:f.token,attemptId:id}),e=>e.code==='ATTEMPT_CLOSED');
});
test('submit/reset tranh chấp một chuyển trạng thái',async t=>{const f=await fixture();t.after(f.close);const start=await f.begin(),input={token:f.token,attemptId:last(start).id,lease:start.lease,snapshot:f.draft()};const r=await Promise.allSettled([f.service.submit({...input,operationId:uuid(),method:'manual'}),f.service.reset({...input,operationId:uuid(),owner:'device1'})]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);});
test('giữ lần hoàn thành đầu, quyền GV theo lớp kể cả học viên đã nghỉ',async t=>{
 const f=await fixture();t.after(f.close);const start=await f.begin(),one=await f.service.submit({token:f.token,attemptId:last(start).id,lease:start.lease,snapshot:f.draft(),method:'manual',operationId:uuid()});const reset=await f.service.reset({token:f.token,attemptId:last(start).id,owner:'device1',operationId:uuid()});const two=await f.service.submit({token:f.token,attemptId:last(reset).id,lease:reset.lease,snapshot:f.draft(),method:'manual',operationId:uuid()});assert.equal(two.firstCompleted,1);f.setEligible(false);const id=last(one).submissionId;assert.equal((await f.service.teacherResult({submissionId:id,email:'teacher@example.test',subject:'google-fixture'})).attempt.submissionId,id);f.setTeacher(false);await assert.rejects(f.service.teacherResult({submissionId:id,email:'teacher@example.test',subject:'google-fixture'}),e=>e.code==='ACCESS_DENIED');
});
test('chờ tải audio trước activation không mất giờ; pause hủy activation muộn',async t=>{const f=await fixture();t.after(f.close);const start=await f.service.begin({token:f.token,owner:'device1',operationId:uuid()}),id=last(start).id;f.advance(10000);assert.equal(last(await f.service.read({token:f.token})).usedMs,0);await f.service.pause({token:f.token,attemptId:id,lease:start.lease,snapshot:f.draft()});await assert.rejects(f.service.activate({token:f.token,attemptId:id,lease:start.lease}),e=>e.code==='LEASE_REACTIVATION_REQUIRED');});
test('ACK activate chậm không tính phần chờ vào audio hoặc rà bài',async t=>{const f=await fixture();t.after(f.close);const s=await f.service.begin({token:f.token,owner:'device1',operationId:uuid()}),id=last(s).id;f.advance(2000);await f.service.activate({token:f.token,attemptId:id,lease:s.lease});f.advance(3000);const d=f.draft();d.sequence=1;d.activeMs=1000;d.audioPosition=1;f.advance(1000);const out=await f.service.pulse({token:f.token,attemptId:id,lease:s.lease,snapshot:d});assert.equal(last(out).usedMs,1000);assert.equal(last(out).audioPosition,1);});
