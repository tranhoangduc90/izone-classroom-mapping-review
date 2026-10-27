// Full test giả 40 câu kiểm giờ/lượt/nháp bằng SQL thật, không chứa nội dung Cambridge.
import test from 'node:test';import assert from 'node:assert/strict';
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
 const b=content('full-reading-40-fixture'),f=await fixture(b);t.after(f.close);
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
});
test('full test đủ 60 phút đang làm tự chốt đúng một bản toàn bài',async t=>{
 const b=content('full-reading-timeout-fixture'),f=await fixture(b);t.after(f.close);const start=await f.begin(),a=start.attempts.at(-1),d=f.draft();d.answers={'40':'river'};let state;
 for(let i=0;i<720;i++){f.advance(5000);d.sequence++;d.activeMs+=5000;state=await f.service.pulse({token:f.token,attemptId:a.id,lease:start.lease,snapshot:d});}
 const done=state.attempts.at(-1);assert.equal(done.status,'submitted');assert.equal(done.method,'timeout');assert.equal(done.finalScore,1);assert.equal(done.remainingMs,0);assert.equal(state.events.filter(e=>e.type==='completed').length,1);
});
test('không nhận dẫn chứng ở passage khác hoặc cấu trúc passage thiếu câu',()=>{
 const b=content('full-reading-invalid-fixture');validateContent(b);const wrong=structuredClone(b);wrong.explanations.entries['1'].evidenceGroups[0].paragraph='p2_A';assert.throws(()=>validateContent(wrong),/passage khác/);
 const missingRange=structuredClone(b);delete missingRange.definition.groups[0].start;assert.throws(()=>validateContent(missingRange),/Phạm vi nhóm/);
 const bad=structuredClone(b.definition.lesson);bad.code='full-reading-bad-range';bad.passages[0].end=12;assert.throws(()=>registerAuthoredLesson(bad),/Passage thiếu/);
});
