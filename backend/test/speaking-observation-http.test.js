import test from 'node:test';
import assert from 'node:assert/strict';
import {httpFixture,post,stream,cookie,origin} from './speaking-observation-http-fixture.mjs';
import {id,token,code} from './speaking-observation-fixture.mjs';
const identity=n=>({accessToken:token(n),studentRef:id(n)});
const query=new URLSearchParams({classId:'2304',classCode:'IC2304',code});

test('Speaking observation HTTP: capabilities stay opt-in and both native stores return guarded metadata/combined view',async()=>{
 const f=await httpFixture();try{
  for(const [base,unit] of [[f.independent,1001],[f.parent,2001]]){
   const capability=await fetch(base+'/observation/capabilities');assert.equal(capability.status,200);assert.equal((await capability.json()).capabilities.studentCombinedView,true);
   const state=await post(base+'/observation/student/status',identity(1));assert.equal(state.response.status,200);assert.equal(state.data.state.unitId,id(unit));
   assert.equal(state.data.state.studentRef,id(1));assert.equal(Object.hasOwn(state.data.state,'open'),false);assert.match(state.response.headers.get('cache-control'),/no-store/);
   const view=await post(base+'/observation/student/view',{...identity(1),unitId:id(unit)});assert.equal(view.response.status,200);
   assert.equal(view.data.view.kind,'speaking-student-view-v1');assert.ok(view.data.view.open&&view.data.view.doctor);
   const wrong=await post(base+'/observation/student/view',{...identity(1),unitId:id(unit+1)});assert.equal(wrong.response.status,403);
  }
 }finally{await f.close();}
 const disabled=await httpFixture({enabled:false});try{
  for(const base of [disabled.parent,disabled.independent])assert.equal((await fetch(base+'/observation/capabilities')).status,404);
 }finally{await disabled.close();}
});

test('Speaking observation HTTP: POST student stream carries token only in body and Docs-only wake preserves content revision',async()=>{
 const f=await httpFixture();let events;try{
  events=await stream(f.independent+'/observation/student/events',{body:{...identity(1),unitId:id(1001)}});
  assert.equal(events.response.status,200);assert.match(events.response.headers.get('content-type'),/text\/event-stream/);
  assert.equal(events.response.url.includes(token(1)),false);const first=await events.event();assert.equal(first.event,'state');
  await f.db.query('INSERT INTO speaking_independent.doc_progress VALUES($1,$2,NULL,1,0,NULL)',[id(1001),'pending']);f.observation.wake();
  const next=await events.event();assert.equal(next.event,'state');assert.equal(next.value.unitId,id(1001));
  assert.equal(next.value.contentRevision,first.value.contentRevision);assert.notEqual(next.value.docsRevision,first.value.docsRevision);
  await f.db.query('UPDATE speaking_independent.work_unit SET revoked_at=now() WHERE id=$1',[id(1001)]);f.observation.wake();
  const denied=await events.event();assert.equal(denied.event,'access_revoked');assert.equal(denied.value.status,403);
 }finally{events?.close();await f.close();}
});

test('Speaking observation HTTP: teacher GET streams use current native cookie rights in each store, legacy course resolves in batch',async()=>{
 const f=await httpFixture();const opened=[];try{
  for(const base of [f.independent,f.parent]){
   const events=await stream(base+'/teacher/progress/events?'+query,{headers:{cookie,origin}});opened.push(events);
   assert.equal(events.response.status,200);const first=await events.event();assert.equal(first.event,'state');assert.equal(first.value.classId,'2304');
  }
  await f.db.query("DELETE FROM mapping.reviewer_class_access WHERE reviewer_email='teacher@fixture.test'");
  f.observation.wake();f.parentObservation.wake();
  for(const events of opened){const event=await events.event();assert.equal(event.event,'access_revoked');assert.equal(event.value.status,403);}
 }finally{for(const events of opened)events.close();await f.close();}
});

test('Speaking observation HTTP: missing cookie, Bearer-only, wrong input and wrong class keep native denial/fallback meanings',async()=>{
 const f=await httpFixture();try{
  for(const base of [f.independent,f.parent]){
   assert.equal((await fetch(base+'/teacher/progress/state?'+query)).status,401);
   const bearer=await fetch(base+'/teacher/progress/state?'+query,{headers:{authorization:'Bearer fixture-google-token'}});assert.equal(bearer.status,409);
   assert.equal((await bearer.json()).error,'STATE_AUTH_COOKIE_REQUIRED');
   const wrongClass=new URLSearchParams({classId:'2305',classCode:'IC2305',code});
   assert.equal((await fetch(base+'/teacher/progress/state?'+wrongClass,{headers:{cookie,origin}})).status,403);
   const bad=await post(base+'/observation/student/status',{...identity(1),classId:'2305'});assert.equal(bad.response.status,400);
   assert.equal((await post(base+'/observation/student/view',identity(1))).response.status,400);
  }
 }finally{await f.close();}
});
