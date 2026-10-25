import test from 'node:test';
import assert from 'node:assert/strict';
import {CODE,statusMessage,uuid} from '../src/domain.js';
import {fixture} from './helpers.js';

// Dữ liệu giả: kiểm điểm 0, mẫu số theo kết quả và đúng lượt qua API/SQL thật cục bộ.
const reading=CODE.includes('reading'),schema=reading?'reading_practice':'listening_practice';
function attempt(score,total,extra={}){
 return {status:'submitted',no:1,method:'manual',finalScore:score,
  result:{score,rows:Array.from({length:total},(_,i)=>({number:27+i,state:i<score?'correct':'blank'}))},...extra};
}
test('Thông báo: mẫu số theo kết quả, điểm 0 và giữ câu tự thu/lượt hoàn thành đầu',()=>{
 for(const total of [10,13,14,7]){
  assert.ok(statusMessage(attempt(0,total),1).includes(`Kết quả: đúng 0/${total} câu.`));
  assert.ok(statusMessage(attempt(total,total),1).includes(`Kết quả: đúng ${total}/${total} câu.`));
 }
 const retake=statusMessage(attempt(3,14,{no:3,method:'timeout'}),1);
 assert.ok(retake.includes('đúng 3/14 câu.'));
 assert.ok(retake.includes('Lần hoàn thành đầu tiên: lượt 1.'));
 assert.ok(retake.includes('Hệ thống tự thu bài do hết thời gian.'));
 assert.ok(retake.endsWith('Giảng viên nhấn vào đây để xem kết quả.'));
 assert.equal(statusMessage({status:'running',no:1},null),'Đã bắt đầu làm bài lần đầu tiên.');
 assert.ok(!statusMessage(attempt(9,10,{status:'paused',no:2}),1).includes('Kết quả:'));
});
test('Thông báo: thiếu hoặc mâu thuẫn kết quả không bịa điểm 0 và không chặn lưu bài',()=>{
 for(const a of [attempt(0,0),attempt(-1,10),attempt(11,10),attempt(3,10,{finalScore:2}),attempt(3,10,{result:null}),{status:'submitted',no:1}]){
  assert.ok(!statusMessage(a,1).includes('Kết quả:'));
  assert.ok(statusMessage(a,1).includes('Đã hoàn thành'));
 }
});
test('Nộp bài: job/sự kiện cùng điểm, link cùng submission; lặp và làm lại không trộn lượt',async t=>{
 const f=await fixture();t.after(f.close);
 const first=await f.begin(),a=first.attempts.at(-1),draft=f.draft();
 draft.answers=reading?{'14':'i','15':'i','21':'A','24':'word'}:{'21':'A','22':'A','23':'A','26':'A'};
 draft.sequence=1;
 const input={token:f.token,attemptId:a.id,lease:first.lease,snapshot:draft,method:'manual',operationId:uuid()};
 const one=await f.service.submit(input),again=await f.service.submit(input),done=one.attempts.at(-1),total=reading?13:10;
 assert.equal(done.finalScore,4);assert.equal(again.attempts.at(-1).submissionId,done.submissionId);
 assert.ok(one.events.at(-1).message.includes(`Kết quả: đúng 4/${total} câu.`));
 const jobs=(await f.pool.query(`SELECT * FROM ${schema}.doc_job WHERE kind='status' ORDER BY sequence`)).rows;
 assert.equal(jobs.length,2);assert.ok(!jobs[0].payload.text.includes('Kết quả:'));
 assert.equal(jobs[1].payload.text,one.events.at(-1).message);
 assert.ok(jobs[1].payload.link.endsWith('#submission='+done.submissionId));assert.equal(jobs[1].payload.attemptId,a.id);
 const next=await f.service.reset({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});
 assert.ok(!next.events.at(-1).message.includes('Kết quả:'));
 const two=await f.service.submit({token:f.token,attemptId:next.attempts.at(-1).id,lease:next.lease,snapshot:f.draft(),method:'manual',operationId:uuid()});
 assert.ok(two.events.at(-1).message.includes(`Kết quả: đúng 0/${total} câu.`));
 assert.equal(two.attempts[0].finalScore,4);assert.equal(two.firstCompleted,1);
});
