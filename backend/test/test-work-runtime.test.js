import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDurableWorkLoop,markWorkReady,finishWorkTransaction,registerWorkPublisher,announceCommittedWork} from '../src/test-work-runtime.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let release;const promise=new Promise(r=>release=r);return{promise,release};};
function fakeClock(){
 let now=0,id=0;const timers=new Map();
 return{clock:()=>now,setTimer(fn,delay){const t={id:++id,unref(){}};timers.set(t.id,{fn,at:now+delay});return t;},clearTimer(t){if(t)timers.delete(t.id);},
  async advance(ms){const end=now+ms;let steps=0;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort(([,a],[,b])=>a.at-b.at)[0];if(!next)break;if(++steps>100)throw Error('UNBOUNDED_TIMER_LOOP');now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();}now=end;await settle();}};
}
test('A fast job refills its free slot while a slower peer remains in flight, without exceeding capacity',async()=>{
 const time=fakeClock(),jobs=['A','B','C'],running=new Map(),done=new Map(jobs.map(id=>[id,gate()])),starts=[];let maximum=0;
 const loop=createDurableWorkLoop({claim:async n=>jobs.splice(0,n),capacity:2,scanMs:1000,...time,run:async id=>{starts.push(id);running.set(id,true);maximum=Math.max(maximum,running.size);await done.get(id).promise;running.delete(id);}});
 await time.advance(0);assert.deepEqual(starts,['A','B']);done.get('B').release();await settle();await time.advance(0);
 assert.deepEqual(starts,['A','B','C']);assert.equal(maximum,2);assert.deepEqual([...running.keys()],['A','C']);
 const closing=loop.close();done.get('A').release();done.get('C').release();await closing;assert.equal(loop.snapshot().completed,3);
});
test('Empty scans preserve the fallback deadline and a burst of hints shares one admission scan',async()=>{
 const time=fakeClock();let scans=0;const loop=createDurableWorkLoop({claim:async()=>{scans++;return[];},run:async()=>{},scanMs:1000,...time});
 await time.advance(0);assert.equal(scans,1);await time.advance(999);assert.equal(scans,1);await time.advance(1);assert.equal(scans,2);
 for(let i=0;i<20;i++)loop.wake();await time.advance(0);assert.equal(scans,3);await loop.close();await time.advance(10000);assert.equal(scans,3);
});
test('Docs pacing keeps its cooldown even when another committed job wakes the loop',async()=>{
 const time=fakeClock(),jobs=['A','B'],started=[];
 const loop=createDurableWorkLoop({claim:async n=>jobs.splice(0,n),run:async id=>started.push([id,time.clock()]),cooldownMs:1000,scanMs:1000,...time});
 await time.advance(0);loop.wake();await time.advance(999);assert.deepEqual(started,[['A',0]]);await time.advance(1);assert.deepEqual(started,[['A',0],['B',1000]]);await loop.close();
});
test('Closing during a native claim drains the bounded owned batch and never starts a fresh claim',async()=>{
 const time=fakeClock(),claim=gate(),job=gate();let scans=0,started=0,closed=false;
 const loop=createDurableWorkLoop({claim:()=>{scans++;return claim.promise;},run:async()=>{started++;await job.promise;},...time});await time.advance(0);
 const closing=loop.close().then(()=>closed=true);claim.release(['owned']);await settle();assert.equal(started,1);assert.equal(closed,false);job.release();await closing;await time.advance(10000);assert.equal(scans,1);
});
test('A claim failure and a throwing logger preserve fallback processing',async()=>{
 const time=fakeClock();let claims=0,runs=0;
 const loop=createDurableWorkLoop({claim:async()=>{if(++claims===1)throw Error('DB_UNAVAILABLE');return claims===2?['durable']:[];},run:async()=>runs++,onError(){throw Error('LOGGER_UNAVAILABLE');},...time});
 await time.advance(0);assert.equal(runs,0);await time.advance(1000);assert.equal(runs,1);assert.equal(loop.snapshot().errors,1);await loop.close();
});
test('Only marked committed transactions publish; rollback, duplicate finish and notifier failures cannot change the result',()=>{
 const pool={},client={},sent=[],detach=registerWorkPublisher(pool,lane=>sent.push(lane));
 markWorkReady(client);finishWorkTransaction(pool,client,false);assert.deepEqual(sent,[]);
 markWorkReady(client);markWorkReady(client);markWorkReady(client,'state');finishWorkTransaction(pool,client,true);finishWorkTransaction(pool,client,true);assert.deepEqual(sent,['docs','state']);
 detach();announceCommittedWork(pool);const stop=registerWorkPublisher(pool,()=>{throw Error('NOTIFY_FAILED');});markWorkReady(client);assert.doesNotThrow(()=>finishWorkTransaction(pool,client,true));stop();
});
test('Both standalone runtime copies exactly match the canonical dependency',async()=>{
 const canonical=await readFile(new URL('../src/test-work-runtime.js',import.meta.url));
 for(const product of ['reading-practice','listening-practice'])assert.deepEqual(await readFile(new URL('../../products/'+product+'/src/test-work-runtime.js',import.meta.url)),canonical);
});
