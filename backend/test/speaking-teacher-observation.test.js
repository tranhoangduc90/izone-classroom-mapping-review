import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {createAuthService} from '../src/auth.js';
import {createSpeakingHomeworkRouter} from '../src/speaking-homework-routes.js';
import {createIndependentSourceClient} from '../src/speaking-independent-server.js';
import {fixture,seedHundred,actor,key,cookie,token} from './auth-observation-fixture.mjs';
const secret='fixture-observation-worker-secret-at-least-32',pages='https://tranhoangduc90.github.io';
async function serverFixture({observer=true}={}){
 const f=await fixture();let authentications=0,googleVerifications=0;
 const requests=[],auth=createAuthService({config:f.config,pool:f.authPool,verifyGoogleToken:async()=>{
  googleVerifications++;return{email:'teacher1@fixture.test',sub:'subject-1',email_verified:true};
 }});
 const app=express();app.use(express.json({limit:'2mb'}));
 app.use((req,res,next)=>{requests.push({path:req.url,query:req.query,cookie:req.get('cookie')});next();});
 app.use('/source',createSpeakingHomeworkRouter({pool:f.pool,workerSecret:secret,accessSecret:secret,
  authenticate:(req,res,next)=>{authentications++;return auth.authenticate(req,res,next);},
  ...(observer?{observeTeacherAccess:auth.observeTeacherAccess}:{})}));
 app.use((error,_req,res,_next)=>res.status(error.httpStatus||error.status||503).json({ok:false,error:error.code||'SOURCE_UNAVAILABLE'}));
 const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}/source`;
 return{...f,requests,base,source:createIndependentSourceClient({base,secret}),authentications:()=>authentications,
  googleVerifications:()=>googleVerifications,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}};
}
test('Speaking teacher observation HTTP:100 distinct accounts, three snapshots, one SQL each and no native-auth writes',async()=>{
 const f=await serverFixture();try{
  const actors=await seedHundred(f),before=(await f.db.query('SELECT * FROM mapping.reviewer_session ORDER BY reviewer_email')).rows;
  for(let scan=0;scan<3;scan++){
   const results=await f.source.observeTeachers([...actors].reverse());assert.equal(results.size,100);
   for(let n=0;n<100;n++)assert.deepEqual(results.get(key(n+1000)).allowedClassIds,n%2===0?['2304']:['2305']);
  }
  assert.equal(f.authCalls.length,3);assert.ok(f.authCalls.every(sql=>sql.startsWith('WITH ')));assert.equal(f.calls.length,0);
  assert.equal(f.authentications(),0);assert.equal(f.googleVerifications(),0);
  assert.deepEqual((await f.db.query('SELECT * FROM mapping.reviewer_session ORDER BY reviewer_email')).rows,before);
  assert.ok(f.requests.every(row=>row.path==='/source/internal/independent/teacher-observation'&&row.cookie===undefined&&Object.keys(row.query).length===0));
 }finally{await f.close();}
});
test('Speaking teacher observation HTTP: native admission still renews session; Bearer and old source remain explicit fallbacks',async()=>{
 const f=await serverFixture();try{
  const admission=await f.source.teacherAdmission(['2304','2305'],{cookie:cookie(1),origin:pages});
  assert.equal(admission.authSource,'session');assert.equal(admission.reviewer.email,'teacher1@fixture.test');assert.deepEqual([...admission.allowed],['2304']);
  const row=(await f.db.query("SELECT idle_expires_at,last_seen_at FROM mapping.reviewer_session WHERE reviewer_email='teacher1@fixture.test'")).rows[0];
  assert.ok(new Date(row.idle_expires_at).getTime()>Date.now()+89*86400000);assert.ok(new Date(row.last_seen_at).getTime()>Date.now()-60000);
  assert.equal((await f.source.observeTeachers([actor(1)])).get(key(1)).ok,true);
  const bearer=await f.source.teacherAdmission(['2304'],{cookie:cookie(6),authorization:'Bearer fixture-google-token',origin:pages});
  assert.equal(bearer.authSource,'google_bearer');assert.equal(bearer.reviewer.email,'teacher1@fixture.test');assert.equal(f.googleVerifications(),1);
  const result=await f.source.observeTeachers([actor(6),{...actor(2),cookie:''}]);
  assert.equal(result.get(key(6)).status,401);assert.equal(result.get(key(2)).status,409);
  assert.equal(result.get(key(2)).error,'STATE_AUTH_COOKIE_REQUIRED');
  let network=0;const old=createIndependentSourceClient({base:f.base,secret,call:async()=>{
   network++;return Response.json({ok:false,error:'NOT_FOUND'},{status:404});
  }});
  await assert.rejects(old.observeTeachers([actor(1)]),error=>error.httpStatus===404);assert.equal(network,1);
  assert.deepEqual([...await f.source.teachers([])],[]);
 }finally{await f.close();}
});
test('Speaking teacher observation HTTP: worker guard, bounded input, live revocation and unavailable callback fail closed',async()=>{
 const f=await serverFixture();try{
  const bad=createIndependentSourceClient({base:f.base,secret:'wrong-secret-at-least-32-characters'});
  await assert.rejects(bad.observeTeachers([actor(1)]),error=>error.httpStatus===401);assert.equal(f.calls.length,0);
  await assert.rejects(f.source.observeTeachers([{...actor(1),authorization:'forbidden'}]),{code:'AUTH_OBSERVATION_INPUT_INVALID'});
  assert.equal(f.calls.length,0);
  const before=f.requests.length;assert.deepEqual([...await f.source.observeTeachers([])],[]);assert.equal(f.requests.length,before);
  const direct=await fetch(f.base+'/internal/independent/teacher-observation',{method:'POST',headers:{'content-type':'application/json','x-speaking-worker-secret':secret},
   body:JSON.stringify({actors:[{...actor(1),accessToken:token(1)}]})});assert.equal(direct.status,400);assert.equal(f.calls.length,0);
  const result=await f.source.observeTeachers([actor(1),actor(5),actor(8)]);
  assert.equal(result.get(key(1)).ok,true);assert.equal(result.get(key(5)).status,401);assert.equal(result.get(key(8)).status,401);
  await f.db.query("DELETE FROM mapping.reviewer_class_access WHERE reviewer_email='teacher1@fixture.test'");
  assert.deepEqual((await f.source.observeTeachers([actor(1)])).get(key(1)).allowedClassIds,[]);
  await f.db.query("UPDATE mapping.reviewer_session SET revoked_at=now() WHERE reviewer_email='teacher1@fixture.test'");
  assert.equal((await f.source.observeTeachers([actor(1)])).get(key(1)).status,401);assert.equal(f.authentications(),0);
 }finally{await f.close();}
 const old=await serverFixture({observer:false});try{
  await assert.rejects(old.source.observeTeachers([actor(1)]),error=>error.httpStatus===409&&error.code==='STATE_AUTH_OBSERVER_UNAVAILABLE');
  assert.equal(old.calls.length,0);assert.equal(old.authentications(),0);
 }finally{await old.close();}
});

test('Speaking teacher observation shared app: actual mount and error middleware preserve readonly batch and input400',async()=>{
 const f=await fixture();let server;
 try{
  const {createApp}=await import('../src/app.js');
  const app=createApp({config:{...f.config,trustProxyHops:0,speakingHomeworkEnabled:true,
   speakingHomeworkWorkerSecret:secret,speakingHomeworkAccessSecret:secret},pool:f.authPool,speakingHomeworkPool:f.pool,
   verifyGoogleToken:async()=>{throw Error('NO_GOOGLE_EXPECTED');}});
  server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/speaking-homework`,source=createIndependentSourceClient({base,secret});
  assert.equal((await source.observeTeachers([actor(1)])).get(key(1)).ok,true);
  assert.equal(f.authCalls.length,1);assert.ok(f.authCalls[0].startsWith('WITH '));assert.equal(f.calls.length,0);
  const bad=await fetch(base+'/internal/independent/teacher-observation',{method:'POST',headers:{'content-type':'application/json','x-speaking-worker-secret':secret},
   body:JSON.stringify({actors:[{...actor(1),accessToken:token(1)}]})});
  assert.equal(bad.status,400);assert.equal((await bad.json()).error,'AUTH_OBSERVATION_INPUT_INVALID');
  assert.equal(f.authCalls.length,1);
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.close();}
});
