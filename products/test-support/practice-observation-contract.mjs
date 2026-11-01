import test from 'node:test';
import assert from 'node:assert/strict';
const identity={email:'teacher@example.test',google_subject:'google-fixture'};
const until=async check=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('OBSERVATION_CONTRACT_TIMEOUT');};
export function practiceObservationContract({product,schema,fixture,createApp,request,createHub,uuid,secret}){
 async function setup(t,enabled=true){
  const f=await fixture();f.context.classes=async()=>[{id:'1124',classCode:'FIXTURE 67'}];
  let app;const observers=[];t.after(async()=>{for(const hub of observers)await hub.close();await app?.locals.practiceObservation?.close();await f.close();});
  app=createApp({pool:f.pool,service:f.service,origins:['https://page.test'],googleClientId:'synthetic-client',adminKey:secret(),stateStreamEnabled:enabled,verifyGoogle:async()=>({email:identity.email,sub:identity.google_subject,email_verified:true})});
  const login=await request(app).post('/api/teacher/login').send({credential:'synthetic-google-credential',remember:true});assert.equal(login.status,200);
  return{...f,app,observers,teacher:{...identity,value:login.body.token},reader:f.service.teacherProgress};
 }
 const get=(f,path)=>request(f.app).get('/api/teacher/progress/'+path).set('Authorization','Bearer '+f.teacher.value);
 const scopeFor=f=>({classId:'1124',code:f.content.code,unitId:f.registered.bindingId});
 test(`${product}: teacher HTTP capability and compact status preserve native auth, private data and read-only work`,async t=>{
  const f=await setup(t),start=await f.begin(),before=(await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows,jobs=(await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows;
  const classes=await get(f,'classes');assert.equal(classes.status,200);assert.equal(classes.body.capabilities.teacherStateStream,true);assert.equal(classes.body.capabilities.teacherStateIntervalMs,30000);
  const status=await get(f,'status').query(scopeFor(f));assert.equal(status.status,200);assert.equal(status.body.kind,'practice-teacher-state-v1');assert.equal(status.body.unitId,start.identity.bindingId);assert.equal(status.body.revision.length,64);
  assert.match(status.headers['cache-control'],/no-store/);for(const field of ['answers','attempts','notes','definition','roster','student','sessions'])assert.equal(status.body[field],undefined);
  assert.equal(JSON.stringify(status.body).includes(start.lease.token),false);assert.equal(f.app.locals.practiceObservation.snapshot().connections,0);
  assert.deepEqual((await f.pool.query(`SELECT state,updated_at FROM ${schema}.work`)).rows,before);assert.deepEqual((await f.pool.query(`SELECT * FROM ${schema}.doc_job ORDER BY id`)).rows,jobs);
  assert.equal((await request(f.app).get('/api/teacher/progress/status').query(scopeFor(f))).status,401);
  assert.equal((await get(f,'status').query({...scopeFor(f),admin:'true'})).status,400);
  assert.equal((await get(f,'status').set('Origin','https://denied.test').query(scopeFor(f))).status,403);
  f.setTeacher(false);const denied=await get(f,'status').query(scopeFor(f));assert.equal(denied.status,403);assert.equal(denied.headers['set-cookie'],undefined);
 });
 test(`${product}: thirty teacher scopes across classes and lesson codes share two SQL reads and isolate changed units`,async t=>{
  const f=await setup(t),start=await f.begin(),secondAssignment=uuid(),secondBinding=uuid(),otherStudent=uuid(),otherContent=uuid(),otherAssignment=uuid(),otherBinding=uuid(),otherCode=f.content.code+'_other_scope';
  await f.pool.query(`INSERT INTO ${schema}.assignment(id,class_id,class_code,content_id,status) SELECT $1,'1131','SECOND FIXTURE',content_id,'open' FROM ${schema}.assignment WHERE id=$2`,[secondAssignment,f.registered.assignmentId]);
  await f.pool.query(`INSERT INTO ${schema}.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof) VALUES($1,$2,$3,$4,'t.0',$5,'{}')`,[secondBinding,secondAssignment,otherStudent,'second_fixture_document_1234567890',secret()]);
  await f.pool.query(`INSERT INTO ${schema}.content(id,code,version,digest,definition,answer_key,explanations,total_ms) SELECT $1,$2,version,digest,definition,answer_key,explanations,total_ms FROM ${schema}.content WHERE code=$3`,[otherContent,otherCode,f.content.code]);
  await f.pool.query(`INSERT INTO ${schema}.assignment(id,class_id,class_code,content_id,status) VALUES($1,'1124','FIXTURE 67',$2,'open')`,[otherAssignment,otherContent]);
  await f.pool.query(`INSERT INTO ${schema}.binding(id,assignment_id,student_ref,document_id,tab_id,entry_hash,owner_proof) VALUES($1,$2,$3,$4,'t.0',$5,'{}')`,[otherBinding,otherAssignment,uuid(),'other_lesson_document_1234567890',secret()]);
  f.context.teacher=async(classId,email,subject)=>['1124','1131'].includes(classId)&&email===identity.email&&subject===identity.google_subject;
  f.context.roster=async classId=>[{studentRef:classId==='1124'?f.studentRef:otherStudent,name:classId==='1124'?'First synthetic learner':'Second synthetic learner'}];
  const scopes=[];for(let n=0;n<30;n++)scopes.push(await f.reader.observation(n<15?scopeFor(f):n<25?{classId:'1131',code:f.content.code,unitId:secondBinding}:{classId:'1124',code:otherCode,unitId:otherBinding},f.teacher));
  const query=f.pool.query.bind(f.pool);let queries=0;f.pool.query=(...args)=>{queries++;return query(...args);};
  const hub=createHub({read:f.reader.readObservations,interval:30000}),frames=Array.from({length:30},()=>[]);f.observers.push(hub);
  for(let n=0;n<30;n++)hub.subscribe({...scopes[n],send:(event,value)=>frames[n].push({event,value})});
  await until(()=>frames.every(rows=>rows.length===1));assert.equal(queries,2);assert.ok(frames.every(rows=>rows[0].event==='state'));
  hub.wake();await until(()=>hub.snapshot().scans===2);await until(()=>queries===4);await new Promise(r=>setTimeout(r,20));assert.ok(frames.every(rows=>rows.length===1));
  const snapshot=f.draft();snapshot.sequence=1;snapshot.notes='Only the first authorized class changes.';await f.service.pulse({token:f.token,attemptId:start.attempts[0].id,lease:start.lease,snapshot});
  queries=0;hub.wake();await until(()=>frames.slice(0,15).every(rows=>rows.length===2));assert.equal(queries,2);assert.ok(frames.slice(15).every(rows=>rows.length===1));
  assert.ok(frames.slice(0,15).every(rows=>rows[1].value.unitId===f.registered.bindingId));assert.equal(JSON.stringify(frames).includes(snapshot.notes),false);
  await f.pool.query(`UPDATE ${schema}.work SET state=jsonb_set(state,'{attempts,0,draft,answers}','[]'::jsonb) WHERE binding_id=$1`,[f.registered.bindingId]);hub.wake();
  await until(()=>frames[0].at(-1).event==='unavailable');assert.ok(frames.slice(15).every(rows=>rows.length===1));assert.equal(frames[0].at(-1).value.status,503);
  await f.pool.query(`UPDATE ${schema}.work SET state=jsonb_set(state,'{attempts,0,draft,answers}','{}'::jsonb) WHERE binding_id=$1`,[f.registered.bindingId]);hub.wake();
  await until(()=>frames.slice(0,15).every(rows=>rows.length===4));assert.ok(frames.slice(0,15).every(rows=>rows.at(-1).event==='state'));assert.ok(frames.slice(15).every(rows=>rows.length===1));
 });
 test(`${product}: a moved unit revokes its old class scope while other authorized viewers keep receiving state`,async t=>{
  const f=await setup(t),original=await f.reader.observation(scopeFor(f),f.teacher),list=await f.reader.observation({...scopeFor(f),unitId:undefined},f.teacher),events=[],listEvents=[];
  const hub=createHub({read:f.reader.readObservations,interval:30000});f.observers.push(hub);
  hub.subscribe({...original,send:(event,value)=>events.push({event,value})});hub.subscribe({...list,send:(event,value)=>listEvents.push({event,value})});await until(()=>events.length===1&&listEvents.length===1);
  await f.pool.query(`UPDATE ${schema}.assignment SET class_id='1131',class_code='MOVED FIXTURE' WHERE id=$1`,[f.registered.assignmentId]);hub.wake();await until(()=>events.length===2&&listEvents.length===2);
  assert.equal(events[1].event,'access_revoked');assert.equal(events[1].value.status,403);assert.equal(listEvents[1].event,'state');assert.equal(hub.snapshot().connections,1);
  await f.pool.query(`DELETE FROM ${schema}.teacher_session`);hub.wake();await until(()=>listEvents.length===3);assert.equal(listEvents[2].event,'access_revoked');assert.equal(listEvents[2].value.status,401);assert.equal(hub.snapshot().connections,0);
 });
 test(`${product}: legacy default does not advertise observation; opt-in rejects mismatched scope and missing units`,async t=>{
  const old=await setup(t,false);assert.equal((await get(old,'classes')).body.capabilities,undefined);
  const f=await setup(t);assert.equal((await get(f,'status').query({...scopeFor(f),unitId:uuid()})).status,404);
  assert.equal((await get(f,'status').query({...scopeFor(f),code:f.content.code+'_other'})).status,403);
 });
 test(`${product}: unavailable metadata returns a native 503 and recovers without an empty success snapshot`,async t=>{
  const f=await setup(t),query=f.pool.query.bind(f.pool);let failed;
  f.pool.query=(sql,...args)=>typeof sql==='string'&&sql.includes('WITH watched')?Promise.reject(Object.assign(Error('Synthetic metadata outage'),{code:'SYNTHETIC_METADATA_UNAVAILABLE'})):query(sql,...args);
  try{failed=await get(f,'status').query(scopeFor(f));}finally{f.pool.query=query;}
  assert.equal(failed.status,503);assert.equal(failed.body.error.code,'SYNTHETIC_METADATA_UNAVAILABLE');assert.equal(failed.body.revision,undefined);assert.equal(f.app.locals.practiceObservation.snapshot().connections,0);
  const recovered=await get(f,'status').query(scopeFor(f));assert.equal(recovered.status,200);assert.equal(recovered.body.kind,'practice-teacher-state-v1');
 });
 test(`${product}: same-attempt content and definition repairs are observed even when saved time and digest stay unchanged`,async t=>{
  const f=await setup(t),started=await f.begin(),watched=await f.reader.observation(scopeFor(f),f.teacher),events=[],hub=createHub({read:f.reader.readObservations,interval:30000});f.observers.push(hub);
  hub.subscribe({...watched,send:(event,value)=>events.push({event,value})});await until(()=>events.length===1);
  const before=(await f.pool.query(`SELECT updated_at FROM ${schema}.work WHERE binding_id=$1`,[f.registered.bindingId])).rows[0].updated_at;
  await f.pool.query(`UPDATE ${schema}.work SET state=jsonb_set(state,'{attempts,0,draft,notes}',to_jsonb($2::text)) WHERE binding_id=$1`,[f.registered.bindingId,'Synthetic repair with unchanged saved time']);
  hub.wake();await until(()=>events.length===2);assert.notEqual(events[0].value.unitRevision,events[1].value.unitRevision);assert.equal(events[0].value.classRevision,events[1].value.classRevision);
  assert.deepEqual((await f.pool.query(`SELECT updated_at FROM ${schema}.work WHERE binding_id=$1`,[f.registered.bindingId])).rows[0].updated_at,before);
  const repaired=await f.reader.detail({id:started.identity.bindingId},identity);assert.equal(repaired.attempts[0].notes,'Synthetic repair with unchanged saved time');
  const path=product==='Reading'?['passage','A']:['mcq','0','text'];
  await f.pool.query(`UPDATE ${schema}.content SET definition=jsonb_set(definition,$1::text[],to_jsonb($2::text)) WHERE code=$3`,[path,'Synthetic definition repair without a digest update',f.content.code]);
  hub.wake();await until(()=>events.length===3);assert.notEqual(events[1].value.unitRevision,events[2].value.unitRevision);
 });
}
