import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
import {fixture,token} from './auth-observation-fixture.mjs';
import {request,closeNativeAuthHttp} from '../../products/test-support/native-auth-http.mjs';

const origin='https://tranhoangduc90.github.io',name='migration_teacher',path='/mapping-api';
test.after(closeNativeAuthHttp);
async function setup({partitioned=true}={}){
 const f=await fixture();
 try{
  await f.db.exec('ALTER TABLE mapping.reviewer_session ADD COLUMN revoked_reason text');
  if(process.env.PRACTICE_FIXTURE_DATABASE_URL)await f.db.exec('GRANT INSERT ON mapping.reviewer_session TO teacher_observation_auth; GRANT UPDATE(revoked_at,revoked_reason) ON mapping.reviewer_session TO teacher_observation_auth');
  const app=createApp({config:{...f.config,nodeEnv:'production',googleClientId:'fixture-only-client',trustProxyHops:0,
   allowedOrigins:new Set([origin]),teacherSessionCookieName:name,teacherSessionCookiePath:path,
   teacherSessionCookieSecure:true,teacherSessionCookieSameSite:'None',teacherSessionCookiePartitioned:partitioned,
   teacherSessionIdleDays:90,teacherSessionAbsoluteDays:365},pool:f.authPool,
   verifyGoogleToken:async()=>({email:'teacher1@fixture.test',sub:'subject-1',email_verified:true})});
  return{...f,app};
 }catch(error){await f.close();throw error;}
}
const login=f=>request(f.app).post('/api/auth/session').set('Origin',origin).send({credential:'google-credential-for-isolated-cookie-fixture'});
const active=headers=>headers.find(value=>/Max-Age=[1-9]\d*/.test(value));
const pair=value=>value.split(';',1)[0];

test('Cookie migration: login expires only its legacy name/path before the live cookie, including clients that ignore Partitioned',async()=>{
 const f=await setup();try{
  const response=await login(f);assert.equal(response.status,201);const cookies=response.headers['set-cookie'];
  assert.equal(cookies.length,2);assert.match(cookies[0],new RegExp('^'+name+'=;'));assert.match(cookies[0],/Max-Age=0/);
  assert.equal(cookies[0].includes('Partitioned'),false);assert.equal(cookies.at(-1).includes('Partitioned'),true);
  assert.ok(cookies.every(value=>value.includes('Path='+path+';')&&value.includes('HttpOnly')&&value.includes('Secure')&&value.includes('SameSite=None')));
  // A browser that ignores Partitioned has one cookie slot for this name/path.
  // Apply the response in wire order; its next native request must authenticate.
  let stored=name+'='+'z'.repeat(43);
  for(const value of cookies)stored=/Max-Age=0(?:;|$)/.test(value)?'':pair(value);
  const restored=await request(f.app).get('/api/auth/session').set('Origin',origin).set('Cookie',stored);
  assert.equal(restored.status,200);assert.equal(restored.body.reviewer.email,'teacher1@fixture.test');
  assert.equal(restored.headers['set-cookie'].length,1,'Ordinary requests retain one renewal header');
 }finally{await f.close();}
});

test('Cookie migration: nonpartitioned products retain their single native cookie',async()=>{
 const f=await setup({partitioned:false});try{
  const response=await login(f);assert.equal(response.status,201);const cookies=response.headers['set-cookie'];
  assert.equal(cookies.length,1);assert.equal(cookies[0].includes('Partitioned'),false);
  const restored=await request(f.app).get('/api/auth/session').set('Origin',origin).set('Cookie',pair(cookies[0]));
  assert.equal(restored.status,200);
 }finally{await f.close();}
});

test('Cookie migration: duplicate active cookies migrate only on an allowed origin and keep one native auth update',async()=>{
 const f=await setup();try{
  const duplicate=name+'='+token(1)+'; '+name+'='+token(1);
  const untrusted=await request(f.app).get('/api/auth/session').set('Origin','https://untrusted.fixture.invalid').set('Cookie',duplicate);
  assert.equal(untrusted.status,403);assert.equal(untrusted.headers['set-cookie'],undefined);
  assert.equal(f.authCalls.filter(sql=>sql.includes('UPDATE mapping.reviewer_session AS session')).length,0);
  f.authCalls.length=0;
  const allowed=await request(f.app).get('/api/auth/session').set('Origin',origin).set('Cookie',duplicate);
  assert.equal(allowed.status,200);assert.equal(allowed.headers['set-cookie'].length,2);
  assert.equal(allowed.headers['set-cookie'][0].includes('Partitioned'),false);assert.match(allowed.headers['set-cookie'][0],/Max-Age=0/);
  assert.equal(f.authCalls.filter(sql=>sql.includes('UPDATE mapping.reviewer_session AS session')).length,1);
  assert.equal(pair(active(allowed.headers['set-cookie'])),name+'='+token(1));
 }finally{await f.close();}
});

test('Cookie migration: logout clears both cookie variants and revokes the same authenticated session',async()=>{
 const f=await setup();try{
  const opened=await login(f),cookie=pair(active(opened.headers['set-cookie']));
  const response=await request(f.app).delete('/api/auth/session').set('Origin',origin).set('x-izone-csrf','1').set('Cookie',cookie);
  assert.equal(response.status,200);const cookies=response.headers['set-cookie'];
  assert.equal(cookies.length,2);assert.ok(cookies.every(value=>value.startsWith(name+'=;')&&value.includes('Path='+path+';')&&value.includes('Max-Age=0')));
  assert.equal(cookies.filter(value=>value.includes('Partitioned')).length,1);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM mapping.reviewer_session WHERE revoked_reason='logout' AND revoked_at IS NOT NULL")).rows[0].n,1);
  const restored=await request(f.app).get('/api/auth/session').set('Origin',origin).set('Cookie',cookie);
  assert.equal(restored.status,401);
 }finally{await f.close();}
});
