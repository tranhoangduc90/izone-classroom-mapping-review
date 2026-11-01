import test from 'node:test';
import assert from 'node:assert/strict';
export function practiceHistoryContract({product,schema,fixture,createApp,request,secret,uuid}){
 const mode='on-demand-v1';
 async function setup(t){
  const f=await fixture();t.after(f.close);f.context.classes=async()=>[{id:'1124',classCode:'FIXTURE 67'}];
  const app=createApp({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'fixture',adminKey:secret(),verifyGoogle:async()=>({email:'teacher@example.test',sub:'google-fixture',email_verified:true})});
  let started=await f.begin();const historical=[];
  for(let n=1;n<=3;n++){
   const snapshot=f.draft();snapshot.sequence=1;snapshot.notes=('Private synthetic historical notes '+n+'. ').repeat(120);snapshot.answers[Object.keys(f.content.key)[0]]='A';
   const id=started.attempts.at(-1).id;
   if(n!==2)await f.service.submit({token:f.token,operationId:uuid(),attemptId:id,lease:started.lease,snapshot,method:'manual'});
   historical.push(id);
   started=await f.service.reset({token:f.token,operationId:uuid(),attemptId:id,owner:'fixture',...(n===2?{lease:started.lease,snapshot}:{})});
   await f.service.activate({token:f.token,attemptId:started.attempts.at(-1).id,lease:started.lease});
  }
  return{...f,app,historical,started};
 }
 const get=(f,path)=>request(f.app).get('/api/'+path).set('Authorization','Bearer '+f.token);
 test(`${product}: opted-in history sends summaries, loads one requested result and preserves all native data`,async t=>{
  const f=await setup(t),before=(await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows,jobs=(await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows;
  const legacy=await get(f,'state'),compact=await get(f,'state').query({history:mode});assert.equal(compact.status,200);assert.equal(compact.body.historyMode,mode);
  assert.equal(compact.body.attempts.length,4);assert.equal(legacy.body.attempts.length,4);assert.equal(legacy.body.historyMode,undefined);
  for(const a of compact.body.attempts.slice(0,-1)){assert.equal(a.detailsLoaded,false);assert.match(a.detailRevision,/^[a-f0-9]{64}$/);assert.equal(a.answeredCount,1);for(const key of ['draft','answers','notes','result','flags','annotations','lease'])assert.equal(a[key],undefined);}
  assert.equal(compact.body.attempts.at(-1).detailsLoaded,true);assert.deepEqual(compact.body.attempts.at(-1).answers,legacy.body.attempts.at(-1).answers);
  assert.ok(JSON.stringify(compact.body).length<JSON.stringify(legacy.body).length/3);
  const selected=await get(f,'result/'+f.historical[0]).query({history:mode});assert.equal(selected.status,200);assert.equal(selected.body.attempt.id,f.historical[0]);assert.equal(selected.body.attempt.detailsLoaded,true);assert.ok(selected.body.attempt.notes.includes('historical notes 1'));
  assert.deepEqual(selected.body.key,f.content.key);
  assert.equal(selected.body.attempts[1].detailsLoaded,false);assert.equal(selected.body.attempts.at(-1).detailsLoaded,true);
  assert.deepEqual(compact.body.events,legacy.body.events);assert.equal(compact.body.firstCompleted,legacy.body.firstCompleted);
  assert.deepEqual((await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows,before);assert.deepEqual((await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows,jobs);
  assert.equal((await request(f.app).get('/api/state').query({history:mode})).status,401);
  f.setEligible(false);assert.equal((await get(f,'state').query({history:mode})).status,403);
 });
 test(`${product}: history projection is optional on mutations, validates before saving, and keeps lease/timing/replay`,async t=>{
  const f=await setup(t),a=f.started.attempts.at(-1),snapshot=f.draft();snapshot.sequence=1;snapshot.notes='Current draft remains complete';snapshot.answers[Object.keys(f.content.key)[0]]='A';
  const input={attemptId:a.id,lease:f.started.lease,snapshot},post=path=>request(f.app).post('/api/'+path).set('Authorization','Bearer '+f.token).send(input);
  const before=await f.service.read({token:f.token});assert.equal((await post('pulse?history=invalid')).status,400);assert.deepEqual(await f.service.read({token:f.token}),before);
  const compact=await post('pulse?history='+mode);assert.equal(compact.status,200);assert.equal(compact.body.historyMode,mode);assert.equal(compact.body.attempts.at(-1).notes,snapshot.notes);
  const receipt=await post('pulse?ack=compact-v1&history='+mode);assert.equal(receipt.status,200);assert.equal(receipt.body.ack,'practice-pulse-v1');assert.equal(receipt.body.attempts,undefined);
  const resumed=await request(f.app).post('/api/resume?history='+mode).set('Authorization','Bearer '+f.token).send({operationId:uuid(),attemptId:a.id,owner:'next-fixture'});
  assert.equal(resumed.status,200);assert.equal(resumed.body.attempts.at(-1).notes,snapshot.notes);assert.ok(resumed.body.lease.token);assert.equal(resumed.body.attempts[0].detailsLoaded,false);
 });
 test(`${product}: teacher history fetch remains scoped and can request an older draft without changing work`,async t=>{
  const f=await setup(t),login=await request(f.app).post('/api/teacher/login').send({credential:'synthetic-google-credential'});assert.equal(login.status,200);
  const read=query=>request(f.app).get('/api/teacher/progress/units/'+f.registered.bindingId).set('Authorization','Bearer '+login.body.token).query(query);
  const before=(await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows;
  const legacy=await read({}),latest=await read({history:mode});assert.equal(latest.status,200);assert.equal(latest.body.attempts[0].detailsLoaded,false);assert.equal(latest.body.attempts.at(-1).detailsLoaded,true);
  const old=await read({history:mode,attemptId:f.historical[1]});assert.equal(old.status,200);assert.equal(old.body.attempts[1].detailsLoaded,true);assert.equal(old.body.attempts[1].status,'reset');assert.equal(old.body.attempts[1].notes,legacy.body.attempts[1].notes);
  assert.equal((await read({history:mode,attemptId:uuid()})).status,404);assert.deepEqual((await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows,before);
  f.setTeacher(false);assert.equal((await read({history:mode,attemptId:f.historical[1]})).status,403);
 });
}
