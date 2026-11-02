import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeakingTeacherProgress} from '../src/speaking-teacher-progress.js';
import {httpFixture,cookie,origin} from './speaking-observation-http-fixture.mjs';
import {code} from './speaking-observation-fixture.mjs';

function fixture({enabled=false,parent=true,authSource='session',empty=false,admissionError=null}={}){
 const calls={context:0,teachers:0,admission:0,sql:0};
 const source={
  async context(){calls.context++;return{template:{title:'Bài giả'},classes:empty?[]:[{class_id:'2304',class_code:'IC2304'},{class_id:'9999',class_code:'OTHER'}]};},
  async teachers(ids){calls.teachers++;return new Set(ids.filter(id=>id==='2304'));},
  async teacherAdmission(ids){calls.admission++;if(admissionError)throw admissionError;return{allowed:new Set(ids.filter(id=>id==='2304')),authSource,reviewer:{email:'teacher@fixture.test'},
   ...(parent?{capabilities:{teacherStateStream:true}}:{})};}
 };
 const teacher=createSpeakingTeacherProgress({source,observationEnabled:enabled,pool:{query(){calls.sql++;throw Error('Classes must not add SQL');}}});
 return{teacher,calls,source};
}
test('Speaking teacher capability stays absent by default and preserves native classes with one authorization call',async()=>{
 const f=fixture(),value=await f.teacher.classes({assignmentCode:code},{cookie:'fixture'});
 assert.deepEqual(value,{assignment:{code,title:'Bài giả'},classes:[{classId:'2304',classCode:'IC2304'}]});
 assert.equal(f.calls.teachers+f.calls.admission,1);assert.equal(f.calls.sql,0);
});
test('Speaking teacher classes advertise both native stores through the existing admission when both runtimes support observation',async()=>{
 const f=fixture({enabled:true}),value=await f.teacher.classes({assignmentCode:code},{cookie:'fixture'});
 assert.deepEqual(value.capabilities,{teacherStateStream:true,teacherStateStores:['independent','legacy']});
 assert.deepEqual(value.classes,[{classId:'2304',classCode:'IC2304'}]);assert.equal(f.calls.context,1);assert.equal(f.calls.teachers+f.calls.admission,1);assert.equal(f.calls.sql,0);
});
test('Speaking teacher partial rollout, Bearer and old admission keep native classes without a stream capability',async()=>{
 for(const options of [{enabled:true,parent:false},{enabled:true,authSource:'bearer'},{enabled:true,authSource:null},{enabled:false,parent:true}]){
  const f=fixture(options),value=await f.teacher.classes({assignmentCode:code},{cookie:'fixture'});
  assert.equal(Object.hasOwn(value,'capabilities'),false);assert.deepEqual(value.classes,[{classId:'2304',classCode:'IC2304'}]);assert.equal(f.calls.teachers+f.calls.admission,1);
 }
 const old=fixture({enabled:true});delete old.source.teacherAdmission;
 assert.equal(Object.hasOwn(await old.teacher.classes({assignmentCode:code},{}),'capabilities'),false);assert.equal(old.calls.teachers,1);
});
test('Speaking teacher admission failures remain401403503 and never retry a weaker authorizer',async()=>{
 for(const status of [401,403,503]){
  const error=Object.assign(Error('SOURCE_FAILURE'),{code:'SOURCE_FAILURE',httpStatus:status}),f=fixture({enabled:true,admissionError:error});
  f.source.teachers=async()=>{throw Error('WEAKER_AUTHORIZER_MUST_NOT_RUN');};
  await assert.rejects(f.teacher.classes({assignmentCode:code},{cookie:'fixture'}),actual=>actual===error);assert.equal(f.calls.admission,1);
 }
});
test('Speaking teacher empty scoped assignments keep native denial without extra admission',async()=>{
 const f=fixture({enabled:true,empty:true});await assert.rejects(f.teacher.classes({assignmentCode:code},{}),error=>error.code==='TEACHER_ACCESS_DENIED'&&error.httpStatus===403);
 assert.equal(f.calls.admission,0);
});
test('Speaking teacher HTTP classes require both native runtime flags before advertising two-store observation',async()=>{
 for(const [enabled,parentEnabled]of [[false,false],[true,false],[false,true],[true,true]]){
  const f=await httpFixture({enabled,parentEnabled,nativeTeacher:true});try{
   const response=await fetch(f.independent+'/teacher/progress/classes?'+new URLSearchParams({assignmentCode:code}),{headers:{cookie,origin}});
   assert.equal(response.status,200);const data=await response.json();assert.ok(data.classes.length);
   assert.equal(data.capabilities?.teacherStateStream===true,enabled&&parentEnabled);
   if(enabled&&parentEnabled)assert.deepEqual(data.capabilities.teacherStateStores,['independent','legacy']);
  }finally{await f.close();}
 }
});
