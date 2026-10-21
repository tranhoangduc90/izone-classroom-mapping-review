// Bài giả và hai lớp trùng tên người; kiểm Listening tự giữ lượt/Docs riêng theo UUID.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {registerAuthoredLesson} from '../src/authored-content.js';
import {uuid,secret} from '../src/domain.js';
import {createApp} from '../src/app.js';
import {createDocsWorker,CTA,STATUS_HEADING} from '../src/docs.js';
import {homeworkDocsFixture} from '../../test-support/homework-docs.js';

const code='67-practice-listening_shared-library-fixture';
const p=text=>({runs:[{text}]});
function content(){
 const groups=[{id:'notes',kind:'completion',label:'Notes',start:31,end:32,instruction:'ONE WORD ONLY',questions:[{n:31,text:'The roof is {blank}.'},{n:32,text:'The door is {blank}.'}]}];
 const lesson={code,lesson:10,title:'Library fixture',totalMs:130000,audioMs:10000,reviewMs:120000,paragraphs:['A'],groups:groups.map(({id,kind,label,start,end})=>({id,kind,label,start,end}))};
 registerAuthoredLesson(lesson);const key={31:['green'],32:['blue']};
 return{code,version:'shared-v1',totalMs:130000,key,definition:{authored:true,lesson,groups,mcq:[],audio:{durationMs:10000,sha256:'1'.repeat(64)}},explanations:{passage:{A:'The roof is green. The door is blue.'},entries:Object.fromEntries([31,32].map(n=>[n,{number:n,kind:'completion',answer:key[n],prompt:p('Library'),reason:[p('The colours are explicit.')],evidenceGroups:[{paragraph:'A',speaker:'',paragraphs:[p('The roof is green.')],marks:[{start:0,end:17}]}]}]))}};
}
async function setup(t){
 const f=await fixture();t.after(f.close);const bundle=content();await f.service.seedContent(bundle);
 const b={studentRef:uuid(),name:'Tên giống nhau'},members={'1124':[{studentRef:f.studentRef,name:'Tên giống nhau'}],'1293':[b]};
 f.context.classes=async()=>Object.keys(members).map(id=>({id,classCode:'IC'+id}));
 f.context.roster=async id=>members[id]||[];f.context.student=async(id,ref)=>(members[id]||[]).find(x=>x.studentRef===ref);
 await f.service.configureSharedLesson({code,contentVersion:bundle.version,status:'open'});
 return{...f,b,members,bundle};
}
test('Link Listening chung qua HTTP: chọn đúng lớp/UUID, không tự bắt đầu hoặc cấp key/audio',async t=>{
 const f=await setup(t),app=createApp({pool:f.pool,service:f.service,origins:[],googleClientId:'',adminKey:secret(),verifyGoogle:async()=>null});
 const catalog=await request(app).get('/api/library/'+code);assert.equal(catalog.status,200);assert.equal(catalog.body.classes.length,2);assert.equal(catalog.body.definition,undefined);assert.equal(catalog.body.key,undefined);
 assert.deepEqual((await f.service.lessonRoster({code,classId:'1293'})).students,[{id:f.b.studentRef,name:f.b.name}]);
 const responses=await Promise.all(Array.from({length:4},()=>f.service.sharedLogin({code,classId:'1124',studentRef:f.studentRef})));
 assert.equal(new Set(responses.map(r=>r.identity.bindingId)).size,1);assert.equal(responses[0].attempts.length,0);assert.equal(responses[0].identity.entryMode,'shared');assert.equal(responses[0].identity.documentUrl,null);
 assert.equal((await request(app).post('/api/shared-login').send({code,classId:'1124',studentRef:f.b.studentRef})).status,403);
 assert.equal((await request(app).post('/api/admin/shared-lesson').send({code,contentVersion:'shared-v1',status:'closed'})).status,403);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM listening_practice.work')).rows[0].n,0);
});
test('Lượt chung Listening: lưu/nộp/retry, hai người và link Homework không trộn, giữ chữ tay',async t=>{
 const f=await setup(t),a=await f.service.sharedLogin({code,classId:'1124',studentRef:f.studentRef}),b=await f.service.sharedLogin({code,classId:'1293',studentRef:f.b.studentRef});
 const first=await f.service.begin({token:a.token,owner:'A',operationId:uuid()}),attempt=first.attempts[0];
 await f.service.activate({token:a.token,attemptId:attempt.id,lease:first.lease});
 assert.equal(first.definition.passage,undefined);
 const snapshot={answers:{31:'green',32:'blue'},flags:[32],notes:'Người A',annotations:[],scroll:{passage:0,questions:{}},activeQuestion:32,tab:'completion',mobilePane:'questions',notesOpen:false,highlighted:[],sequence:1,activeMs:1000,phase:'listening',audioPosition:1};
 f.advance(1000);await f.service.pulse({token:a.token,attemptId:attempt.id,lease:first.lease,snapshot});
 const input={token:a.token,attemptId:attempt.id,lease:first.lease,snapshot,method:'manual',operationId:uuid()},done=await f.service.submit(input),again=await f.service.submit(input);
 assert.equal(done.attempts[0].finalScore,2);assert.equal(done.attempts[0].submissionId,again.attempts[0].submissionId);
 assert.deepEqual((await f.service.read({token:b.token})).attempts,[]);
 await assert.rejects(f.service.result({token:b.token,attemptId:attempt.id}),e=>e.code==='RESULT_NOT_AVAILABLE');
 await f.pool.query('DELETE FROM listening_practice.doc_job WHERE binding_id<>$1',[a.identity.bindingId]);
 const documentId='shared_listening_homework_fixture_1234';
 const hw=homeworkDocsFixture({code,documentId,tabId:'t.0',cta:CTA,entryUrl:'https://page.test/?lesson='+code,prefix:'Listening thực chiến (tự động): ',heading:STATUS_HEADING});
 let calls=0;const resolver=async binding=>{calls++;assert.equal(binding.student_ref,f.studentRef);assert.equal(binding.class_id,'1124');return{classId:'1124',studentRef:f.studentRef,code,documentId,tabId:'t.0'};};
 const worker=createDocsWorker({pool:f.pool,docs:hw.docs,resolveSharedHomework:resolver});
 while(await worker.once());
 const jobs=(await f.pool.query('SELECT status FROM listening_practice.doc_job')).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.status==='verified'));assert.equal(calls,2);
 assert.ok(hw.value.startsWith(hw.manual+'\nListening thực chiến (tự động): '));assert.ok(hw.link.endsWith('#submission='+done.attempts[0].submissionId));
 assert.equal(await worker.once(),false);const reopened=await f.service.sharedLogin({code,classId:'1124',studentRef:f.studentRef});assert.equal(reopened.identity.documentId,documentId);assert.equal(reopened.attempts[0].finalScore,2);
 await f.service.configureSharedLesson({code,contentVersion:f.bundle.version,status:'closed'});await assert.rejects(f.service.sharedLogin({code,classId:'1124',studentRef:f.studentRef}),e=>e.code==='LESSON_NOT_OPEN');
 assert.equal((await f.service.read({token:a.token})).attempts[0].finalScore,2);
});
