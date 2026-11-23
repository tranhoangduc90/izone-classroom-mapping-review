import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';

test('HTTP: Safari bounce keeps the same Reading draft through save, pause, resume and submit',async t=>{
 const f=await fixture();t.after(f.close);
 const app=createApp({pool:f.pool,service:f.service,origins:['https://page.test']});
 const auth=`Bearer ${f.token}`;
 const post=async(action,body)=>{
  const response=await request(app).post(`/api/${action}`).set('Authorization',auth).send(body);
  assert.equal(response.status,200,`${action}: ${response.body.error?.code||''}`);
  return response.body;
 };
 const start=await f.begin(),attemptId=start.attempts[0].id;
 const base={...f.draft(),sequence:1,activeMs:4000,answers:{14:'i'},flags:[14],notes:'Fixture note',
  scroll:{passage:-18.5,questions:{all:-6.75,headings:21.25}}};
 f.advance(4000);
 await post('pulse',{attemptId,lease:start.lease,snapshot:base});
 const paused=await post('pause',{attemptId,lease:start.lease,snapshot:{...base,sequence:2}});
 assert.equal(paused.attempts[0].status,'paused');
 f.advance(300000);
 const local={...base,sequence:3,answers:{...base.answers,21:'A'}};
 const resumed=await post('resume',{attemptId,owner:'browser',operationId:uuid(),recovery:{snapshot:local,lease:start.lease}});
 assert.notEqual(resumed.lease.id,start.lease.id);
 await post('activate',{attemptId,lease:resumed.lease});
 const state=await request(app).get('/api/state').set('Authorization',auth);
 assert.equal(state.status,200);
 assert.equal(state.body.attempts.length,1);
 const a=state.body.attempts[0];
 assert.equal(a.id,attemptId);
 assert.equal(a.remainingMs,start.attempts[0].remainingMs-4000);
 assert.deepEqual(a.answers,local.answers);
 assert.deepEqual(a.flags,local.flags);
 assert.equal(a.notes,local.notes);
 assert.deepEqual(a.scroll,{passage:0,questions:{all:0,headings:21.25}});
 const submission={operationId:uuid(),attemptId,lease:resumed.lease,method:'manual',snapshot:{...local,sequence:4,activeMs:0}};
 const done=await post('submit',submission);
 const retry=await post('submit',submission);
 assert.equal(done.attempts[0].finalScore,2);
 assert.equal(retry.attempts[0].submissionId,done.attempts[0].submissionId);
});

test('HTTP: chỉ chủ Docs mở bài, không rò key trước nộp, teacher không có quyền không xem',async t=>{
 const f=await fixture();t.after(f.close);
 const adminKey=secret(),app=createApp({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'google-client-fixture',adminKey,verifyGoogle:async credential=>({email:credential==='valid-google-fixture'?'teacher@example.test':'other@example.test',sub:'google-fixture',email_verified:true})});
 assert.equal((await request(app).get('/api/admin/status')).status,403);
 assert.equal((await request(app).post('/api/admin/assignment').set('x-reading-admin',adminKey).send({assignmentId:f.registered.assignmentId,status:'open'})).status,409);
 await f.pool.query('UPDATE reading_practice.binding SET owner_proof=$1',[{verifiedAt:new Date().toISOString(),submissionId:'fixture-owned-submission'}]);
 assert.equal((await request(app).post('/api/admin/assignment').set('x-reading-admin',adminKey).send({assignmentId:f.registered.assignmentId,status:'open'})).status,200);
 assert.equal((await request(app).get('/api/admin/status').set('x-reading-admin',adminKey)).body.assignments[0].verified_ctas,1);
 assert.equal((await request(app).post('/api/open').set('Origin','https://evil.test').send({entryToken:f.entryToken})).status,403);
 assert.equal((await request(app).get('/api/state')).status,401);
 const login=await request(app).post('/api/login').send({entryToken:f.entryToken,studentRef:f.studentRef,classCode:'FIXTURE 67'});assert.equal(login.status,200);
 const start=await request(app).post('/api/begin').set('Authorization',`Bearer ${login.body.token}`).send({operationId:uuid(),owner:'browser'});assert.equal(start.status,200);assert.equal(start.body.key,undefined);assert.equal(start.body.explanations,undefined);
 const a=start.body.attempts.at(-1);assert.equal((await request(app).get(`/api/result/${a.id}`).set('Authorization',`Bearer ${login.body.token}`)).status,404);
 const done=await request(app).post('/api/submit').set('Authorization',`Bearer ${login.body.token}`).send({operationId:uuid(),attemptId:a.id,lease:start.body.lease,snapshot:f.draft(),method:'manual'});assert.equal(done.status,200);
 const submissionId=done.body.attempts.at(-1).submissionId;
 const teacher=await request(app).post('/api/teacher/login').send({credential:'valid-google-fixture'});assert.equal(teacher.status,200);
 const read=await request(app).get(`/api/teacher/result/${submissionId}`).set('Authorization',`Bearer ${teacher.body.token}`);assert.equal(read.status,200);assert.deepEqual(read.body.key,f.content.key);
 f.setTeacher(false);assert.equal((await request(app).get(`/api/teacher/result/${submissionId}`).set('Authorization',`Bearer ${teacher.body.token}`)).status,403);
 assert.equal((await request(app).post('/api/begin').set('Authorization',`Bearer ${teacher.body.token}`).send({operationId:uuid(),owner:'browser'})).status,401);
});

test('HTTP: token Google sai đối tượng hoặc chữ ký bị từ chối, lỗi kết nối không giả thành đăng nhập sai',async()=>{
 let writes=0;
 const app=createApp({pool:{query:async()=>{writes++;}},service:{},origins:[],googleClientId:'fixture',adminKey:secret(),verifyGoogle:async credential=>{
  if(credential==='wrong-audience-fixture')throw new Error('Wrong recipient, payload audience != requiredAudience');
  if(credential==='invalid-signature-fixture')throw new Error('Invalid token signature: private-token-must-not-be-returned');
  throw new Error('Google certificate endpoint unavailable');
 }});
 for(const credential of ['wrong-audience-fixture','invalid-signature-fixture']){
  const response=await request(app).post('/api/teacher/login').send({credential});
  assert.equal(response.status,401);assert.equal(response.body.error.code,'GOOGLE_IDENTITY_INVALID');
  assert.equal(JSON.stringify(response.body).includes('private-token'),false);
 }
 assert.equal((await request(app).post('/api/teacher/login').send({credential:'network-unavailable-fixture'})).status,500);
 assert.equal(writes,0);
});
