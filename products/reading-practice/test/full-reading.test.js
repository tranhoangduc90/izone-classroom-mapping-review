// Full test giả 40 câu kiểm giờ/lượt/nháp bằng SQL thật, không chứa nội dung Cambridge.
import test from 'node:test';import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {fixture} from './helpers.js';import {registerAuthoredLesson} from '../src/authored-content.js';
import {validateContent,uuid} from '../src/domain.js';
function content(code){
 const ranges=[[1,13],[14,26],[27,40]],passages=ranges.map(([start,end],i)=>({id:'p'+(i+1),label:'Passage '+(i+1),title:'Synthetic passage '+(i+1),start,end,paragraphs:['p'+(i+1)+'_A']}));
 const groups=ranges.map(([start,end],i)=>({id:'g'+i,kind:'completion',label:'Completion',start,end,instruction:'ONE WORD ONLY',questions:Array.from({length:end-start+1},(_,j)=>({n:start+j,text:'The place is a ___.',maxWords:1}))}));
 const lesson=registerAuthoredLesson({code,lesson:914,title:'Synthetic full reading',totalMs:3600000,passages,paragraphs:passages.flatMap(p=>p.paragraphs),groups:groups.map(({questions,instruction,...g})=>g)});
 const p=text=>({runs:[{text}]});
 return {code,version:'full-fixture-v1',totalMs:3600000,definition:{authored:true,lesson,passage:Object.fromEntries(passages.map(p=>[p.paragraphs[0],'The river flows here.'])),groups,mcq:[]},key:Object.fromEntries(Array.from({length:40},(_,i)=>[i+1,['river']])),explanations:{entries:Object.fromEntries(Array.from({length:40},(_,i)=>{const n=i+1,part=passages.find(p=>n>=p.start&&n<=p.end);return[n,{number:n,kind:'completion',answer:['river'],prompt:p('The place is a ___.'),reason:[p('The source identifies a river.')],evidenceGroups:[{paragraph:part.paragraphs[0],speaker:'',paragraphs:[p('The river flows here.')],marks:[{start:4,end:9,background:'#fff2cc'}]}]}];}))}};
}
test('40 câu: pause giữ giờ, tiếp tục giữ passage/annotation, nộp lặp và reset không sửa lịch sử',async t=>{
 const receipts=[];
 const b=content('full-reading-40-fixture'),f=await fixture(b,{journal:{recordReceipt:(scope,receipt)=>receipts.push({scope,receipt})}});t.after(f.close);
 const start=await f.begin(),a=start.attempts.at(-1);assert.equal(a.remainingMs,3600000);assert.equal('key' in start,false);
 const d=f.draft();Object.assign(d,{answers:Object.fromEntries(Array.from({length:40},(_,i)=>[i+1,'river'])),activeQuestion:40,sequence:1,activeMs:5000,scroll:{passage:250,questions:{'passage:p1':100,'questions:p3':400,'active:p3':40}},annotations:[{id:'one',kind:'highlight',rootKey:'reading-passage-p3',skill:'reading',start:4,end:9,quote:'river',questionRef:'40'}]});
 f.advance(5000);await f.service.pause({token:f.token,attemptId:a.id,lease:start.lease,snapshot:d});f.advance(3600000);
 const paused=(await f.service.read({token:f.token})).attempts.at(-1);assert.equal(paused.remainingMs,3595000);assert.equal(paused.activeQuestion,40);assert.deepEqual(paused.scroll,d.scroll);assert.deepEqual(paused.annotations,d.annotations);
 await assert.rejects(f.service.result({token:f.token,attemptId:a.id}),e=>e.code==='RESULT_NOT_AVAILABLE');
 const resumed=await f.service.resume({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});await f.service.activate({token:f.token,attemptId:a.id,lease:resumed.lease});d.activeMs=0;d.sequence++;
 const input={token:f.token,attemptId:a.id,lease:resumed.lease,snapshot:d,method:'manual',operationId:uuid()};
 const done=await f.service.submit(input),again=await f.service.submit(input);assert.equal(done.attempts.at(-1).finalScore,40);assert.equal(again.attempts.length,1);
 const result=await f.service.result({token:f.token,attemptId:a.id});assert.equal(result.attempt.result.rows.length,40);
 const reset=await f.service.reset({token:f.token,attemptId:a.id,owner:'device1',operationId:uuid()});assert.equal(reset.attempts.length,2);assert.equal(reset.attempts[1].remainingMs,3600000);assert.equal(reset.attempts[0].finalScore,40);
 await nextTurn();const doneReceipt=receipts.find(r=>r.receipt.data.status==='submitted');
 assert.equal(doneReceipt.scope.attemptId,a.id);assert.equal(doneReceipt.receipt.data.answeredCount,40);assert.equal(doneReceipt.receipt.data.expectedQuestions,40);
 assert.equal(receipts.filter(r=>r.receipt.data.action==='submit').length,1);
 assert.equal(receipts.at(-1).receipt.data.previousAttemptId,a.id);assert.equal(receipts.at(-1).scope.attemptNo,2);
});
test('full test đủ 60 phút đang làm tự chốt đúng một bản toàn bài',async t=>{
 const receipts=[];
 const b=content('full-reading-timeout-fixture'),f=await fixture(b,{journal:{recordReceipt:(_scope,receipt)=>receipts.push(receipt)}});t.after(f.close);const start=await f.begin(),a=start.attempts.at(-1),d=f.draft();d.answers={'40':'river'};let state;
 for(let i=0;i<720;i++){f.advance(5000);d.sequence++;d.activeMs+=5000;state=await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:d});}
 const done=state.attempts.at(-1);assert.equal(done.status,'submitted');assert.equal(done.method,'timeout');assert.equal(done.finalScore,1);assert.equal(done.remainingMs,0);assert.equal(state.events.filter(e=>e.type==='completed').length,1);
 await nextTurn();assert.ok(receipts.length<10);const closed=receipts.filter(r=>r.data.status==='submitted');
 assert.equal(closed.length,1);assert.equal(closed[0].data.method,'timeout');assert.equal(closed[0].data.expectedQuestions,40);
});
test('không nhận dẫn chứng ở passage khác hoặc cấu trúc passage thiếu câu',()=>{
 const b=content('full-reading-invalid-fixture');validateContent(b);const wrong=structuredClone(b);wrong.explanations.entries['1'].evidenceGroups[0].paragraph='p2_A';assert.throws(()=>validateContent(wrong),/passage khác/);
 const missingRange=structuredClone(b);delete missingRange.definition.groups[0].start;assert.throws(()=>validateContent(missingRange),/Phạm vi nhóm/);
 const bad=structuredClone(b.definition.lesson);bad.code='full-reading-bad-range';bad.passages[0].end=12;assert.throws(()=>registerAuthoredLesson(bad),/Passage thiếu/);
});

test('40 câu: khôi phục bản nháp hơn 64 KiB với 200 Highlight/Note rồi nộp đúng lượt',async t=>{
 const f=await fixture(content('full-reading-large-recovery-fixture'));t.after(f.close);
 const start=await f.begin(),attempt=start.attempts.at(-1),draft=f.draft();
 draft.answers=Object.fromEntries(Array.from({length:30},(_,i)=>[i+1,'river']));
 draft.activeQuestion=36;draft.sequence=1;draft.activeMs=5000;
 draft.annotations=Array.from({length:200},(_,i)=>({
  id:uuid(),kind:i%11===0?'note':'highlight',rootKey:'reading-passage-p3',skill:'reading',
  start:i,end:i+160,quote:'r'.repeat(160),questionRef:'36',note:i%11===0?'Fixture note':''
 }));
 f.advance(5000);
 const recovery={snapshot:draft,lease:start.lease};
 assert.ok(Buffer.byteLength(JSON.stringify(recovery))>65536);
 assert.deepEqual((await f.service.read({token:f.token})).attempts.at(-1).answers,{});
 const overflow={...draft,annotations:[...draft.annotations,{...draft.annotations.at(-1),id:uuid()}]};
 await assert.rejects(f.service.resume({token:f.token,attemptId:attempt.id,owner:'device1-reload',operationId:uuid(),
  recovery:{snapshot:overflow,lease:start.lease}}),{code:'ANNOTATION_LIMIT'});
 assert.deepEqual((await f.service.read({token:f.token})).attempts.at(-1).answers,{});
 f.advance(15*60*1000);
 const resumed=await f.service.resume({token:f.token,attemptId:attempt.id,owner:'device1-reload',operationId:uuid(),recovery});
 const restored=resumed.attempts.at(-1);
 assert.equal(restored.id,attempt.id);assert.equal(restored.remainingMs,3595000);
 assert.deepEqual(restored.answers,draft.answers);assert.deepEqual(restored.annotations,draft.annotations);
 await f.service.activate({token:f.token,attemptId:attempt.id,lease:resumed.lease});
 const submitted=await f.service.submit({token:f.token,attemptId:attempt.id,lease:resumed.lease,
  snapshot:{...draft,sequence:2,activeMs:0},method:'manual',operationId:uuid()});
 assert.equal(submitted.attempts.at(-1).status,'submitted');
 const result=await f.service.result({token:f.token,attemptId:attempt.id});
 assert.equal(result.attempt.finalScore,30);assert.deepEqual(result.attempt.annotations,draft.annotations);
});
