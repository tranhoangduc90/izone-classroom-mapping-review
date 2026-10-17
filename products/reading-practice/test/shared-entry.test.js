import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {ROBOTS_CODE} from '../src/lessons.js';
import {emptyDraft,secret,uuid} from '../src/domain.js';
import {createApp} from '../src/app.js';

// Nội dung giả có cấu trúc 14 câu; kiểm hành vi bằng SQL/HTTP, không đưa đề/key Cambridge vào Git.
function bundle(){
 const ids=Array.from({length:14},(_,i)=>i+27),paragraph={runs:[{text:'Fixture evidence'}]},groups=[1,2].map(n=>({paragraph:String(n),speaker:'Fixture expert',paragraphs:[paragraph],marks:[]}));
 return{code:ROBOTS_CODE,version:'shared-fixture-v1',totalMs:1200000,key:Object.fromEntries(ids.map(n=>[n,['C']])),
  definition:{passage:Object.fromEntries(Array.from({length:11},(_,i)=>[i+1,'Fixture evidence'])),names:ids.slice(0,7).map(n=>({n,text:'Fixture name question'})),endings:ids.slice(7,10).map(n=>({n,text:'Fixture ending question'})),mcq:ids.slice(10).map(n=>({n,text:'Fixture MCQ',options:['A text','B text','C text','D text']})),experts:['A','B','C'].map(n=>[n,'Fixture expert']),endingOptions:['A','B','C','D'].map(n=>[n,'Fixture ending'])},
  explanations:{entries:Object.fromEntries(ids.map(n=>[n,{number:n,kind:n<34?'names':n<37?'endings':'mcq',answer:['C'],prompt:paragraph,completion:paragraph,reason:[paragraph],evidenceGroups:groups,options:['A','B','C','D'].map(letter=>({letter,correct:letter==='C',label:paragraph,reason:[paragraph],evidenceGroups:groups}))}]))}};
}
async function setup(t){
 const f=await fixture();t.after(f.close);const content=bundle();await f.service.seedContent(content);
 const memberB={studentRef:uuid(),name:'Học viên lớp B'},classes=[{id:'1124',classCode:'FIXTURE 67'},{id:'1293',classCode:'FIXTURE B'}];
 const members={'1124':[{studentRef:f.studentRef,name:'Học viên lớp A'}],'1293':[memberB]};
 f.context.classes=async()=>classes;f.context.roster=async id=>members[id]||[];f.context.student=async(id,ref)=>(members[id]||[]).find(m=>m.studentRef===ref);
 await f.service.configureSharedLesson({code:ROBOTS_CODE,contentVersion:content.version,status:'open'});
 const login=(classId='1124',studentRef=f.studentRef)=>f.service.sharedLogin({code:ROBOTS_CODE,classId,studentRef});
 return{...f,content,memberB,classes,members,login};
}
test('Link chung: catalog/roster không tạo lượt, không cấp đề/key; chỉ trả học viên của lớp chọn',async t=>{
 const f=await setup(t),catalog=await f.service.lessonCatalog({code:ROBOTS_CODE});
 assert.equal(catalog.classes.length,2);assert.equal(catalog.lesson.questionIds.length,14);for(const key of ['key','definition','explanations'])assert.equal(catalog[key],undefined);
 const roster=await f.service.lessonRoster({code:ROBOTS_CODE,classId:'1293'});assert.deepEqual(roster.students,[{id:f.memberB.studentRef,name:f.memberB.name}]);
 await assert.rejects(f.service.lessonRoster({code:ROBOTS_CODE,classId:'9999'}),e=>e.code==='CLASS_NOT_ELIGIBLE');
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM reading_practice.work')).rows[0].n,0);
});
test('Link chung: đăng nhập đồng thời chỉ một binding, lớp/UUID sai hoặc bị loại không mở phiên',async t=>{
 const f=await setup(t),logins=await Promise.all(Array.from({length:6},()=>f.login()));
 assert.equal(new Set(logins.map(r=>r.identity.bindingId)).size,1);assert.equal(logins[0].attempts.length,0);assert.equal(logins[0].identity.entryMode,'shared');assert.equal(logins[0].identity.documentUrl,null);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM reading_practice.binding WHERE document_id IS NULL')).rows[0].n,1);
 await assert.rejects(f.login('1124',f.memberB.studentRef),e=>e.code==='STUDENT_NOT_ELIGIBLE');await assert.rejects(f.login('9999'),e=>e.code==='STUDENT_NOT_ELIGIBLE');
 f.members['1124']=[];await assert.rejects(f.login(),e=>e.code==='STUDENT_NOT_ELIGIBLE');await assert.rejects(f.service.read({token:logins[0].token}),e=>e.code==='STUDENT_NOT_ELIGIBLE');
});
test('Link chung: nộp 14/14, mở lại đúng lịch sử; hai lớp không trộn và không sinh job Docs',async t=>{
 const f=await setup(t),loginA=await f.login(),loginB=await f.login('1293',f.memberB.studentRef);
 const first=await f.service.begin({token:loginA.token,owner:'A',operationId:uuid()});assert.equal(first.attempts[0].activeQuestion,27);
 const snapshot={...emptyDraft(ROBOTS_CODE),answers:Object.fromEntries(Object.keys(f.content.key).map(n=>[n,'C'])),sequence:1,flags:[40],activeQuestion:40,tab:'mcq',notes:'Nháp A'};
 const input={token:loginA.token,attemptId:first.attempts[0].id,lease:first.lease,snapshot,method:'manual',operationId:uuid()};
 const done=await f.service.submit(input),retry=await f.service.submit(input);assert.equal(done.attempts[0].finalScore,14);assert.equal(done.attempts[0].submissionId,retry.attempts[0].submissionId);assert.equal(done.events.at(-1).docs,'not_applicable');
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM reading_practice.doc_job WHERE binding_id=$1',[loginA.identity.bindingId])).rows[0].n,0);
 const reopened=await f.login();assert.equal(reopened.attempts[0].finalScore,14);assert.equal(reopened.attempts[0].notes,'Nháp A');assert.deepEqual((await f.service.read({token:loginB.token})).attempts,[]);
 await assert.rejects(f.service.result({token:loginB.token,attemptId:done.attempts[0].id}),e=>e.code==='RESULT_NOT_AVAILABLE');
 assert.equal((await f.service.login({entryToken:f.entryToken,studentRef:f.studentRef,classCode:'FIXTURE 67'})).identity.entryMode,'homework');
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM reading_practice.doc_job WHERE binding_id=$1',[f.registered.bindingId])).rows[0].n,1);
});
test('Link chung: đóng bài chặn login/reset, vẫn đọc và tiếp tục lượt cũ; phiên bản đã ghim không đổi',async t=>{
 const f=await setup(t),logged=await f.login(),first=await f.service.begin({token:logged.token,owner:'A',operationId:uuid()});
 await f.service.configureSharedLesson({code:ROBOTS_CODE,contentVersion:f.content.version,status:'closed'});
 await assert.rejects(f.login(),e=>e.code==='LESSON_NOT_OPEN');await assert.rejects(f.service.lessonCatalog({code:ROBOTS_CODE}),e=>e.code==='LESSON_NOT_OPEN');
 assert.equal((await f.service.read({token:logged.token})).attempts.length,1);
 assert.equal((await f.service.resume({token:logged.token,attemptId:first.attempts[0].id,owner:'A',operationId:uuid()})).attempts.length,1);
 await assert.rejects(f.service.reset({token:logged.token,attemptId:first.attempts[0].id,owner:'A',operationId:uuid()}),e=>e.code==='ASSIGNMENT_CLOSED');
 const next={...f.content,version:'shared-fixture-v2'};await f.service.seedContent(next);await assert.rejects(f.service.configureSharedLesson({code:ROBOTS_CODE,contentVersion:next.version,status:'open'}),e=>e.code==='CONTENT_VERSION_CONFLICT');
 await f.service.configureSharedLesson({code:ROBOTS_CODE,contentVersion:f.content.version,status:'open'});assert.equal((await f.login()).attempts.length,1);
});
test('Link chung: schema không cho Docs null thiếu marker; không đổi binding Homework cũ',async t=>{
 const f=await setup(t),before=(await f.pool.query('SELECT document_id,tab_id,owner_proof FROM reading_practice.binding WHERE id=$1',[f.registered.bindingId])).rows[0];
 await assert.rejects(f.pool.query('INSERT INTO reading_practice.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof) VALUES($1,$2,$3,NULL,NULL,$4,$5)',[uuid(),f.registered.assignmentId,uuid(),secret(),{}]),e=>e.code==='23514');
 await f.login();const after=(await f.pool.query('SELECT document_id,tab_id,owner_proof FROM reading_practice.binding WHERE id=$1',[f.registered.bindingId])).rows[0];assert.deepEqual(after,before);
});
test('Link chung qua HTTP: metadata, login, chưa nộp khóa key và admin mở bài cần quyền',async t=>{
 const f=await setup(t),adminKey=secret(),app=createApp({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'',adminKey,verifyGoogle:async()=>null});
 const catalog=await request(app).get('/api/library/9');assert.equal(catalog.status,200);assert.equal(catalog.headers['cache-control'],'no-store');assert.equal(catalog.body.lesson.lesson,9);assert.equal(catalog.body.key,undefined);
 const logged=await request(app).post('/api/shared-login').send({code:ROBOTS_CODE,classId:'1124',studentRef:f.studentRef});assert.equal(logged.status,200);assert.equal(logged.body.attempts.length,0);
 const denied=await request(app).post('/api/shared-login').send({code:ROBOTS_CODE,classId:'1124',studentRef:f.memberB.studentRef});assert.equal(denied.status,403);
 assert.equal((await request(app).post('/api/admin/shared-lesson').send({code:ROBOTS_CODE,contentVersion:f.content.version,status:'closed'})).status,403);
 assert.equal((await request(app).get('/api/result/'+uuid()).set('Authorization','Bearer '+logged.body.token)).status,404);
});
