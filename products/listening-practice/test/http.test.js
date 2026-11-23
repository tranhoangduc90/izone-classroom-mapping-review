import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';

test('HTTP: Safari bounce in an existing draft keeps the same attempt and its answers on resume',async t=>{
 const f=await fixture();t.after(f.close);
 const app=createApp({pool:f.pool,service:f.service,origins:['https://page.test']});
 const post=(action,body)=>request(app).post(`/api/${action}`).set('Authorization',`Bearer ${f.token}`).send(body);
 const start=await f.begin(),attemptId=start.attempts.at(-1).id;
 const snapshot={...f.draft(),sequence:1,audioPosition:4,activeMs:4000,answers:{21:'A'},flags:[21],notes:'Fixture note',
  scroll:{passage:-18.5,questions:{all:-6.75,'other-pane':21.25}}};
 f.advance(4000);
 const saved=await post('pulse',{attemptId,lease:start.lease,snapshot});
 assert.equal(saved.status,200,saved.body.error?.code);
 f.advance(300000);
 const newer={...snapshot,sequence:2,answers:{...snapshot.answers,22:'B'},notes:'Newer fixture note'};
 const resumed=await post('resume',{attemptId,owner:'browser',operationId:uuid(),recovery:{snapshot:newer,lease:start.lease}});
 assert.equal(resumed.status,200,resumed.body.error?.code);
 assert.notEqual(resumed.body.lease.id,start.lease.id);
 const activated=await post('activate',{attemptId,lease:resumed.body.lease});
 assert.equal(activated.status,200,activated.body.error?.code);
 const state=await request(app).get('/api/state').set('Authorization',`Bearer ${f.token}`);
 assert.equal(state.status,200);
 assert.equal(state.body.attempts.length,1);
 const attempt=state.body.attempts[0];
 assert.equal(attempt.id,attemptId);
 assert.equal(attempt.status,'running');
 assert.equal(attempt.remainingMs,start.attempts[0].remainingMs-4000);
 assert.deepEqual(attempt.answers,newer.answers);
 assert.deepEqual(attempt.flags,newer.flags);
 assert.equal(attempt.notes,newer.notes);
 assert.deepEqual(attempt.scroll,{passage:0,questions:{all:0,'other-pane':21.25}});
});

test('HTTP: chỉ chủ Docs mở bài, không rò key trước nộp, teacher không có quyền không xem',async t=>{
 const f=await fixture();t.after(f.close);
 const adminKey=secret(),app=createApp({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'google-client-fixture',adminKey,verifyGoogle:async credential=>({email:credential==='valid-google-fixture'?'teacher@example.test':'other@example.test',sub:'google-fixture',email_verified:true})});
 assert.equal((await request(app).get('/api/admin/status')).status,403);
 assert.equal((await request(app).post('/api/admin/assignment').set('x-listening-admin',adminKey).send({assignmentId:f.registered.assignmentId,status:'open'})).status,409);
 await f.pool.query('UPDATE listening_practice.binding SET owner_proof=$1',[{verifiedAt:new Date().toISOString(),submissionId:'fixture-owned-submission'}]);
 assert.equal((await request(app).post('/api/admin/assignment').set('x-listening-admin',adminKey).send({assignmentId:f.registered.assignmentId,status:'open'})).status,200);
 assert.equal((await request(app).get('/api/admin/status').set('x-listening-admin',adminKey)).body.assignments[0].verified_ctas,1);
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
