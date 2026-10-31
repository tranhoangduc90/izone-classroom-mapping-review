import test from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';
import {fixture} from './helpers.js';import {createApp} from '../src/app.js';import {CODE,secret} from '../src/domain.js';
test('Buổi 8 cũ giữ entry fragment và phiên, không ép đổi sang catalog bài mới',async t=>{
 const f=await fixture();t.after(f.close);f.context.classes=async()=>[{id:'1124',classCode:'FIXTURE 67'}];
 const proof={code:CODE,documentId:f.registration.documentId,tabId:'t.0',courseId:'1',courseWorkId:'2',submissionId:'3',googleUserId:'4',verifiedAt:new Date().toISOString()};
 await f.pool.query('UPDATE listening_practice.binding SET owner_proof=$2 WHERE id=$1',[f.registered.bindingId,proof]);
 const app=createApp({pool:f.pool,service:f.service,origins:[],adminKey:secret()});
 const entry=await request(app).get('/api/entry-context').query({documentId:proof.documentId,code:CODE});assert.equal(entry.status,200);assert.equal(entry.body.lesson,null);
 const state=await request(app).get('/api/state').set({'X-Izone-Document':proof.documentId,'X-Izone-Assignment':CODE,Authorization:'Bearer '+f.token});assert.equal(state.status,200);assert.deepEqual(state.body.attempts,[]);
 assert.equal((await request(app).post('/api/login').set({'X-Izone-Document':proof.documentId,'X-Izone-Assignment':CODE}).send({entryToken:f.entryToken,studentRef:f.studentRef,classCode:'FIXTURE 67'})).status,200);
});
