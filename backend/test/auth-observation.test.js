import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthService,createTeacherAccessObserver} from '../src/auth.js';
import {fixture,seedHundred,key,token,cookie,actor} from './auth-observation-fixture.mjs';

test('Auth observation:100 actor descriptors share one SELECT, native role/class and admin rules retained',async()=>{
 const f=await fixture();try{
  const inputs=Array.from({length:100},(_,n)=>({...actor(n%4+1),key:key(100+n)}));
  const result=await f.observe(inputs);assert.equal(f.calls.length,1);assert.equal(result.size,100);assert.ok(f.calls[0].startsWith('WITH '));
  for(let n=0;n<100;n++){
   const entry=result.get(key(100+n));assert.equal(entry.ok,true);assert.equal(entry.googleSubject,'subject-'+(n%4+1));
   assert.deepEqual(entry.allowedClassIds,n%4===0?['2304']:n%4===1?['2305']:['2304','2305','unlinked']);
  }
  assert.equal(JSON.stringify([...result.values()]).includes(token(1)),false);
 }finally{await f.close();}
});

test('Auth observation: same reviewer as native cookie auth without touching idle or last_seen',async()=>{
 const f=await fixture();try{
  const auth=createAuthService({config:f.config,pool:f.authPool,verifyGoogleToken:async()=>{throw Error('NO_GOOGLE_EXPECTED');}});
  const reviewer=await auth.revalidate({get:name=>name==='cookie'?cookie(1):''});
  const before=(await f.db.query('SELECT * FROM mapping.reviewer_session ORDER BY reviewer_email')).rows;f.calls.length=0;
  for(let n=0;n<3;n++){const result=await f.observe([actor(1)]);assert.deepEqual(result.get(key(1)).reviewer,reviewer);}
  const after=(await f.db.query('SELECT * FROM mapping.reviewer_session ORDER BY reviewer_email')).rows;
  assert.deepEqual(after,before);assert.ok(f.calls.every(sql=>sql.startsWith('WITH ')));
 }finally{await f.close();}
});

test('Auth observation:100 distinct sessions/accounts with identical names keep scope in one readonly statement',async()=>{
 const f=await fixture();try{
  const inputs=await seedHundred(f),before=(await f.db.query('SELECT * FROM mapping.reviewer_session ORDER BY reviewer_email')).rows;
  const results=await f.observe(inputs);assert.equal(f.calls.length,1);assert.equal(results.size,100);
  assert.equal(new Set([...results.values()].map(row=>row.sessionHash)).size,100);
  for(let n=0;n<100;n++){
   const row=results.get(key(n+1000));assert.equal(row.reviewer.email,'teacher'+(n+1000)+'@fixture.test');
   assert.deepEqual(row.allowedClassIds,n%2===0?['2304']:['2305']);
  }
  assert.deepEqual((await f.db.query('SELECT * FROM mapping.reviewer_session ORDER BY reviewer_email')).rows,before);
  if(process.env.PRACTICE_FIXTURE_DATABASE_URL)await assert.rejects(f.reader.query('UPDATE mapping.reviewer_session SET last_seen_at=now()'),{code:'42501'});
  console.log(JSON.stringify({event:'teacher_observation_shape',distinctSessions:100,distinctAccounts:100,sqlStatements:1,
   sessionRowsUnchanged:true,engine:process.env.PRACTICE_FIXTURE_DATABASE_URL?'postgresql':'pglite'}));
 }finally{await f.close();}
});

test('Auth observation: expired/revoked/inactive/subject mismatch denied per actor; no stale rights after revoke',async()=>{
 const f=await fixture();try{
  const result=await f.observe(Array.from({length:9},(_,n)=>actor(n+1)));
  for(let n=5;n<=9;n++){assert.equal(result.get(key(n)).ok,false);assert.equal(result.get(key(n)).status,401);}
  assert.equal(result.get(key(1)).ok,true);
  await f.db.query("DELETE FROM mapping.reviewer_class_access WHERE reviewer_email='teacher1@fixture.test'");
  assert.deepEqual((await f.observe([actor(1)])).get(key(1)).allowedClassIds,[]);
  await f.db.query("UPDATE mapping.reviewer_account SET google_subject='changed' WHERE email='teacher1@fixture.test'");
  assert.equal((await f.observe([actor(1)])).get(key(1)).status,401);
 }finally{await f.close();}
});

test('Auth observation: cookie config/decoding and unsupported Bearer mode keep explicit fallback result',async()=>{
 const f=await fixture();try{
  const result=await f.observe([{...actor(1),cookie:'other_cookie='+token(1)},
   {...actor(2),cookie:'observe_teacher=%'}, {...actor(3),cookie:'observe_teacher='+encodeURIComponent(token(3))}]);
  assert.equal(result.get(key(1)).error,'STATE_AUTH_COOKIE_REQUIRED');assert.equal(result.get(key(1)).status,409);
  assert.equal(result.get(key(2)).status,409);assert.equal(result.get(key(3)).ok,true);
  f.calls.length=0;
  const legacy=createTeacherAccessObserver({config:{...f.config,authMode:'legacy'},pool:f.pool});
  assert.equal((await legacy([actor(1)])).get(key(1)).error,'STATE_AUTH_MODE_UNSUPPORTED');assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('Auth observation: native class cardinality and empty scope; transient SQL is never fake unauthorized',async()=>{
 const f=await fixture();try{
  await f.db.exec("INSERT INTO mapping.classroom_course_mapping VALUES(2304,'OTHER')");
  assert.deepEqual((await f.observe([actor(1)])).get(key(1)).allowedClassIds,[]);
  assert.deepEqual((await f.observe([actor(3)])).get(key(3)).allowedClassIds,['2304','2305','unlinked']);
  assert.deepEqual((await f.observe([actor(1,[])])).get(key(1)).allowedClassIds,[]);
  const broken=createTeacherAccessObserver({config:f.config,pool:{query:async()=>{throw Error('OBSERVER_SQL_FAILED');}}});
  await assert.rejects(broken([actor(1)]),/OBSERVER_SQL_FAILED/);
 }finally{await f.close();}
});

test('Auth observation: invalid/duplicate/cross actor input rejected before SQL, no token in query parameters',async()=>{
 let calls=0;const observe=createTeacherAccessObserver({config:{authMode:'google'},pool:{query(){calls++;throw Error('NO_SQL');}}});
 for(const input of [[actor(1),{...actor(2),key:key(1)}],[{...actor(1),classIds:['2304 OR true']}],
  [{...actor(1),classIds:['9223372036854775808']}],[{...actor(1),accessToken:'forbidden'}],
  Array.from({length:1001},(_,n)=>({...actor(1),key:key(100+n)}))])await assert.rejects(observe(input),{code:'AUTH_OBSERVATION_INPUT_INVALID'});
 assert.deepEqual([...await observe([])],[]);assert.equal(calls,0);
 const query=createTeacherAccessObserver({config:{authMode:'google'},pool:{query:async(_sql,params)=>{
  assert.equal(params[0].includes(token(1)),false);return{rows:[]};
 }}});
 assert.equal((await query([{...actor(1),cookie:'izone_teacher_session='+token(1)}])).get(key(1)).status,401);
});
