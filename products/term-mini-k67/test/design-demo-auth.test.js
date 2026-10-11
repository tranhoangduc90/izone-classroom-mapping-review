import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createDemoGoogleAuth } from '../src/design-demo-auth.js';

// Google giả chỉ trong test: tài khoản bất kỳ được vào demo, không cần account/ACL trong DB.
const base='/api/term-tests/teacher/design-demo',origin='https://example.test';
const valid='synthetic-google-credential-only-for-tests';
function fixture(payload={}) {
 const auth=createDemoGoogleAuth({config:{nodeEnv:'production',googleClientId:'test',allowedOrigins:new Set([origin])},
  verifyGoogleToken:async token=>{if(token!==valid)throw Error('invalid');return {email:'outside@example.test',sub:'outside-user',email_verified:true,exp:Math.floor(Date.now()/1000)+3600,...payload};}});
 const app=express();app.use(express.json());app.post(base+'/session',auth.login);
 app.get(base+'/content',auth.authenticate,(req,res)=>res.json({ok:true,proof:auth.readAuthorization(req)}));
 app.delete(base+'/session',auth.authenticate,auth.logout);
 return request(app);
}
test('any verified Google account obtains a demo-only cookie without database/account creation',async()=>{
 const api=fixture();const login=await api.post(base+'/session').set('origin',origin).send({credential:valid});
 assert.equal(login.status,201);const cookie=login.headers['set-cookie'][0];
 assert.match(cookie,/Path=\/term-mini-k67-api\/api\/term-tests\/teacher\/design-demo;/);
 assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/Partitioned/);
 const r=await api.get(base+'/content').set('cookie',cookie.split(';')[0]);
 assert.equal(r.status,200);assert.deepEqual(r.body.proof,{source:'demo_google',googleSubject:'outside-user'});
});
test('invalid, expired or unverified identity cannot open demo',async()=>{
 for(const payload of [{exp:1},{email_verified:false},{sub:''}]) {
  const r=await fixture(payload).post(base+'/session').set('origin',origin).send({credential:valid});assert.equal(r.status,401);
 }
 assert.equal((await fixture().get(base+'/content').set('cookie','izone_k67_demo_google=forged-token-long-enough')).status,401);
 assert.equal((await fixture().get(base+'/content').set('cookie','izone_k67_teacher_session=unrelated')).status,401);
});
test('login origin and cookie mutations require the intended website; logout clears only demo cookie',async()=>{
 const api=fixture();assert.equal((await api.post(base+'/session').set('origin','https://unrelated.test').send({credential:valid})).status,403);
 const cookie='izone_k67_demo_google='+valid;
 assert.equal((await api.delete(base+'/session').set('cookie',cookie).set('origin',origin)).status,403);
 const r=await api.delete(base+'/session').set('cookie',cookie).set('origin',origin).set('x-izone-csrf','1');
 assert.equal(r.status,200);assert.match(r.headers['set-cookie'][0],/izone_k67_demo_google=;/);assert.match(r.headers['set-cookie'][0],/Max-Age=0/);
});
