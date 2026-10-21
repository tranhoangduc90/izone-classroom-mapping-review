import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {registerAuthoredLesson} from '../src/authored-content.js';
import {validateContent,uuid,secret} from '../src/domain.js';
import {createDocsWorker,CTA,STATUS_HEADING} from '../src/docs.js';
import {homeworkDocsFixture} from '../../test-support/homework-docs.js';

// Đề mới tự soạn, khác cả phạm vi/số câu/dạng của bài Cambridge mẫu.
// Kỳ vọng A/roof được chốt ở fixture, không lấy từ hàm chấm để sinh oracle.
const kind='listening';
function content(){
 const listening=kind==='listening',code='67-practice-'+kind+'_new-library-eval';
 const groups=[{id:'first',kind:'mcq',label:'Multiple Choice',start:1,end:2,instruction:'Choose one letter.',
  questions:[{n:1,text:'Which day is the library open?',options:[{value:'A',text:'Sunday'},{value:'B',text:'Monday'}]},{n:2,text:'Which room has a green roof?',options:[{value:'A',text:'The old room'},{value:'B',text:'The new room'}]}]},
  {id:'last',kind:'completion',label:'Note Completion',start:3,end:4,instruction:'Write ONE WORD.',maxWords:1,questions:[{n:3,text:'The new room has a green ___.'},{n:4,text:'The library opens on ___.'}]}];
 const passage={A:'The library opens on Sunday. The new room has a green roof.'};
 const lesson={code,lesson:77,title:'Library evaluation',paragraphs:['A'],groups:groups.map(({id,kind,label,start,end})=>({id,kind,label,start,end})),totalMs:listening?9000:1200000,...(listening?{audioMs:7000,reviewMs:2000}:{})};
 registerAuthoredLesson(lesson);
 const key={'1':['A'],'2':['B'],'3':['roof'],'4':['Sunday']};
 const p=text=>({runs:[{text,background:'#fff2cc'}]});
 const entries=Object.fromEntries(Object.keys(key).map(n=>[n,{number:+n,kind:+n<3?'mcq':'completion',answer:key[n],prompt:p('Library question '+n),reason:[p('The source identifies the day and the roof.')],evidenceGroups:[{paragraph:'A',speaker:'',paragraphs:[p(passage.A)],marks:[{start:0,end:7,background:'#fff2cc'}]}]}]));
 return{code,version:'new-library-v1',totalMs:lesson.totalMs,key,explanations:{entries,...(listening?{passage}:{})},
  definition:{authored:true,lesson,groups,mcq:[],...(listening?{audio:{durationMs:7000,sha256:'1'.repeat(64)}}:{passage})}};
}
test('bài mới qua API/SQL: đủ câu ngoài range mẫu, phục hồi, chấm, kết quả và lịch sử riêng',async()=>{
 const f=await fixture();try{
  const bundle=content();validateContent(bundle);await f.service.seedContent(bundle);
  const entryToken=secret(),documentId='new_eval_document_1234567890';
  const reg=await f.service.register({...f.registration,code:bundle.code,contentVersion:bundle.version,documentId,entryToken});
  await f.pool.query('UPDATE listening_practice.assignment SET status=\'open\'');
  await f.pool.query('UPDATE listening_practice.binding SET cta_verified_at=now()');
  const login=await f.service.login({entryToken,studentRef:f.studentRef,classCode:f.registration.classCode});
  const token=login.token,begin=await f.service.begin({token,owner:'new-device',operationId:uuid()});
  const a=begin.attempts.at(-1);assert.equal(a.activeQuestion,1);assert.equal(a.remainingMs,bundle.totalMs);
  assert.equal(begin.definition.authored,true);assert.equal('key' in begin,false);
  assert.equal('passage' in begin.definition,kind!=='listening');
  await f.service.activate({token,attemptId:a.id,lease:begin.lease});
  const draft={answers:{...a.answers,'1':'A','2':'B','3':'roof','4':'Sunday'},flags:[4],notes:'new draft',annotations:[],scroll:{passage:0,questions:{}},activeQuestion:4,tab:'completion',mobilePane:'questions',notesOpen:false,highlighted:[],sequence:1,activeMs:1000,...(kind==='listening'?{phase:'listening',audioPosition:1}:{})};
  f.advance(1000);
  await f.service.pulse({token,attemptId:a.id,lease:begin.lease,snapshot:draft});
  const saved=await f.service.read({token});assert.equal(saved.attempts.at(-1).answers['4'],'Sunday');
  await assert.rejects(()=>f.service.result({token,attemptId:a.id}),e=>e.code==='RESULT_NOT_AVAILABLE');
  const id=uuid(),input={token,operationId:id,attemptId:a.id,lease:begin.lease,snapshot:draft,method:'manual'};
  const submitted=await f.service.submit(input),again=await f.service.submit(input);
  assert.equal(submitted.attempts.at(-1).finalScore,4);assert.equal(again.attempts.length,1);
  const result=await f.service.result({token,attemptId:a.id});assert.equal(Object.keys(result.key).length,4);
  // Worker/SQL thật cho đúng Homework giả của bài mới; không chạy Google hay thay bài học viên.
  await f.pool.query('DELETE FROM listening_practice.doc_job WHERE binding_id<>$1',[login.identity.bindingId]);
  const beforeDocs=(await f.pool.query('SELECT state,updated_at FROM listening_practice.work WHERE binding_id=$1',[login.identity.bindingId])).rows;
  const homework=homeworkDocsFixture({code:bundle.code,documentId,tabId:f.registration.tabId,cta:CTA,entryUrl:reg.entryUrl,prefix:'Listening thực chiến (tự động): ',heading:STATUS_HEADING});
  const worker=createDocsWorker({pool:f.pool,docs:homework.docs});
  for(let i=0;i<4&&await worker.once();i++);
  const docJobs=(await f.pool.query('SELECT status,payload FROM listening_practice.doc_job WHERE binding_id=$1 ORDER BY sequence',[login.identity.bindingId])).rows;
  assert.equal(docJobs.length,3);assert.ok(docJobs.every(j=>j.status==='verified'));
  assert.ok(homework.value.startsWith(homework.manual+'\nListening thực chiến (tự động): '));assert.equal(homework.link,docJobs.at(-1).payload.link);
  assert.ok(homework.link.endsWith('#submission='+submitted.attempts.at(-1).submissionId));
  assert.deepEqual((await f.pool.query('SELECT state,updated_at FROM listening_practice.work WHERE binding_id=$1',[login.identity.bindingId])).rows,beforeDocs);
  const reset=await f.service.reset({token,owner:'new-device',operationId:uuid(),attemptId:a.id});
  assert.equal(reset.attempts.length,2);assert.equal(reset.attempts[0].finalScore,4);assert.deepEqual(reset.attempts[1].answers,{});
  assert.equal((await f.service.read({token:f.token})).attempts.length,0);
  assert.equal(reg.assignmentId,login.identity.assignmentId);
 }finally{await f.close();}
});
test('bundle lỗi bị từ chối theo câu/key/dẫn chứng, không seed dữ liệu thiếu',()=>{
 const source=content();const missing=structuredClone(source);delete missing.explanations.entries['4'];
 assert.throws(()=>validateContent(missing),/thiếu|thừa/);
 const wrong=structuredClone(source);wrong.key['1']=['Z'];assert.throws(()=>validateContent(wrong),/lựa chọn/);
 const bad=structuredClone(source);bad.explanations.entries['2'].evidenceGroups[0].marks[0].end=9999;
 assert.throws(()=>validateContent(bad),/nguồn/);
});

test('bài mới dùng đúng thời lượng audio và rà riêng, tự thu mà không dùng giờ bài mẫu',async()=>{
 const f=await fixture();try{
  const bundle=content();await f.service.seedContent(bundle);const entryToken=secret();
  await f.service.register({...f.registration,code:bundle.code,contentVersion:bundle.version,documentId:'new_timing_document_1234567890',entryToken});
  await f.pool.query("UPDATE listening_practice.assignment SET status='open'");await f.pool.query('UPDATE listening_practice.binding SET cta_verified_at=now()');
  const {token}=await f.service.login({entryToken,studentRef:f.studentRef,classCode:f.registration.classCode});
  const start=await f.service.begin({token,owner:'new-timing',operationId:uuid()}),a=start.attempts.at(-1);
  await f.service.activate({token,attemptId:a.id,lease:start.lease});
  const d={answers:{'1':'A','2':'B','3':'roof','4':'Sunday'},flags:[],notes:'',annotations:[],scroll:{passage:0,questions:{}},activeQuestion:1,tab:'mcq',mobilePane:'passage',notesOpen:false,highlighted:[],sequence:1,activeMs:5000,phase:'listening',audioPosition:5};
  f.advance(5000);await f.service.pulse({token,attemptId:a.id,lease:start.lease,snapshot:d});
  f.advance(2000);Object.assign(d,{sequence:2,activeMs:7000,phase:'review',audioPosition:7});
  const review=await f.service.pulse({token,attemptId:a.id,lease:start.lease,snapshot:d});assert.equal(review.attempts.at(-1).reviewRemainingMs,2000);
  f.advance(2000);Object.assign(d,{sequence:3,activeMs:9000});
  const done=await f.service.pulse({token,attemptId:a.id,lease:start.lease,snapshot:d});
  assert.equal(done.attempts.at(-1).status,'submitted');assert.equal(done.attempts.at(-1).method,'timeout');assert.equal(done.attempts.at(-1).finalScore,4);
  assert.equal(done.events.filter(e=>e.type==='completed').length,1);
 }finally{await f.close();}
});
