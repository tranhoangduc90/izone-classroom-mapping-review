import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,id,code,token} from './speaking-observation-fixture.mjs';
import {createSpeakingObservation} from '../src/speaking-observation.js';
import {speakingSourceScopeKey} from '../src/speaking-source-batch.js';
import {httpFixture,cookie,origin,stream} from './speaking-observation-http-fixture.mjs';
async function within(promise,ms){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}finally{clearTimeout(timer);}}

for(const kind of ['independent-teacher-auth','legacy-teacher-source'])test('Speaking observation fairness: '+kind+' cannot hold student updates',async()=>{
 const f=await fixture(),schema=kind.startsWith('independent')?'speaking_independent':'speaking_homework';
 let unblock,entered;const barrier=new Promise(resolve=>{unblock=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const source={async contexts(scopes){
  if(kind==='legacy-teacher-source'){entered();await barrier;}
  const values=new Map();for(const scope of scopes)values.set(speakingSourceScopeKey(scope),{ok:true,context:await f.source.context(scope)});return values;
 }};
 const observeTeachers=async actors=>{
  if(kind==='independent-teacher-auth'){entered();await barrier;}
  return new Map(actors.map(actor=>[actor.key,{ok:true,authSource:'session',reviewer:{email:'teacher@fixture.test'},allowedClassIds:actor.classIds}]));
 };
 // Data/owner nguồn thật trong fixture; chỉ authority của GV được giữ có chủ ý.
 // Đây là chứng cứ hub/read-only, không phải Google/HTTP/capacity.
 const o=createSpeakingObservation({schema,data:f.data(schema),source,observeTeachers});let teacherRead,studentRead;
 try{
  const teacher=o.teacher({classId:'2304',classCode:'IC2304',code,courseId:'100'},
   {authSource:'session',cookie:'fixture_teacher='+'t'.repeat(43),reviewer:{email:'teacher@fixture.test'}});
  teacherRead=o.hub.readOnce(teacher.scope,teacher.guard);teacherRead.catch(()=>{});
  assert.notEqual(await within(started.then(()=>true),3000),null,'Teacher dependency must actually be stalled');
  const student=o.student({studentRef:id(1),accessToken:token(1)});studentRead=o.hub.readOnce(student.scope,student.guard);studentRead.catch(()=>{});
  const value=await within(studentRead,1000);
  assert.notEqual(value,null,'Student metadata must arrive while the unrelated teacher dependency is still blocked');
  assert.equal(value.studentRef,id(1));assert.equal(value.unitId,id(schema==='speaking_independent'?1001:2001));
  unblock();assert.equal((await teacherRead).classId,'2304');
 }finally{
  unblock();await Promise.allSettled([teacherRead,studentRead].filter(Boolean));await o.close();await f.close();
 }
});

const principal={authSource:'session',cookie:'fixture_teacher='+'t'.repeat(43),reviewer:{email:'teacher@fixture.test'}};
const teacherPair=o=>o.teacher({classId:'2304',classCode:'IC2304',code,courseId:'100'},principal);
function ordinary(f,hubOptions={},observeTeachers=async actors=>new Map(actors.map(actor=>[actor.key,{ok:true,authSource:'session',reviewer:principal.reviewer,allowedClassIds:actor.classIds}]))){
 return createSpeakingObservation({schema:'speaking_independent',data:f.data('speaking_independent'),hubOptions,observeTeachers,
  source:{async contexts(scopes){const values=new Map();for(const scope of scopes)values.set(speakingSourceScopeKey(scope),{ok:true,context:await f.source.context(scope)});return values;}}});
}

test('Speaking observation cohorts retain one combined connection limit and release slots across roles',async()=>{
 const f=await fixture(),o=ordinary(f,{maxConnections:1});let handle;
 try{
  handle=o.hub.subscribe({...teacherPair(o),send(){}});const student=o.student({studentRef:id(1),accessToken:token(1)});
  await assert.rejects(o.hub.readOnce(student.scope,student.guard),error=>error.code==='STATE_CONNECTION_LIMIT'&&error.status===503);
  assert.equal(o.hub.snapshot().connections,1);handle.close();assert.equal(o.hub.snapshot().connections,0);
  assert.equal((await o.hub.readOnce(student.scope,student.guard)).studentRef,id(1));assert.equal(o.hub.snapshot().connections,0);
  await o.close();assert.equal(o.hub.snapshot().closed,true);
  await assert.rejects(o.hub.readOnce(student.scope,student.guard),error=>error.status===503);
 }finally{handle?.close();await o.close();await f.close();}
});

test('Speaking observation close drains both cohorts and drops frames from a late teacher dependency',async()=>{
 const f=await fixture();let unblock,entered;const barrier=new Promise(resolve=>{unblock=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const o=ordinary(f,{},async actors=>{entered();await barrier;return new Map(actors.map(actor=>[actor.key,{ok:true,authSource:'session',reviewer:principal.reviewer,allowedClassIds:actor.classIds}]));});
 const frames=[];let student,teacher,closing;
 try{
  teacher=o.hub.subscribe({...teacherPair(o),send:(event,value)=>frames.push({role:'teacher',event,value})});
  assert.notEqual(await within(started.then(()=>true),3000),null);
  student=o.hub.subscribe({...o.student({studentRef:id(1),accessToken:token(1)}),send:(event,value)=>frames.push({role:'student',event,value})});
  const end=Date.now()+1000;while(!frames.some(row=>row.role==='student'&&row.event==='state')&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(frames.some(row=>row.role==='student'&&row.event==='state'));closing=o.close();assert.equal(o.close(),closing);
  assert.equal(o.hub.snapshot().connections,0);assert.equal(o.hub.snapshot().closed,true);
  assert.equal(await within(closing.then(()=>true),20),null,'Drain must wait for the in-flight authority read');
  const count=frames.length;unblock();await closing;o.wake();await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(frames.length,count);assert.equal(frames.some(row=>row.role==='teacher'&&row.event==='state'),false);
 }finally{unblock();student?.close();teacher?.close();await o.close();await f.close();}
});

for(const kind of ['independent-teacher-auth','legacy-teacher-source'])test('Speaking observation HTTP fairness: '+kind+' keeps native studentSSE responsive',async()=>{
 const f=await httpFixture();const independent=kind.startsWith('independent'),target=independent?f.db:f.pool;
 const original=target.query.bind(target);let unblock,entered,teacherResponded=false,teacherRead,studentRead;
 const barrier=new Promise(resolve=>{unblock=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 target.query=async(sql,params)=>{
  const selected=independent?sql.includes('jsonb_to_recordset')&&sql.includes('mapping.reviewer_session'):/FROM\s+speaking_homework\.assignment_template\b/.test(sql);
  if(selected){entered();await barrier;}return original(sql,params);
 };
 try{
  const base=independent?f.independent:f.parent;
  // Admission cookie/session native phải qua. Chỉ giữ batch authority hoặc
  // context sau khi teacher hub đã nhận request, không giữ endpoint admission.
  teacherRead=stream(base+'/teacher/progress/events?'+new URLSearchParams({classId:'2304',classCode:'IC2304',code}),{headers:{cookie,origin}})
   .then(value=>{teacherResponded=true;return value;});teacherRead.catch(()=>{});
  assert.notEqual(await within(started.then(()=>true),3000),null,'Actual teacher observation dependency must enter the SQL barrier');
  studentRead=stream(base+'/observation/student/events',{body:{studentRef:id(1),accessToken:token(1)}});studentRead.catch(()=>{});
  const student=await within(studentRead,3000);
  assert.notEqual(student,null,'Native student HTTP headers must arrive before the teacher dependency is released');
  assert.equal(student.response.status,200);const event=await within(student.event(),3000);
  assert.equal(event?.event,'state');assert.equal(event.value.studentRef,id(1));assert.equal(event.value.unitId,id(independent?1001:2001));
  assert.equal(teacherResponded,false);unblock();const teacher=await teacherRead;assert.equal(teacher.response.status,200);
 }finally{
  unblock();for(const result of await Promise.allSettled([teacherRead,studentRead].filter(Boolean)))if(result.status==='fulfilled')result.value.close();
  target.query=original;await f.close();
 }
});
