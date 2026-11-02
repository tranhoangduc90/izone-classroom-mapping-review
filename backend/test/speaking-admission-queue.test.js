import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import express from 'express';
import {createSpeakingAdmission} from '../src/speaking-admission.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const end=Date.now()+3000;while(Date.now()<end){if(predicate())return;await wait(5);}throw Error('Admission queue fixture deadline');}
async function fixture(options={}){
 const app=express(),held=[],parsed=[];app.set('trust proxy',1);
 const admission=createSpeakingAdmission({message:{ok:false,error:'RATE_LIMITED'},concurrency:1,maxQueuedPerIp:1,maxQueued:2,queueWaitMs:100,...options});
 app.use(admission);app.use(express.json({limit:'2mb',verify(_req,_res,buffer){parsed.push(buffer.length);}}));
 app.get('/hold',(req,res)=>held.push({req,res}));app.post('/echo',(req,res)=>res.json({value:req.body.value}));
 const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 return{admission,held,parsed,base,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
test('Speaking admission queue is bounded, times out with503 and does not parse waiting/overflow JSON bodies',async()=>{
 const f=await fixture(),controller=new AbortController();const first=fetch(f.base+'/hold',{signal:controller.signal}).catch(error=>error);
 try{
  await until(()=>f.held.length===1);const queued=fetch(f.base+'/echo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:'x'.repeat(200000)})});
  await until(()=>f.admission.snapshot().queued===1);
  const overflow=await fetch(f.base+'/echo',{method:'POST',headers:{'content-type':'application/json'},body:'{"value":"overflow"}'});
  assert.equal(overflow.status,503);assert.equal(overflow.headers.get('retry-after'),'1');assert.equal((await overflow.json()).error,'OBSERVATION_BUSY');assert.deepEqual(f.parsed,[]);
  const expired=await queued;assert.equal(expired.status,503);await expired.body.cancel();assert.deepEqual(f.parsed,[]);
  assert.deepEqual(f.admission.snapshot(),{ips:1,queued:0,active:1});controller.abort();await first;
  await until(()=>f.admission.snapshot().ips===0);
  const recovered=await fetch(f.base+'/echo',{method:'POST',headers:{'content-type':'application/json'},body:'{"value":"recovered"}'});
  assert.deepEqual(await recovered.json(),{value:'recovered'});assert.equal(f.parsed.length,1);await until(()=>f.admission.snapshot().ips===0);
 }finally{controller.abort();await first;await f.close();}
});

test('Speaking admission cancels a queued request and a slowIP does not block anotherIP',async()=>{
 const f=await fixture({queueWaitMs:2000}),active=new AbortController(),queued=new AbortController();
 const first=fetch(f.base+'/hold',{signal:active.signal,headers:{'x-forwarded-for':'127.0.0.1'}}).catch(error=>error);let second;
 try{
  await until(()=>f.held.length===1);
  second=fetch(f.base+'/echo',{method:'POST',signal:queued.signal,headers:{'content-type':'application/json','x-forwarded-for':'127.0.0.1'},body:'{"value":"cancelled"}'}).catch(error=>error);
  await until(()=>f.admission.snapshot().queued===1);queued.abort();await second;await until(()=>f.admission.snapshot().queued===0);
  const other=await fetch(f.base+'/echo',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'127.0.0.2'},body:'{"value":"otherIP"}'});
  assert.deepEqual(await other.json(),{value:'otherIP'});assert.equal(f.held[0].res.writableEnded,false);assert.equal(f.parsed.length,1);
  active.abort();await first;await until(()=>f.admission.snapshot().ips===0);
 }finally{active.abort();queued.abort();await first;await second;await f.close();}
});
