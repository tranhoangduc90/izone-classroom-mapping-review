import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {createIndependentSpeaking}=await import(process.env.SPEAKING_LOGIN_SERVICE_FILE
  ?pathToFileURL(process.env.SPEAKING_LOGIN_SERVICE_FILE).href:'../src/speaking-independent.js');
const ref='11111111-1111-4111-8111-111111111111';

// Nguồn giả chỉ đọc, đổi quyền/cấu hình được giữa các lượt để kiểm độ mới và lỗi.
function fixture(lesson=4){
 const state={calls:0,active:true,broken:false,duplicate:false,status:'open'};
 const source={async context(input){
  state.calls++;await new Promise(r=>setTimeout(r,15));
  if(state.broken)throw Error('Nguồn tạm lỗi');
  const classes=Array.from({length:4},(_,i)=>({class_code:'IC990'+i,class_id:i+1}));
  const matched=input.classCode==='IC9900'||(state.duplicate&&input.classCode==='IC9901');
  return {template:{lesson,assignmentCode:input.assignmentCode,assignmentStatus:state.status},classes,
   scope:classes.find(c=>c.class_code===input.classCode),students:state.active&&matched?[{student_ref:ref,name:'Học viên giả A'}]:[]};
 }};
 const service=createIndependentSpeaking({pool:{query(){throw Error('Không được ghi database trong phép kiểm đăng nhập');}},source,accessSecret:'fixture-only-speaking-secret-at-least-32'});
 return{service,state,source};
}
for(const lesson of [4,8])test(`Lesson ${lesson}: tìm UUID giữ đủ khớp nhiều lớp, không đọc lại cùng lớp`,async()=>{
 const f=fixture(lesson),assignmentCode='fixture-speaking-'+lesson;
 assert.deepEqual(await f.service.resolveIdentity({assignmentCode,studentRef:ref}),{status:'unique',classCode:'IC9900'});
 assert.equal(f.state.calls,5,'Chỉ đọc danh mục một lần và mỗi lớp một lần');
 f.state.duplicate=true;assert.deepEqual(await f.service.resolveIdentity({assignmentCode,studentRef:ref}),{status:'ambiguous'});
 f.state.active=false;assert.deepEqual(await f.service.resolveIdentity({assignmentCode,studentRef:ref}),{status:'missing'});
});
test('100 học viên tải cùng bài dùng chung đọc đang chờ; yêu cầu sau đọc lại',async()=>{
 const f=fixture(),assignmentCode='fixture-speaking',input={assignmentCode,studentRef:ref};
 const results=await Promise.all(Array.from({length:100},()=>Promise.all([f.service.classes({assignmentCode}),f.service.resolveIdentity(input)])));
 assert.ok(results.every(([classes,identity])=>classes.length===4&&identity.classCode==='IC9900'));
 assert.equal(f.state.calls,5);
 f.state.active=false;assert.deepEqual(await f.service.resolveIdentity(input),{status:'missing'});assert.equal(f.state.calls,10);
 f.state.status='closed';const classes=await f.service.classes({assignmentCode});assert.ok(classes.every(c=>!c.ready&&c.assignmentStatus==='closed'));
});
test('Bài khác không dùng chung kết quả; lỗi không giữ lại cho lần sau',async()=>{
 const f=fixture(8);const values=await Promise.all(['one','two'].map(assignmentCode=>f.service.roster({assignmentCode,classCode:'IC9900'})));
 assert.deepEqual(values.map(v=>v.assignmentCode),['one','two']);assert.equal(f.state.calls,2);
 f.state.broken=true;await assert.rejects(f.service.classes({assignmentCode:'one'}),/Nguồn tạm lỗi/);
 f.state.broken=false;assert.equal((await f.service.classes({assignmentCode:'one'})).length,4);
});
