import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,seedBatch,id,code,token,hash} from './speaking-observation-fixture.mjs';
import {createSpeakingObservation} from '../src/speaking-observation.js';
import {speakingSourceScopeKey} from '../src/speaking-source-batch.js';
const schema='speaking_independent',legacy='speaking_homework',principal={authSource:'session',cookie:'fixture_teacher='+'t'.repeat(43),reviewer:{email:'teacher@fixture.test'}};
const teacherScope={classId:'2304',classCode:'IC2304',code,courseId:'100'};
const identity=n=>({accessToken:token(n),studentRef:id(n)});
async function until(check){const end=Date.now()+15000;while(!check()){if(Date.now()>end)throw Error('OBSERVATION_FIXTURE_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,10));}}
function adapter(f,store=schema){
 const stats={data:0,auth:0,sources:[],rights:true,broken:false};
 const data={async read(input){stats.data++;if(stats.broken)throw Object.assign(Error('fixture failure'),{code:'SQL_FIXTURE_UNAVAILABLE'});return f.data(store).read(input);}};
 const source={async contexts(scopes){if(stats.contextsBroken)throw Object.assign(Error('fixture source failure'),{code:'FIXTURE_SOURCE_UNAVAILABLE',status:503});stats.sources.push(scopes);const result=new Map();
  for(const input of scopes){try{result.set(speakingSourceScopeKey(input),{ok:true,context:await f.source.context(input)});}
   catch(error){result.set(speakingSourceScopeKey(input),{ok:false,error:error.code,status:error.httpStatus});}}
  return result;
 }};
 const observeTeachers=async actors=>{stats.auth++;if(stats.authBroken)throw Object.assign(Error('fixture auth transport failure'),{code:'FIXTURE_AUTH_UNAVAILABLE',status:401});return new Map(actors.map(actor=>[actor.key,{ok:true,authSource:'session',
  reviewer:principal.reviewer,googleSubject:'fixture-subject',sessionHash:hash(principal.cookie),idleExpiresAt:'2027-01-01T00:00:00Z',absoluteExpiresAt:'2027-12-01T00:00:00Z',
  allowedClassIds:stats.rights?actor.classIds:[]}]))};
 return{stats,observation:createSpeakingObservation({schema:store,data,source,observeTeachers})};
}

test('Speaking teacher observation tracks current template labels even when saved unit content is unchanged',async()=>{
 const f=await fixture();try{
  for(const [store,unitId]of [[schema,id(1001)],[legacy,id(2001)]]){
   const {observation:o}=adapter(f,store);try{
    const pair=o.teacher({...teacherScope,unitId},principal),first=await o.hub.readOnce(pair.scope,pair.guard);
    f.template.title+=' · nhãn hiện hành';
    const title=await o.hub.readOnce(pair.scope,pair.guard);assert.notEqual(title.classRevision,first.classRevision);
    assert.equal(title.unitContentRevision,first.unitContentRevision);
    f.template.parts=f.template.parts.map(part=>({...part,display_title:(part.display_title||'')+' · '+store}));
    const parts=await o.hub.readOnce(pair.scope,pair.guard);assert.notEqual(parts.classRevision,title.classRevision);
    assert.equal(parts.unitContentRevision,title.unitContentRevision);
   }finally{await o.close();}
  }
 }finally{await f.close();}
});

test('Speaking observation:100 distinct students and100 teacher views share one hub/data read and grouped source scopes',async t=>{
 const f=await fixture(),{stats,observation:o}=adapter(f);try{
  const owners=await seedBatch(f);
  const students=owners.map((owner,index)=>o.student({accessToken:Buffer.from(hash('state-bulk-token-'+(index+1)),'hex').toString('base64url'),studentRef:owner.student,unitId:owner.unit}));
  const teachers=Array.from({length:100},()=>o.teacher(teacherScope,principal));
  const values=await Promise.all([...students,...teachers].map(pair=>o.hub.readOnce(pair.scope,pair.guard)));
  assert.equal(stats.data,1);assert.equal(stats.auth,1);assert.equal(stats.sources.length,1);
  assert.equal(stats.sources[0].length,2);assert.deepEqual(new Set(stats.sources[0].map(scope=>scope.webEntry===true)),new Set([true,false]));
  for(let n=0;n<100;n++){assert.equal(values[n].unitId,owners[n].unit);assert.equal(values[n].studentRef,owners[n].student);assert.equal(values[n].kind,'speaking-student-state-v1');}
  assert.equal(new Set(values.slice(100).map(row=>row.classRevision)).size,1);assert.equal(o.hub.snapshot().scans,1);
  const text=JSON.stringify(values);for(const forbidden of ['matched_sessions','token_hash','teacher_session',principal.cookie])assert.equal(text.includes(forbidden),false);
  assert.equal(values.filter(value=>Object.hasOwn(value,'open')).length,0);
  t.diagnostic(JSON.stringify({event:'speaking_observation_hub_shape',students:100,teacherViews:100,dataReads:stats.data,authBatches:stats.auth,sourceBatches:stats.sources.length,sourceScopes:2,
   engine:f.nativeUrl?'postgresql':'pglite',scope:'in-process hub, not HTTP/SSE browser/NAT capacity'}));
 }finally{await o.close();await f.close();}
});

test('Speaking observation: unchanged snapshots stay silent; Docs-only, content and permission changes reach correct scopes',async()=>{
 const f=await fixture(),{stats,observation:o}=adapter(f);try{
  const student=o.student({...identity(1),unitId:id(1001)}),teacher=o.teacher({...teacherScope,unitId:id(1001)},principal);
  const a=[],b=[];o.hub.subscribe({...student,send:(event,value)=>a.push({event,value})});o.hub.subscribe({...teacher,send:(event,value)=>b.push({event,value})});
  await until(()=>a.length===1&&b.length===1);const first=a[0].value;
  for(let n=0;n<3;n++){const previous=o.hub.snapshot().scans;o.wake();await until(()=>o.hub.snapshot().scans>previous);await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(a.length,1);assert.equal(b.length,1);
  await f.db.query('INSERT INTO speaking_independent.doc_progress VALUES($1,$2,NULL,1,0,NULL)',[id(1001),'pending']);o.wake();
  await until(()=>a.length===2&&b.length===2);assert.equal(a[1].value.contentRevision,first.contentRevision);assert.notEqual(a[1].value.docsRevision,first.docsRevision);
  await f.db.query("UPDATE speaking_independent.link SET check_code='FIXTURE_CHANGED' WHERE work_unit_id=$1 AND kind='main'",[id(1001)]);o.wake();
  await until(()=>a.length===3&&b.length===3);assert.notEqual(a[2].value.contentRevision,first.contentRevision);
  const full=o.student({...identity(1),unitId:id(1001)},{view:true}),view=await o.hub.readOnce(full.scope,full.guard);
  assert.equal(view.kind,'speaking-student-view-v1');assert.ok(view.open&&view.doctor);assert.equal(view.contentRevision,a[2].value.contentRevision);
  stats.rights=false;o.wake();await until(()=>b.at(-1).event==='access_revoked');assert.equal(b.at(-1).value.status,403);
  await f.db.query('UPDATE speaking_independent.work_unit SET revoked_at=now() WHERE id=$1',[id(1001)]);o.wake();
  await until(()=>a.at(-1).event==='access_revoked');assert.equal(a.at(-1).value.status,403);assert.equal(o.hub.snapshot().connections,0);
 }finally{await o.close();await f.close();}
});

test('Speaking observation: SQL/source failure is temporary; current source membership and store/unit binding remain mandatory',async()=>{
 const f=await fixture(),{stats,observation:o}=adapter(f);try{
  let pair=o.student(identity(1));stats.broken=true;await assert.rejects(o.hub.readOnce(pair.scope,pair.guard),{status:503,code:'SQL_FIXTURE_UNAVAILABLE'});
  stats.broken=false;assert.equal((await o.hub.readOnce(pair.scope,pair.guard)).unitId,id(1001));
  pair=o.student({...identity(1),unitId:id(1002)});await assert.rejects(o.hub.readOnce(pair.scope,pair.guard),{status:403,code:'SESSION_INVALID'});
  await f.db.query("UPDATE mapping.erp_class_membership_snapshot SET source_state='missing' WHERE erp_student_contact_id=1");
  const raw=await f.data(schema).read({sessions:[{hash:hash(token(1)),studentRef:id(1)}]});assert.equal(raw[0].local_grant_allowed,true);
  pair=o.student(identity(1));await assert.rejects(o.hub.readOnce(pair.scope,pair.guard),{status:403,code:'STUDENT_NOT_ACTIVE'});
  await assert.rejects(f.independent.open(identity(1)),error=>error.code==='STUDENT_NOT_ACTIVE');
  assert.throws(()=>o.teacher(teacherScope,{...principal,authSource:'google_bearer'}),{status:409});
 }finally{await o.close();await f.close();}
});

test('Speaking observation: legacy first-open initialization stays native and current grant/ERP revocation is enforced',async()=>{
 const f=await fixture(),{stats,observation:o}=adapter(f,legacy);try{
  await f.db.query('DELETE FROM speaking_homework.submission WHERE id=$1',[id(2001)]);
  const initial=o.student(identity(1));await assert.rejects(o.hub.readOnce(initial.scope,initial.guard),{status:409,code:'SPEAKING_STATE_NOT_READY'});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM speaking_homework.submission WHERE access_grant_id=$1',[id(201)])).rows[0].n,0);
  await f.legacy.open(identity(1));const next=o.student(identity(1)),state=await o.hub.readOnce(next.scope,next.guard);
  assert.equal(state.kind,'speaking-student-state-v1');assert.ok(state.unitId);assert.equal(stats.sources.length,0);
  const full=o.student({...identity(1),unitId:state.unitId},{view:true}),view=await o.hub.readOnce(full.scope,full.guard);assert.equal(view.open.student.ref,id(1));
  await f.db.query("UPDATE mapping.erp_class_membership_snapshot SET source_state='missing' WHERE erp_student_contact_id=1");
  await assert.rejects(o.hub.readOnce(next.scope,next.guard),{status:403,code:'SESSION_INVALID'});
 }finally{await o.close();await f.close();}
});

test('Speaking observation: failed teacher-auth/source batch does not revoke or suppress valid legacy student state',async()=>{
 const f=await fixture(),{stats,observation:o}=adapter(f,legacy);try{
  const student=o.student(identity(1)),teacher=o.teacher(teacherScope,principal);
  for(const fault of ['authBroken','contextsBroken']){
   stats[fault]=true;
   const [a,b]=await Promise.allSettled([o.hub.readOnce(student.scope,student.guard),o.hub.readOnce(teacher.scope,teacher.guard)]);
   assert.equal(a.status,'fulfilled');assert.equal(a.value.studentRef,id(1));
   assert.equal(b.status,'rejected');assert.equal(b.reason.status,503);stats[fault]=false;
  }
  const restored=await Promise.all([o.hub.readOnce(student.scope,student.guard),o.hub.readOnce(teacher.scope,teacher.guard)]);
  assert.equal(restored[0].kind,'speaking-student-state-v1');assert.equal(restored[1].kind,'speaking-teacher-state-v1');
 }finally{await o.close();await f.close();}
});
