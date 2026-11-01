import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex'),identity={email:'teacher@example.test',google_subject:'google-fixture'};
const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('STUDENT_OBSERVATION_TIMEOUT');};
export function practiceStudentObservationContract({product,schema,fixture,createApp,request,createHub,uuid,secret,fail}){
 async function setup(t,enabled=true){
  const f=await fixture(),observers=[];let app;t.after(async()=>{for(const hub of observers)await hub.close();await app?.locals.practiceObservation?.close();await f.close();});
  f.context.classes=async()=>[{id:'1124',classCode:'FIXTURE 67'}];
  const started=await f.begin(),attemptId=started.attempts.at(-1).id,snapshot=f.draft();snapshot.sequence=1;snapshot.notes='Private synthetic result notes';snapshot.answers[Object.keys(f.content.key)[0]]='A';
  await f.service.submit({token:f.token,operationId:uuid(),attemptId,lease:started.lease,snapshot,method:'manual'});
  app=createApp({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'fixture',adminKey:secret(),stateStreamEnabled:enabled,verifyGoogle:async()=>({email:identity.email,sub:identity.google_subject,email_verified:true})});
  return{...f,app,observers,attemptId};
 }
 const get=(f,attemptId=f.attemptId)=>request(f.app).get('/api/student-progress/status').set('Authorization','Bearer '+f.token).query({attemptId});
 test(`${product}: student metadata is authenticated, scoped, read-only and capability-gated`,async t=>{
  const f=await setup(t),before=(await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows,jobs=(await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows;
  const full=await request(f.app).get('/api/state').set('Authorization','Bearer '+f.token);assert.equal(full.body.capabilities.studentStateStream,true);assert.equal(full.body.capabilities.studentStateIntervalMs,30000);
  const result=await get(f);assert.equal(result.status,200);assert.match(result.headers['cache-control'],/no-store/);assert.equal(result.body.kind,'practice-student-state-v1');assert.equal(result.body.attemptId,f.attemptId);assert.equal(result.body.bindingId,f.registered.bindingId);assert.equal(result.body.studentRef,f.studentRef);assert.match(result.body.resultRevision,/^[a-f0-9]{32}$/);
  assert.deepEqual(result.body.events,full.body.events);for(const key of ['answers','notes','definition','key','explanations','attempts','result','sessions'])assert.equal(result.body[key],undefined);assert.equal(JSON.stringify(result.body).includes(f.token),false);
  assert.equal((await request(f.app).get('/api/student-progress/status').query({attemptId:f.attemptId})).status,401);
  assert.equal((await get(f).set('Authorization','Bearer '+secret())).status,401);assert.equal((await get(f,uuid())).status,404);assert.equal((await get(f).query({token:f.token})).status,400);
  const original=f.service.guardEntry;let checked=0;f.service.guardEntry=async input=>{checked++;assert.equal(input.documentId,'denied_fixture_document_123456');assert.equal(input.token,f.token);fail('ENTRY_OWNER_MISMATCH','Synthetic native guard rejection',403);};
  assert.equal((await get(f).set('X-Izone-Document','denied_fixture_document_123456').set('X-Izone-Assignment',f.content.code)).status,403);assert.equal(checked,1);f.service.guardEntry=original;
  assert.deepEqual((await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows,before);assert.deepEqual((await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows,jobs);
  const reset=await f.service.reset({token:f.token,operationId:uuid(),attemptId:f.attemptId,owner:'next-fixture'}),latest=reset.attempts.at(-1);
  assert.equal((await get(f,latest.id)).status,404);const oldResult=await get(f);assert.equal(oldResult.status,200);assert.equal(oldResult.body.latestAttemptId,latest.id);assert.equal(oldResult.body.resultRevision,result.body.resultRevision);
  const old=await setup(t,false);const legacy=await request(old.app).get('/api/state').set('Authorization','Bearer '+old.token);assert.equal(legacy.body.capabilities.studentStateStream,undefined);assert.equal((await get(old)).status,404);
 });
 test(`${product}: thirty mixed teacher/student watchers share two reads; Docs changes do not reload teacher content or result revisions`,async t=>{
  const f=await setup(t),login=await request(f.app).post('/api/teacher/login').send({credential:'synthetic-google-credential'}),scopes=[];
  assert.equal(f.service.observation.read,f.service.teacherProgress.readObservations);
  for(let n=0;n<30;n++)scopes.push(n<15?await f.service.teacherProgress.observation({classId:'1124',code:f.content.code,unitId:f.registered.bindingId},{...identity,value:login.body.token}):await f.service.observation.studentGuard({token:f.token,attemptId:f.attemptId}));
  const query=f.pool.query.bind(f.pool);let queries=0;f.pool.query=(...args)=>{queries++;return query(...args);};
  const hub=createHub({read:f.service.observation.read,interval:30000}),frames=Array.from({length:30},()=>[]),handles=[];f.observers.push(hub);
  for(let n=0;n<30;n++)handles.push(hub.subscribe({...scopes[n],send:(event,value)=>frames[n].push({event,value})}));
  await until(()=>frames.every(rows=>rows.length===1));assert.equal(queries,2);const revision=frames[15][0].value.resultRevision;
  await f.pool.query(`UPDATE ${schema}.doc_job SET status='verified'`);queries=0;hub.wake();await until(()=>frames.slice(15).every(rows=>rows.length===2));assert.equal(queries,2);assert.ok(frames.slice(0,15).every(rows=>rows.length===1));assert.ok(frames.slice(15).every(rows=>rows.at(-1).value.events.every(event=>event.docs==='verified')&&rows.at(-1).value.resultRevision===revision));
  await f.pool.query(`UPDATE ${schema}.work SET state=jsonb_set(state,'{attempts,0,draft,notes}',to_jsonb($1::text))`,['Repaired same-ID result without changing updated_at']);hub.wake();await until(()=>frames.slice(0,15).every(rows=>rows.length===2)&&frames.slice(15).every(rows=>rows.length===3));assert.notEqual(frames[15].at(-1).value.resultRevision,revision);
  for(const handle of handles.slice(15))handle.close();const count=hub.snapshot().scans;hub.wake();await until(()=>hub.snapshot().scans>count);await new Promise(r=>setTimeout(r,20));assert.ok(frames.slice(0,15).every(rows=>rows.length===2));
 });
 test(`${product}: identical raw student/teacher tokens stay isolated and deleting one session revokes only that role`,async t=>{
  const f=await setup(t);await f.pool.query(`INSERT INTO ${schema}.teacher_session(token_hash,email,google_subject,expires_at,absolute_expires_at,remembered) VALUES($1,$2,$3,now()+interval '1 day',now()+interval '2 days',false)`,[hash(f.token),identity.email,identity.google_subject]);
  const teacher=await f.service.teacherProgress.observation({classId:'1124',code:f.content.code,unitId:f.registered.bindingId},{...identity,value:f.token}),student=await f.service.observation.studentGuard({token:f.token,attemptId:f.attemptId}),a=[],b=[],hub=createHub({read:f.service.observation.read});f.observers.push(hub);
  hub.subscribe({...teacher,send:(event,value)=>a.push({event,value})});hub.subscribe({...student,send:(event,value)=>b.push({event,value})});await until(()=>a.length===1&&b.length===1);
  await f.pool.query(`DELETE FROM ${schema}.student_session`);hub.wake();await until(()=>b.length===2);assert.equal(b[1].event,'access_revoked');assert.equal(b[1].value.status,401);assert.equal(a.length,1);assert.equal(hub.snapshot().connections,1);
 });
 test(`${product}: malformed student data and eligibility changes leave another authorized learner receiving valid state`,async t=>{
  const f=await setup(t),otherId=uuid(),otherRef=uuid(),otherAttempt=uuid(),otherToken=secret(),stored=(await f.pool.query(`SELECT state FROM ${schema}.work`)).rows[0].state,second=structuredClone(stored);second.attempts[0].id=otherAttempt;
  await f.pool.query(`INSERT INTO ${schema}.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof) VALUES($1,$2,$3,'other_fixture_document_1234567890','t.0',$4,'{}')`,[otherId,f.registered.assignmentId,otherRef,hash(secret())]);
  await f.pool.query(`INSERT INTO ${schema}.work(binding_id,state) VALUES($1,$2)`,[otherId,second]);await f.pool.query(`INSERT INTO ${schema}.student_session(token_hash,binding_id,expires_at) VALUES($1,$2,now()+interval '1 day')`,[hash(otherToken),otherId]);
  const original=f.context.student;f.context.student=async(c,id)=>id===otherRef&&c==='1124'?{studentRef:otherRef,name:'Second synthetic learner'}:original(c,id);
  const a=[],b=[],hub=createHub({read:f.service.observation.read});f.observers.push(hub);hub.subscribe({...await f.service.observation.studentGuard({token:f.token,attemptId:f.attemptId}),send:(event,value)=>a.push({event,value})});hub.subscribe({...await f.service.observation.studentGuard({token:otherToken,attemptId:otherAttempt}),send:(event,value)=>b.push({event,value})});await until(()=>a.length===1&&b.length===1);
  await f.pool.query(`UPDATE ${schema}.work SET state=jsonb_set(state,'{events}','42'::jsonb) WHERE binding_id=$1`,[f.registered.bindingId]);hub.wake();await until(()=>a.length===2);assert.equal(a[1].event,'unavailable');assert.equal(a[1].value.status,503);assert.equal(b.length,1);
  await f.pool.query(`UPDATE ${schema}.work SET state=$2 WHERE binding_id=$1`,[f.registered.bindingId,stored]);hub.wake();await until(()=>a.length===3);assert.equal(a[2].event,'state');assert.equal(a[2].value.revision,a[0].value.revision);assert.equal(b.length,1);
  f.setEligible(false);hub.wake();await until(()=>a.length===4);assert.equal(a[3].event,'access_revoked');assert.equal(a[3].value.status,403);assert.equal(hub.snapshot().connections,1);assert.equal(b.length,1);
 });
 test(`${product}: transient shared-read failure is 503, retains result data and recovers without a fake empty success`,async t=>{
  const f=await setup(t),initial=await get(f),query=f.pool.query.bind(f.pool);let down=true;f.pool.query=(sql,...args)=>{if(down&&sql.includes('WITH watched'))throw Error('SYNTHETIC_METADATA_FAILURE');return query(sql,...args);};
  const failed=await get(f);assert.equal(failed.status,503);assert.equal(failed.body.kind,undefined);down=false;const recovered=await get(f);assert.equal(recovered.status,200);assert.equal(recovered.body.revision,initial.body.revision);assert.deepEqual(recovered.body.events,initial.body.events);
 });
 test(`${product}: student SSE authenticates through headers, supplies compact state and releases its subscription on abort`,{timeout:15000},async t=>{
  const f=await setup(t),server=await new Promise(resolve=>{const s=f.app.listen(0,'127.0.0.1',()=>resolve(s));}),controller=new AbortController();let reader;
  try{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/student-progress/events?attemptId=${f.attemptId}`,{headers:{Authorization:'Bearer '+f.token,Accept:'text/event-stream'},signal:controller.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);reader=response.body.getReader();const decoder=new TextDecoder();let body='';while(!body.includes('\n\n')){const next=await reader.read();assert.equal(next.done,false);body+=decoder.decode(next.value);}
   assert.match(body,/event: state/);assert.ok(body.includes('practice-student-state-v1'));assert.equal(body.includes(f.token),false);assert.equal(body.includes('Private synthetic result notes'),false);
  }finally{controller.abort();try{await reader?.cancel();}catch{}await new Promise(resolve=>server.close(resolve));}
  await until(()=>f.app.locals.practiceObservation.snapshot().connections===0);
 });
}
