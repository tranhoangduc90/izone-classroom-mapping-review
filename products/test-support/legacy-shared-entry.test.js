// Dữ liệu giả: bài cũ mở toàn khóa nhưng giữ binding, Docs và lịch sử cá nhân.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture as readingFixture} from '../reading-practice/test/helpers.js';
import {fixture as listeningFixture} from '../listening-practice/test/helpers.js';
import {CODE as readingCode,uuid,secret} from '../reading-practice/src/domain.js';
import {CODE as listeningCode} from '../listening-practice/src/domain.js';
import {createApp as readingApp} from '../reading-practice/src/app.js';
import {createApp as listeningApp} from '../listening-practice/src/app.js';

for(const product of [
 {name:'Reading',schema:'reading_practice',fixture:readingFixture,code:readingCode,app:readingApp},
 {name:'Listening',schema:'listening_practice',fixture:listeningFixture,code:listeningCode,app:listeningApp}
]){
 async function setup(t){
  const f=await product.fixture();t.after(f.close);
  const second={studentRef:uuid(),name:'Học viên lớp mới'},late={studentRef:uuid(),name:'Học viên vào lớp sau'};
  const members={'1124':[{studentRef:f.studentRef,name:'Học viên kiểm thử'},late],'1356':[second]};
  f.context.classes=async()=>[{id:'1124',classCode:'FIXTURE 67'},{id:'1356',classCode:'FIXTURE NEW'}];
  f.context.roster=async id=>members[id]||[];
  f.context.student=async(id,ref)=>(members[id]||[]).find(x=>x.studentRef===ref);
  await f.pool.query(`UPDATE ${product.schema}.assignment SET source_course_id='fixture-course',source_work_id='fixture-work'`);
  return{...f,second,late,members};
 }
 test(product.name+': mở bài cũ qua link chung, trả đủ lớp và không lộ key hoặc tạo lượt',async t=>{
  const f=await setup(t);
  await assert.rejects(f.service.lessonCatalog({code:product.code}),e=>e.code==='LESSON_NOT_OPEN');
  await f.service.configureSharedLesson({code:product.code,contentVersion:f.content.version,status:'open'});
  const app=product.app({pool:f.pool,service:f.service,origins:[],googleClientId:'',adminKey:secret(),verifyGoogle:async()=>null});
  const catalog=await request(app).get('/api/library/'+product.code);
  assert.equal(catalog.status,200);assert.equal(catalog.body.classes.length,2);
  assert.equal(catalog.body.lesson.authored,product.name==='Listening'?false:undefined);
  for(const key of ['definition','key','answer_key','explanations'])assert.equal(catalog.body[key],undefined);
  const roster=await request(app).get('/api/library/'+product.code+'/classes/1356');
  assert.equal(roster.status,200);assert.equal(roster.body.students[0].id,f.second.studentRef);
  assert.equal((await f.pool.query(`SELECT count(*)::int n FROM ${product.schema}.work`)).rows[0].n,0);
 });
 test(product.name+': link chung dùng lại bản cá nhân, giữ nguồn, nháp và job Docs',async t=>{
  const f=await setup(t);await f.begin();
  await f.service.configureSharedLesson({code:product.code,contentVersion:f.content.version,status:'open'});
  const tables=['assignment','binding','work','doc_job'];
  const before={};for(const table of tables)before[table]=(await f.pool.query(`SELECT * FROM ${product.schema}.${table}`)).rows;
  const result=await f.service.sharedLogin({code:product.code,classId:'1124',studentRef:f.studentRef});
  assert.equal(result.identity.bindingId,f.registered.bindingId);
  assert.equal(result.identity.entryMode,'homework');assert.equal(result.identity.documentId,f.registration.documentId);
  assert.equal(result.attempts.length,1);
  for(const table of tables)assert.deepEqual((await f.pool.query(`SELECT * FROM ${product.schema}.${table}`)).rows,before[table],table);
  assert.equal((await f.service.login({entryToken:f.entryToken,studentRef:f.studentRef,classCode:'FIXTURE 67'})).identity.bindingId,result.identity.bindingId);
 });
 test(product.name+': lớp mới và học viên vào sau không bị chặn bởi assignment cá nhân cũ',async t=>{
  const f=await setup(t);await f.service.configureSharedLesson({code:product.code,contentVersion:f.content.version,status:'open'});
  const old=(await f.pool.query(`SELECT * FROM ${product.schema}.binding WHERE id=$1`,[f.registered.bindingId])).rows[0];
  const late=await f.service.sharedLogin({code:product.code,classId:'1124',studentRef:f.late.studentRef});
  const second=await f.service.sharedLogin({code:product.code,classId:'1356',studentRef:f.second.studentRef});
  assert.equal(late.identity.assignmentId,f.registered.assignmentId);assert.equal(late.identity.entryMode,'shared');
  assert.equal(second.identity.entryMode,'shared');assert.notEqual(second.identity.assignmentId,f.registered.assignmentId);
  assert.equal(late.attempts.length,0);assert.equal(second.attempts.length,0);
  assert.deepEqual((await f.pool.query(`SELECT * FROM ${product.schema}.binding WHERE id=$1`,[f.registered.bindingId])).rows[0],old);
  await assert.rejects(f.service.sharedLogin({code:product.code,classId:'1356',studentRef:f.studentRef}),e=>e.code==='STUDENT_NOT_ELIGIBLE');
  assert.equal((await f.pool.query(`SELECT count(*)::int n FROM ${product.schema}.work`)).rows[0].n,0);
 });
 test(product.name+': CTA chưa kiểm hoặc bài chung đóng vẫn bị chặn, link cá nhân cũ còn nguyên',async t=>{
  const f=await setup(t);await f.service.configureSharedLesson({code:product.code,contentVersion:f.content.version,status:'open'});
  await f.pool.query(`UPDATE ${product.schema}.binding SET cta_verified_at=NULL WHERE id=$1`,[f.registered.bindingId]);
  await assert.rejects(f.service.sharedLogin({code:product.code,classId:'1124',studentRef:f.studentRef}),e=>e.code==='ASSIGNMENT_NOT_READY');
  await f.pool.query(`UPDATE ${product.schema}.binding SET cta_verified_at=now() WHERE id=$1`,[f.registered.bindingId]);
  await f.service.configureSharedLesson({code:product.code,contentVersion:f.content.version,status:'closed'});
  await assert.rejects(f.service.sharedLogin({code:product.code,classId:'1124',studentRef:f.studentRef}),e=>e.code==='LESSON_NOT_OPEN');
  assert.equal((await f.service.login({entryToken:f.entryToken,studentRef:f.studentRef,classCode:'FIXTURE 67'})).identity.bindingId,f.registered.bindingId);
 });
}
