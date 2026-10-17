import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
const {createIndependentSource}=await import(process.env.SPEAKING_SOURCE_TEST_FILE
  ?pathToFileURL(process.env.SPEAKING_SOURCE_TEST_FILE).href:'../src/speaking-independent-source.js');

// Nguồn giả chỉ đọc: theo dõi số truy vấn và đổi danh sách giữa hai yêu cầu.
// Sai quyền/cấu hình vẫn phải bị từ chối; không có đường mạng AI/Docs/Portal.
function fixture(){
 const state={reads:0,active:true,available:true,failed:false};
 const pool={async query(sql,params){
  assert.ok(sql.trim().startsWith('SELECT'));
  if(state.failed)throw Error('SOURCE_FAILED');
  if(sql.includes('assignment_template')){
   state.reads++;await new Promise(r=>setTimeout(r,10));
   return {rows:state.available?[{assignment_code:params[0],page_path:'lesson-6.html',title:'Bài giả',parts:[],required_practice_count:0}]:[]};
  }
  if(sql.includes('class_scope'))return {rows:Array.from({length:4},(_,i)=>({class_id:i+1,class_code:'IC'+i,course_id:String(i+1)}))};
  if(sql.includes('SELECT m.public_id AS student_ref'))return {rows:state.active?[{student_ref:'fake-a',name:'Người giả A'}]:[]};
  return {rows:[]};
 }};
 return {state,service:createIndependentSource({pool})};
}
test('Speaking source · 100 lượt đọc giữ đúng bài/lớp/người, một lần đọc mẫu mỗi yêu cầu',async()=>{
 const f=fixture();
 const server=createServer(async(req,res)=>{
  try{const u=new URL(req.url,'http://fixture'),n=Number(u.searchParams.get('n'));
   const value=await f.service.context({assignmentCode:'fake-speaking',classCode:'IC'+Math.floor(n/30),studentRef:'fake-a'});
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
  }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.code||e.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const results=await Promise.all(Array.from({length:100},async(_,n)=>{
   const r=await fetch(`http://127.0.0.1:${server.address().port}/?n=${n}`);assert.equal(r.status,200);
   const value=await r.json();assert.equal(value.scope.class_code,'IC'+Math.floor(n/30));assert.equal(value.member.student_ref,'fake-a');return value;
  }));
  assert.equal(results.length,100);assert.equal(f.state.reads,100);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Speaking source · không dùng mẫu/quyền đã đọc cho yêu cầu kế tiếp',async()=>{
 const f=fixture(),input={assignmentCode:'fake-speaking',classCode:'IC0',studentRef:'fake-a'};
 await f.service.context(input);f.state.active=false;
 await assert.rejects(f.service.context(input),{code:'STUDENT_NOT_ACTIVE'});
 f.state.active=true;await assert.rejects(f.service.context({...input,classCode:'WRONG'}),{code:'CLASS_SCOPE_INVALID'});
 f.state.available=false;await assert.rejects(f.service.context(input),{code:'UNSUPPORTED_ASSIGNMENT'});
 f.state.available=true;f.state.failed=true;await assert.rejects(f.service.context(input),/SOURCE_FAILED/);
 f.state.failed=false;assert.equal((await f.service.context(input)).member.student_ref,'fake-a');
});
