import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createIndependentApp} from '../src/speaking-independent-server.js';

// Middleware thật, guard tổng hợp để tách lỗi admission khỏi SQL/capacity/SSO.
// Token khác nhau được kiểm trong stub; không nhận đây là native auth proof.
const ref=n=>'7500000a-0000-4000-8000-'+String(n).padStart(12,'0');
const identity=n=>({studentRef:ref(n),accessToken:('fixture'+n).padEnd(43,'x')});
async function fixture({valid=true,delay=10}={}){
 const stats={verified:0,streams:0,peak:0},held=[],control={valid};
 const observation={student:input=>({scope:{key:input.studentRef},guard:{valid:control.valid}}),teacher:input=>({scope:{key:input.classId},guard:{valid:control.valid}}),hub:{
  async readOnce(scope,guard){stats.verified++;await new Promise(resolve=>setTimeout(resolve,delay));
   if(!guard.valid)throw Object.assign(Error('INVALID_TEST_IDENTITY'),{code:'INVALID_TEST_IDENTITY',status:401});return{revision:'fixture'};},
  subscribe({send}){stats.streams++;stats.peak=Math.max(stats.peak,stats.streams);queueMicrotask(()=>send('state',{revision:'fixture',epoch:'fixture',sequence:1}));return{close(){stats.streams--;}};}
 }};
 const server=createServer(createIndependentApp({service:{pool:{query:async()=>({rows:[]})}},observation,teacherSessionCookieName:'teacher_fixture',
  teacherAdmission:async()=>({allowed:new Set(['2304']),authSource:'session',reviewer:{email:'fixture@test.invalid'}})}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port+'/api/speaking-homework-independent';
 return{stats,base,held,control,async student(n){const response=await fetch(base+'/observation/student/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(identity(n))});held.push(response);return response.status;},
  async teacher(n,suffix='',name='teacher_fixture'){const response=await fetch(base+'/teacher/progress/events?classId=2304&classCode=IC2304&code=fixture-code',{headers:{cookie:name+'='+String(n).padStart(43,'t')+suffix}});held.push(response);return response.status;},
  async close(){await Promise.all(held.map(response=>response.body?.cancel().catch(()=>{})));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 };
}
const histogram=values=>values.reduce((all,status)=>(all[status]=(all[status]||0)+1,all),{});

test('Speaking admission:200 distinct valid students behind oneIP all open streams before prior streams end',async()=>{
 const f=await fixture();try{const statuses=await Promise.all(Array.from({length:200},(_,n)=>f.student(n+1)));
  assert.deepEqual(histogram(statuses),{200:200});assert.equal(f.stats.peak,200);assert.equal(f.stats.verified,200);
 }finally{await f.close();}
});

test('Speaking admission:200 distinct valid teacher sessions behind oneIP keep separate actor budgets',async()=>{
 const f=await fixture();try{const statuses=await Promise.all(Array.from({length:200},(_,n)=>f.teacher(n+1)));
  assert.deepEqual(histogram(statuses),{200:200});assert.equal(f.stats.peak,200);assert.equal(f.stats.verified,200);
 }finally{await f.close();}
});

test('Speaking admission:random token variants cannot exceed native180 failed attempts from oneIP',async()=>{
 const f=await fixture({valid:false});try{const statuses=await Promise.all(Array.from({length:200},(_,n)=>f.student(n+1)));
  assert.deepEqual(histogram(statuses),{401:180,429:20});assert.equal(f.stats.verified,180);assert.equal(f.stats.peak,0);
  assert.equal(await f.student(201),429);assert.equal(f.stats.verified,180);
 }finally{await f.close();}
});

test('Speaking admission:one actor still has native180 requests even when successful stream charges are released',async()=>{
 const f=await fixture({delay:0});try{const statuses=[];
  for(let n=0;n<181;n++)statuses.push(await f.student(1));
  assert.deepEqual(histogram(statuses),{200:180,429:1});
 }finally{await f.close();}
});

test('Speaking admission:170 prior failures do not turn200 subsequent valid handshakes into false429',async()=>{
 const f=await fixture({valid:false});try{
  assert.deepEqual(histogram(await Promise.all(Array.from({length:170},(_,n)=>f.student(n+1)))),{401:170});
  f.control.valid=true;
  assert.deepEqual(histogram(await Promise.all(Array.from({length:200},(_,n)=>f.student(n+1001)))),{200:200});
  assert.equal(f.stats.verified,370);
 }finally{await f.close();}
});

test('Speaking admission:successful stream cancellation cannot erase previously charged failed attempts',async()=>{
 const f=await fixture({valid:false});try{
  for(let n=1;n<=5;n++)assert.equal(await f.student(n),401);
  f.control.valid=true;for(let n=6;n<=25;n++)assert.equal(await f.student(n),200);
  await Promise.all(f.held.map(response=>response.body?.cancel().catch(()=>{})));await new Promise(resolve=>setTimeout(resolve,20));
  f.control.valid=false;
  assert.deepEqual(histogram(await Promise.all(Array.from({length:200},(_,n)=>f.student(n+1001)))),{401:175,429:25});
 }finally{await f.close();}
});

test('Speaking teacher ignored cookie variations cannot reset the same native session180 budget',async()=>{
 const f=await fixture({delay:0});try{const statuses=[];for(let n=0;n<181;n++)statuses.push(await f.teacher(1,'; unrelated='+n));
  assert.deepEqual(histogram(statuses),{200:180,429:1});
 }finally{await f.close();}
});

test('Speaking teacher unknown cookie names retain the native180 guest budget instead of minting actors',async()=>{
 const f=await fixture({delay:0});try{const statuses=[];for(let n=0;n<181;n++)statuses.push(await f.teacher(n+1,'','unknown_cookie'));
  assert.deepEqual(histogram(statuses),{200:180,429:1});
 }finally{await f.close();}
});
