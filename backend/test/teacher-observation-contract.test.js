import test from 'node:test';
import assert from 'node:assert/strict';
import {teacherObservationActors,expandTeacherObservation} from '../src/teacher-observation-contract.js';
const key='a'.repeat(64),other='b'.repeat(64),actor={key,cookie:'fixture_session='+'t'.repeat(43),classIds:['2304']};
const success={key,ok:true,authSource:'session',reviewer:{email:'fixture@test.invalid',displayName:'Tên giả',role:'reviewer',canAccessAllClasses:false},
 googleSubject:'fixture-subject',sessionHash:'c'.repeat(64),idleExpiresAt:'2027-01-01T00:00:00.000Z',absoluteExpiresAt:'2027-12-01T00:00:00.000Z',allowedClassIds:['2304']};
test('Teacher observation wire: keyed rows reordered with per-actor denial stay bound to requested principal',()=>{
 const a={...actor,key:other};const denied={key:other,ok:false,error:'UNAUTHORIZED',status:401};
 const results=expandTeacherObservation([actor,a],{actors:[denied,success]});
 assert.equal(results.get(other).status,401);assert.equal(results.get(key).reviewer.email,success.reviewer.email);
 assert.equal(Object.hasOwn(results.get(key),'key'),false);assert.equal(JSON.stringify([...results]).includes(actor.cookie),false);
 assert.deepEqual(teacherObservationActors([{...actor,classIds:['2304','2304']}])[0].classIds,['2304']);
});
test('Teacher observation wire: missing, duplicate, alien keys or broadened scopes never become authorized state',()=>{
 for(const actors of [[],[success,success],[{...success,key:other}],[{...success,allowedClassIds:['2305']}],
  [{...success,allowedClassIds:['2304','2304']}],[{...success,cookie:actor.cookie}],
  [{...success,reviewer:{...success.reviewer,rawToken:'forbidden'}}],[{...success,idleExpiresAt:'2027-01-01T00:00:00'}],
  [{...success,authSource:'google_bearer'}],[{key,ok:false,error:'UNKNOWN',status:200}]])
  assert.throws(()=>expandTeacherObservation([actor],{actors}),{code:'AUTH_OBSERVATION_DATA_INVALID',status:503});
});
test('Teacher observation wire: body, class-pair and actor bounds reject before network/SQL',()=>{
 for(const inputs of [[{...actor,key:'token'}],[actor,actor],[{...actor,authorization:'Bearer forbidden'}],
  [{...actor,classIds:['9223372036854775808']}],Array.from({length:65},(_,n)=>({...actor,key:n.toString(16).padStart(64,'0'),cookie:'x'.repeat(16384)})),
  Array.from({length:3},(_,n)=>({...actor,key:n.toString(16).padStart(64,'0'),classIds:Array.from({length:1000},(_,i)=>String(i))}))])
  assert.throws(()=>teacherObservationActors(inputs),{code:'AUTH_OBSERVATION_INPUT_INVALID',status:400});
});
