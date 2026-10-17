import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fixtureContent} from './helpers.js';
import {ROBOTS_CODE,lessonFor} from '../src/lessons.js';
import {CODE,emptyDraft,validateSnapshot,validateContent,grade,uuid,secret} from '../src/domain.js';
import {planDocWrite,CTA} from '../src/docs.js';

// Đề và key giả để kiểm cấu trúc 7/3/4; không đưa nội dung Cambridge vào Git.
function robots(){
 const numbered=(start,end)=>Array.from({length:end-start+1},(_,i)=>({n:start+i,text:`Fixture statement ${start+i}`}));
 const ids=lessonFor(ROBOTS_CODE).questionIds;
 const paragraph={runs:[{text:'Fixture evidence'}]},evidence=()=>[{paragraph:'1',speaker:'Fixture expert A',paragraphs:[paragraph],marks:[{start:0,end:7,background:'#ffff00'}]},{paragraph:'2',speaker:'Fixture expert B',paragraphs:[paragraph],marks:[]}];
 return{code:ROBOTS_CODE,version:'fixture-robots-v1',totalMs:1200000,
  key:Object.fromEntries(ids.map(n=>[n,['B']])),definition:{passage:Object.fromEntries(Array.from({length:11},(_,i)=>[i+1,'Fixture evidence text.'])),
   names:numbered(27,33),endings:numbered(34,36),mcq:numbered(37,40).map(q=>({...q,options:['Fixture A','Fixture B','Fixture C','Fixture D']})),
   experts:['A','B','C'].map(n=>[n,`Fixture expert ${n}`]),endingOptions:['A','B','C','D'].map(n=>[n,`Fixture ending ${n}`])},
  explanations:{entries:Object.fromEntries(ids.map(n=>[n,{number:+n,kind:+n<34?'names':+n<37?'endings':'mcq',answer:['B'],prompt:paragraph,completion:paragraph,reason:[paragraph],
   options:['A','B','C','D'].map(letter=>({letter,correct:letter==='B',label:paragraph,reason:[paragraph],evidenceGroups:evidence()})),evidenceGroups:evidence()}]))}};
}
test('Hai bài giữ phạm vi nháp riêng và chấm theo dạng câu, không theo ngưỡng số câu',()=>{
 const old=fixtureContent(),next=robots();validateContent(old);validateContent(next);
 assert.equal(grade(Object.fromEntries(Object.entries(old.key).map(([n,v])=>[n,v[0]])),old.key).score,13);
 assert.equal(grade(Object.fromEntries(Object.entries(next.key).map(([n,v])=>[n,' b '])),next.key,ROBOTS_CODE).score,14);
 assert.throws(()=>validateSnapshot({...emptyDraft(),answers:{40:'B'}}),e=>e.code==='INVALID_DRAFT');
 for(const patch of [{answers:{14:'B'}},{flags:[26]},{activeQuestion:26},{tab:'summary'},{highlighted:['A']}])assert.throws(()=>validateSnapshot({...emptyDraft(ROBOTS_CODE),...patch},ROBOTS_CODE),e=>e.code==='INVALID_DRAFT');
 assert.equal(validateSnapshot({...emptyDraft(ROBOTS_CODE),answers:{27:'B',40:'B'},flags:[40],activeQuestion:40,tab:'mcq'},ROBOTS_CODE).answers[40],'B');
});
test('Nội dung mới thiếu Q40, lệch loại/key/dẫn chứng hoặc mã lạ bị từ chối',()=>{
 for(const mutate of [b=>delete b.key[40],b=>b.definition.mcq.pop(),b=>b.explanations.entries[34].kind='names',b=>b.key[27]=['D'],b=>b.explanations.entries[27].evidenceGroups[0].marks[0].end=900,b=>b.code='toString',b=>delete b.explanations.entries[37].prompt,b=>b.explanations.entries[34].evidenceGroups.pop(),b=>b.explanations.entries[40].options[0].correct=true]){
  const b=robots();mutate(b);assert.throws(()=>validateContent(b),e=>e.code==='CONTENT_INVALID');
 }
});
test('Buổi 9: metadata trước bắt đầu, nháp Q40/phục hồi, nộp 14/14 bất biến và reset giữ lịch sử',async t=>{
 const f=await fixture(robots());t.after(f.close);
 const open=await f.service.open({entryToken:f.entryToken});assert.equal(open.assignmentCode,ROBOTS_CODE);assert.equal(open.lesson.questionIds.length,14);
 assert.equal(open.definition,undefined);assert.equal(open.key,undefined);assert.equal(open.explanations,undefined);
 const first=await f.begin(),a=first.attempts.at(-1),snapshot={...f.draft(),answers:{27:'B',40:'B'},flags:[40],activeQuestion:40,tab:'mcq',notes:'Ghi chú lượt 1',sequence:1,activeMs:2000};
 assert.equal(a.activeQuestion,27);assert.equal(a.tab,'names');assert.equal(first.key,undefined);
 await assert.rejects(f.service.result({token:f.token,attemptId:a.id}),e=>e.code==='RESULT_NOT_AVAILABLE');
 f.advance(2000);await f.service.pause({token:f.token,attemptId:a.id,lease:first.lease,snapshot});f.advance(86400000);
 const resumed=await f.service.resume({token:f.token,attemptId:a.id,owner:'device2',operationId:uuid()});
 assert.equal(resumed.attempts.length,1);assert.equal(resumed.attempts[0].remainingMs,1198000);assert.equal(resumed.attempts[0].answers[40],'B');assert.equal(resumed.attempts[0].notes,snapshot.notes);
 const final={...snapshot,answers:Object.fromEntries(lessonFor(ROBOTS_CODE).questionIds.map(n=>[n,'B'])),sequence:2,activeMs:0};
 const input={token:f.token,operationId:uuid(),attemptId:a.id,lease:resumed.lease,snapshot:final,method:'manual'};
 const submitted=await f.service.submit(input),retry=await f.service.submit(input);
 assert.equal(submitted.attempts[0].finalScore,14);assert.equal(submitted.attempts[0].submissionId,retry.attempts[0].submissionId);
 const result=await f.service.result({token:f.token,attemptId:a.id});assert.equal(result.key[40][0],'B');assert.equal(result.attempt.result.rows.length,14);
 const reset=await f.service.reset({token:f.token,attemptId:a.id,owner:'device2',operationId:uuid()});
 assert.equal(reset.attempts.length,2);assert.equal(reset.attempts[0].finalScore,14);assert.deepEqual(reset.attempts[1].answers,{});assert.equal(reset.attempts[1].activeQuestion,27);
});
test('Cùng học viên có hai bài: mã CTA, nháp và kết quả không trộn',async t=>{
 const f=await fixture();t.after(f.close);const old=await f.begin();
 const bundle=robots();await f.service.seedContent(bundle);
 const entryToken=secret(),registration={...f.registration,code:ROBOTS_CODE,contentVersion:bundle.version,documentId:'fixture_robots_document_123456',entryToken};
 const next=await f.service.register(registration);assert.equal(new URL(next.entryUrl).searchParams.get('assignmentCode'),ROBOTS_CODE);
 await f.pool.query("UPDATE reading_practice.assignment SET status='open'");await f.pool.query('UPDATE reading_practice.binding SET cta_verified_at=now()');
 const login=await f.service.login({entryToken,studentRef:f.studentRef,classCode:f.registration.classCode});
 const started=await f.service.begin({token:login.token,owner:'new',operationId:uuid()});assert.equal(started.attempts[0].activeQuestion,27);
 const legacy=await f.service.read({token:f.token});assert.equal(legacy.lesson.code,CODE);assert.equal(legacy.attempts[0].id,old.attempts[0].id);assert.equal(legacy.attempts[0].activeQuestion,14);
 await assert.rejects(f.service.result({token:f.token,attemptId:started.attempts[0].id}),e=>e.code==='RESULT_NOT_AVAILABLE');
 const changed=robots();changed.definition.passage[1]='Changed';await assert.rejects(f.service.seedContent(changed),e=>e.code==='CONTENT_VERSION_CONFLICT');
});
test('Docs chọn đúng mã buổi 9; tab chỉ có mã bài cũ bị chặn',()=>{
 const b={document_id:'fixture',tab_id:'t.0',code:ROBOTS_CODE};
 const document=code=>({documentId:'fixture',revisionId:'r1',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[{paragraph:{elements:[{startIndex:1,endIndex:code.length+1,textRun:{content:code}}]}},{paragraph:{elements:[{startIndex:100,endIndex:100+CTA.length,textRun:{content:CTA}}]}}]}}}]});
 const job={kind:'cta',payload:{url:'https://example.test/reading'}};
 assert.equal(planDocWrite(document(ROBOTS_CODE),b,job).requests.length,1);
 assert.throws(()=>planDocWrite(document(CODE),b,job),e=>e.code==='DOC_CODE_MISMATCH');
});
