import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import {createContextSourceApp} from '../src/context-source.js';
const secret='s'.repeat(32),rows=[{classId:'202',classCode:'NEW',courseId:'classroom-new'}];
test('class metadata is authenticated before DB access; no public roster data',async()=>{
 let calls=0;const app=createContextSourceApp({secret,pool:{query:async sql=>{calls++;assert.match(sql,/homework_class_scope/);return {rows};}}});
 await request(app).get('/v1/homework/class-scope').expect(401);assert.equal(calls,0);
 const r=await request(app).get('/v1/homework/class-scope').set('x-k67-context-key',secret).expect(200);assert.equal(r.headers['cache-control'],'no-store');
 const {capturedAt,sourceRevision,...payload}=r.body;assert.deepEqual(payload,{apiVersion:1,erpCourseId:'5',classes:rows});assert.ok(Number.isFinite(Date.parse(capturedAt)));assert.equal(sourceRevision,crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
});
test('class source failure is 503, never an empty successful scope',async()=>{
 const app=createContextSourceApp({secret,pool:{query:async()=>{throw Error('private database detail');}}});const r=await request(app).get('/v1/homework/class-scope').set('x-k67-context-key',secret).expect(503);assert.deepEqual(r.body,{ok:false,error:'HOMEWORK_CLASS_SCOPE_UNAVAILABLE'});
});
