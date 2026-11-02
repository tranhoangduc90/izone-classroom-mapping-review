import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import express from 'express';
import {createAuthService} from '../src/auth.js';
import {createSpeakingHomeworkRouter} from '../src/speaking-homework-routes.js';
import {createIndependentSourceClient} from '../src/speaking-independent-server.js';

// HTTP và middleware auth thật; facade SQL chỉ cô lập tài khoản của ca kiểm CSRF.
// Quyền SQL/expiry/class scope được kiểm riêng bởi các bộ native tương ứng.
test('Speaking source CSRF: batch quyền giữ cookie/Origin/header native và đường nguồn cũ',async()=>{
 const pages='https://tranhoangduc90.github.io',custom='https://pages.fixture',secret='fixture-worker-secret-at-least32characters';
 const raw='t'.repeat(43),cookie='fixture_teacher='+raw,queries=[],requests=[];let legacyOnly=false;
 const auth=createAuthService({config:{authMode:'google',nodeEnv:'production',googleClientId:'fixture-client',
  teacherSessionCookieName:'fixture_teacher',allowedOrigins:new Set([pages,custom])},
  pool:{async query(sql,params){
   assert.ok(sql.startsWith('UPDATE mapping.reviewer_session'));queries.push('auth');
   if(!params[0].equals(createHash('sha256').update(raw).digest()))return{rows:[],rowCount:0};
   return {rowCount:1,rows:[{email:'teacher@fixture.test',display_name:'Giảng viên giả',role:'reviewer',can_access_all_classes:false,
    idle_expires_at:new Date(Date.now()+90*86400000),absolute_expires_at:new Date(Date.now()+365*86400000)}]};
  }},verifyGoogleToken:async()=>{throw Error('NO_GOOGLE_REQUEST_EXPECTED');}});
 const pool={async query(sql,params){
  assert.ok(sql.includes('mapping.classroom_course_mapping'));queries.push('class');
  const wanted=Array.isArray(params[0])?params[0]:[params[0]];
  return{rows:wanted.includes('2304')?[{class_id:'2304'}]:[]};
 }};
 const app=express();app.use(express.json());app.use((req,res,next)=>{
  requests.push({method:req.method,path:req.path,cookie:req.get('cookie'),origin:req.get('origin'),csrf:req.get('x-izone-csrf')});
  if(legacyOnly&&req.method==='POST'&&req.path==='/speaking/internal/independent/teacher-access')return res.status(404).json({ok:false,error:'NOT_FOUND'});
  next();
 });
 app.use('/speaking',createSpeakingHomeworkRouter({pool,workerSecret:secret,accessSecret:secret,authenticate:auth.authenticate}));
 app.use((error,_req,res,_next)=>res.status(error.httpStatus||503).json({ok:false,error:error.code||'UNEXPECTED_ERROR'}));
 const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}/speaking`;
 try{
  const source=createIndependentSourceClient({base,secret});
  assert.deepEqual([...(await source.teachers(['2304','2305'],{cookie,origin:pages}))],['2304']);
  assert.equal(requests[0].csrf,'1');assert.equal(requests[0].origin,pages);assert.equal(requests[0].cookie,cookie);
  assert.deepEqual(queries,['auth','class']);
  assert.deepEqual([...(await source.teachers(['2304'],{cookie}))],['2304']);
  assert.equal(requests.at(-1).origin,pages);
  const configured=createIndependentSourceClient({base,secret,teacherOrigin:custom});
  assert.deepEqual([...(await configured.teachers(['2304'],{cookie}))],['2304']);assert.equal(requests.at(-1).origin,custom);
  let before=requests.length,classes=queries.filter(query=>query==='class').length;
  await assert.rejects(source.teachers(['2304'],{cookie,origin:'https://wrong.fixture'}),error=>error.code==='CSRF_REJECTED'&&error.httpStatus===403);
  assert.equal(requests.length,before+1);assert.equal(queries.filter(query=>query==='class').length,classes);
  const wrong=createIndependentSourceClient({base,secret:'wrong-worker-secret-at-least32characters'});
  before=queries.length;
  await assert.rejects(wrong.teachers(['2304'],{cookie,origin:pages}),error=>error.httpStatus===401);assert.equal(queries.length,before);
  legacyOnly=true;before=requests.length;
  assert.deepEqual([...(await source.teachers(['2304','2305'],{cookie}))],['2304']);
  assert.equal(requests.length,before+3);assert.equal(requests.at(-1).method,'GET');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
