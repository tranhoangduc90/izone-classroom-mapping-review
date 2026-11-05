import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {withSpeakingProviderJournal,withSpeakingProviderPart,beginSpeakingProviderRequest,speakingProviderCall} from '../src/speaking-provider-journal.js';

test('provider calls preserve real HTTP response and error, expose only safe request metadata',async t=>{
 const server=createServer((req,res)=>{res.writeHead(429,{'Content-Type':'application/json'});res.end('{"private":"not in log"}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const rows=[];let actual;
 const response=await withSpeakingProviderJournal(e=>rows.push(e),()=>speakingProviderCall('check_ai',async(...args)=>actual=await fetch(...args))(
  `http://127.0.0.1:${server.address().port}/private?token=secret`,{method:'POST',body:'private prompt',headers:{authorization:'secret'}}));
 assert.equal(response,actual);assert.equal(response.status,429);assert.deepEqual(await response.json(),{private:'not in log'});
 assert.deepEqual(rows.map(e=>e.data.phase),['started','headers']);assert.equal(rows[1].data.httpStatus,429);
 assert.equal(rows[0].data.requestOrdinal,rows[1].data.requestOrdinal);assert.ok(rows[1].data.durationMs>=0);
 assert.ok(rows.every(e=>!JSON.stringify(e).match(/private|secret|authorization|127\.0\.0\.1/)));
 const error=Object.assign(new Error('private network message'),{code:'ECONNRESET'});
 await assert.rejects(withSpeakingProviderJournal(e=>rows.push(e),()=>speakingProviderCall('share_gateway',async()=>{throw error;},{attempt:2,reason:'retry'})()),e=>e===error);
 assert.equal(rows.at(-1).data.errorCode,'ECONNRESET');assert.equal(rows.at(-1).data.phase,'failed');
 assert.equal(rows.at(-1).data.reason,'retry');assert.equal(rows.at(-1).data.attempt,2);
});

test('parallel worker contexts and late registered requests retain their own claim',async()=>{
 const left=[],right=[];let release;const gate=new Promise(r=>{release=r;});
 let late;
 await Promise.all([
  withSpeakingProviderJournal(e=>left.push(e),async()=>{
   late=speakingProviderCall('doctor_ai',async()=>{await gate;return{status:200};})();
   await speakingProviderCall('share_direct',async()=>({status:302}),{reason:'redirect'})();
  }),
  withSpeakingProviderJournal(e=>right.push(e),async()=>{
   await delay(1);await speakingProviderCall('check_ai',async()=>({status:503}),{attempt:2,reason:'correction'})();
  }),
 ]);
 release();await late;
 assert.deepEqual(left.filter(e=>e.data.phase==='started').map(e=>e.data.requestOrdinal),[1,2]);
 assert.deepEqual(right.map(e=>e.data.requestOrdinal),[1,1]);assert.ok(right.every(e=>e.data.route==='check_ai'));
 assert.equal(left.at(-1).data.route,'doctor_ai');assert.equal(left.at(-1).data.requestOrdinal,1);
});

test('off or failed logging leaves native results, call count and settlement unchanged',async()=>{
 let calls=0;const response={status:200},call=async()=>{calls++;return response;};
 assert.equal(await withSpeakingProviderJournal(undefined,()=>speakingProviderCall('check_ai',call)()),response);
 for(const observer of [()=>{throw Error('logger failed');},()=>Promise.reject(Error('logger failed'))])
  assert.equal(await withSpeakingProviderJournal(observer,()=>speakingProviderCall('check_ai',call)()),response);
 assert.equal(calls,3);await delay(0);
 const rows=[];
 withSpeakingProviderJournal(e=>rows.push(e),()=>{
  const request=beginSpeakingProviderRequest('share_direct');request.headers(200);request.failed(Error('late'));request.headers(503);
 });
 assert.equal(rows.length,2);assert.equal(rows[1].data.httpStatus,200);
});

test('unknown status and transport errors stay unknown without copying arbitrary messages',async()=>{
 const rows=[];
 await withSpeakingProviderJournal(e=>rows.push(e),async()=>{
  assert.equal(await speakingProviderCall('doctor_ai',async()=>undefined)(),undefined);
  const error=new Error('token=do-not-log');await assert.rejects(speakingProviderCall('check_ai',async()=>{throw error;})(),e=>e===error);
 });
 assert.equal(rows[1].data.phase,'outcome_unknown');assert.equal(rows[1].data.errorCode,'PROVIDER_STATUS_UNKNOWN');
 assert.equal(rows[3].data.errorCode,'PROVIDER_TRANSPORT_FAILED');assert.ok(!JSON.stringify(rows).includes('do-not-log'));
});

test('parallel Doctor parts share the job counter without leaking part or changing response getters',async()=>{
 const rows=[],response={get status(){throw Error('native getter');}};
 await withSpeakingProviderJournal(e=>rows.push(e),()=>Promise.all(['part_1','part_2'].map(part=>
  withSpeakingProviderPart(part,()=>speakingProviderCall('doctor_ai',async()=>response)()))));
 assert.deepEqual(rows.filter(e=>e.data.phase==='started').map(e=>[e.data.part,e.data.requestOrdinal]),[['part_1',1],['part_2',2]]);
 assert.ok(rows.filter(e=>e.data.phase!=='started').every(e=>e.data.phase==='outcome_unknown'));
 assert.equal(await speakingProviderCall('doctor_ai',async()=>response)(),response);
});
