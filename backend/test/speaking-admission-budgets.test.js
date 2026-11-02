import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createIndependentApp} from '../src/speaking-independent-server.js';

// Chỉ kiểm ngân sách HTTP native với service tổng hợp, không phải auth/capacity.
async function fixture(){
 let calls=0;
 const service={pool:{query:async()=>({rows:[]})},classes:async()=>{calls++;return[];},open:async input=>{calls++;return{unitId:input.studentRef};}};
 const server=createServer(createIndependentApp({service}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/speaking-homework-independent';
 return{get calls(){return calls;},async guest(){const response=await fetch(base+'/classes?assignmentCode=fixture-code');await response.arrayBuffer();return response.status;},
  async actor(n){const response=await fetch(base+'/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
   studentRef:'7500000b-0000-4000-8000-'+String(n).padStart(12,'0'),accessToken:('fixture'+n).padEnd(43,'x')})});
   await response.arrayBuffer();return response.status;},
  async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

test('Speaking admission keeps native180 guest requests perIP when successful reads release failed-attempt charges',async()=>{
 const f=await fixture();try{for(let n=0;n<180;n++)assert.equal(await f.guest(),200);assert.equal(await f.guest(),429);assert.equal(f.calls,180);}
 finally{await f.close();}
});

test('Speaking admission retains native5400 total requests perIP across distinct actors in one accounting window',async t=>{
 // Giữ đúng tiền đề một cửa sổ quota. CPU fixture0.25 có thể cần hơn60s cho5400
 // HTTP thật; chỉ giả Date, không giả HTTP, timer hàng chờ hoặc giới hạn native.
 const started=performance.now();t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture();try{
  for(let offset=0;offset<5400;offset+=100){const results=await Promise.all(Array.from({length:Math.min(100,5400-offset)},(_,index)=>f.actor(Math.floor((offset+index)/180)+1)));
   assert.ok(results.every(status=>status===200),'Native request budget unexpectedly rejected before5400');}
  assert.equal(f.calls,5400);assert.equal(await f.actor(31),429);assert.equal(f.calls,5400);
 }finally{await f.close();t.mock.timers.reset();t.diagnostic('Fixed accounting window; actual HTTP elapsedMs='+Math.round(performance.now()-started));}
});
