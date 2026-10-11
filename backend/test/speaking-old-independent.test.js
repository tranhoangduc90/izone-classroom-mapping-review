import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {createIndependentSource}=await import(process.env.SPEAKING_SOURCE_TEST_FILE
  ?pathToFileURL(process.env.SPEAKING_SOURCE_TEST_FILE).href:'../src/speaking-independent-source.js');
import {createSpeakingLegacyBridge} from '../src/speaking-legacy-bridge.js';
import {createIndependentSpeaking} from '../src/speaking-independent.js';

// Fixture giả kiểm mở bài cũ không cần Docs và giữ đường bài đã có tiến độ.
// Không gọi API thật hoặc ghi database; sai kỳ vọng báo đúng tên tình huống.
const cases=[['67-speaking-paraphrase','index.html'],['67-speaking-lam_ro','lesson-3.html'],['67-speaking-diem_giua','lesson-4.html'],['67-speaking-on_tap_lam_ro_diem_giua','lesson-5.html']];
for(const [code,page] of cases)test(`catalogue opens ${page} without Classroom`,async()=>{
  const pool={async query(sql){
    if(sql.includes('assignment_template'))return {rows:[{assignment_code:code,page_path:page,title:'Bài mẫu',parts:[{part_key:'freestyle',min_questions:3}],required_practice_count:0,doctor_course_key:'67'}]};
    if(sql.includes('class_scope'))return {rows:[{class_id:1,class_code:'ICM',course_id:'1'}]};
    return {rows:[]};
  }};
  const result=await createIndependentSource({pool}).context({assignmentCode:code});
  assert.ok(result.template.lesson>=2);assert.equal(result.classes.length,1);
});
test('IC2304 assigned one-question policy is preserved',async()=>{
  const pool={async query(sql){
    if(sql.includes('assignment_template'))return {rows:[{assignment_code:cases[2][0],page_path:'lesson-4.html',parts:[{part_key:'freestyle',min_questions:3}],required_practice_count:2,doctor_course_key:'67'}]};
    if(sql.includes('class_scope'))return {rows:[{class_id:1293,class_code:'IC2304',course_id:'1'}]};
    if(sql.includes('FROM speaking_homework.assignment WHERE'))return {rows:[{id:'a',required_practice_count:2,doctor_course_key:'67'}]};
    if(sql.includes('assignment_part'))return {rows:[{part_key:'freestyle',min_questions:1}]};
    return {rows:[]};
  }};
  const result=await createIndependentSource({pool}).context({assignmentCode:cases[2][0],classCode:'IC2304'});
  assert.equal(result.template.parts[0].min_questions,1);
});
function fixture({progress=[],docs=[],known=[],active=true}={}){
  const calls=[];
  const context={template:{lesson:4},scope:{class_id:1293,course_id:'1'},member:active?{student_ref:'ref'}:null};
  const bridge=createSpeakingLegacyBridge({source:{async context(){return context;}},pool:{async query(sql,params){
    calls.push({sql,params});if(sql.includes('access_grant'))return {rows:progress};
    return {rows:sql.includes('classroom_submission_id')?docs:known};
  }},catalog:{async startSelected(i){return {accessToken:'old-token',studentRef:i.studentRef,documentId:i.documentId};}},service:{async openAssignment(){return {parts:[],assignmentStatus:'open'};}}});
  return {bridge,calls,input:{assignmentCode:cases[2][0],classCode:'IC2304',studentRef:'ref',identityConfirmed:true}};
}
test('no document or progress allows independent intake',async()=>{const f=fixture();assert.equal(await f.bridge.start(f.input),null);});
test('existing progress returns exact old document and legacy session',async()=>{const f=fixture({progress:[{document_id:'old-doc'}]});const s=await f.bridge.start(f.input);assert.equal(s.documentId,'old-doc');assert.equal(s.intakeMode,'legacy');});
test('verified Classroom document remains exact destination',async()=>{const f=fixture({docs:[{document_id:'verified-doc'}]});assert.equal((await f.bridge.start(f.input)).documentId,'verified-doc');});
test('ambiguous progress cannot create a second work unit',async()=>{const f=fixture({progress:[{document_id:'a'},{document_id:'b'}]});await assert.rejects(f.bridge.start(f.input),{code:'LEGACY_PROGRESS_CONFLICT'});});
test('unknown document can use document intake; wrong known code cannot',async()=>{const f=fixture();assert.equal(await f.bridge.open({...f.input,documentId:'new-doc'}),null);const g=fixture({known:[{assignment_code:'wrong'}]});await assert.rejects(g.bridge.open({...g.input,documentId:'known-doc'}),{code:'DOCUMENT_ASSIGNMENT_MISMATCH'});});
test('inactive member cannot resume old progress',async()=>{const f=fixture({active:false,progress:[{document_id:'old-doc'}]});await assert.rejects(f.bridge.start(f.input),{code:'STUDENT_NOT_ACTIVE'});});
test('independent service returns old session without writing work unit',async()=>{
  const session={intakeMode:'legacy',documentId:'old-doc',accessToken:'old-token'};
  const service=createIndependentSpeaking({pool:{query(sql){assert.ok(sql.startsWith('SELECT'));return {rows:[]};}},accessSecret:'x'.repeat(32),source:{legacySession:async()=>session}});
  assert.equal(await service.startSelected({assignmentCode:cases[2][0]}),session);
});


for(const legacy of [false,true])test(`late old-lesson Classroom registration keeps legacy=${legacy}`,async()=>{
  let forwarded=0,next=0;
  const pool={async query(sql){if(sql.includes('assignment_template'))return {rows:[{assignment_code:cases[2][0],page_path:'lesson-4.html',parts:[]}]};return {rows:legacy?[{id:'kept'}]:[]};}};
  const source=createIndependentSource({pool,independentBase:'http://fixture.invalid',workerSecret:'fixture',call:async()=>{forwarded++;return {status:200,json:async()=>({ok:true})};}});
  await source.forward({path:'/internal/assignments/register',method:'POST',body:{assignmentCode:cases[2][0],courseId:'1',courseWorkId:'2'}},{status(){return this;},json(){}},()=>next++);
  assert.equal(forwarded,legacy?0:1);assert.equal(next,legacy?1:0);
});
