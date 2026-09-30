import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
// Kiểm app thực của image với database giả: không xác thực người thật hoặc ghi Portal.
const calls=[];const now=Date.now();const origin='https://tranhoangduc90.github.io';
const profile={email:'teacher@example.invalid',display_name:'Giảng viên thử',role:'teacher',can_access_all_classes:false};
const pool={async query(sql,params=[]){calls.push({sql,params});
  if(sql.includes('UPDATE mapping.reviewer_account'))return {rowCount:1,rows:[profile]};
  if(sql.includes('INSERT INTO mapping.reviewer_session')||sql.includes('UPDATE mapping.reviewer_session AS session'))
    return {rowCount:1,rows:[{...profile,idle_expires_at:new Date(now+90*86400000),absolute_expires_at:new Date(now+365*86400000)}]};
  return {rowCount:1,rows:[]};}};
const app=createApp({config:{nodeEnv:'production',authMode:'google',googleClientId:'fixture-client',allowedOrigins:new Set([origin]),trustProxyHops:0,
  teacherSessionIdleDays:90,teacherSessionAbsoluteDays:365,teacherSessionCookieName:'izone_teacher_session',teacherSessionCookiePath:'/mapping-api',
  teacherSessionCookieSecure:true,teacherSessionCookieSameSite:'None',teacherSessionCookiePartitioned:true},pool,
  verifyGoogleToken:async()=>({email:profile.email,sub:'fixture-only',email_verified:true,name:profile.display_name})});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port;
try {
  const login=await fetch(base+'/api/auth/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({credential:'fixture-credential-for-isolated-test-only'})});
  assert.equal(login.status,201);const cookie=login.headers.get('set-cookie');
  for(const flag of ['HttpOnly','Secure','SameSite=None','Partitioned','Path=/mapping-api'])assert(cookie.includes(flag));
  const maxAge=Number(cookie.match(/Max-Age=(\d+)/)?.[1]);assert(maxAge>=89*86400&&maxAge<=90*86400);
  assert.deepEqual(calls.find(x=>x.sql.includes('INSERT INTO mapping.reviewer_session')).params.slice(-2),[90,365]);
  const headers={Origin:origin,Cookie:cookie.split(';',1)[0]};
  const restore=await fetch(base+'/api/auth/session',{headers});assert.equal(restore.status,200);
  assert.equal(restore.headers.get('access-control-allow-origin'),origin);
  const renewal=calls.find(x=>x.sql.includes('UPDATE mapping.reviewer_session AS session'));assert.equal(renewal.params[1],90);assert.match(renewal.sql,/LEAST\(session\.absolute_expires_at/);
  const logout=await fetch(base+'/api/auth/session',{method:'DELETE',headers:{...headers,'x-izone-csrf':'1'}});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert(calls.some(x=>x.sql.includes("revoked_reason = COALESCE(revoked_reason, 'logout')")));
  process.stdout.write(JSON.stringify({ok:true,cookieDays:90,absoluteDays:365,restore:true,logout:true,cors:true,environment:'candidate image, isolated fake DB'})+'\n');
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
