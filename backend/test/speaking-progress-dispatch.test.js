import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeakingProgressDispatcher,createSpeakingProgressDocsWorker} from '../src/speaking-progress-docs.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fakeClock(){
 let now=0,id=0;const timers=new Map();
 return{clock:()=>now,setTimer(fn,delay){const timer={id:++id,unref(){}};timers.set(timer.id,{fn,at:now+delay});return timer;},clearTimer(timer){if(timer)timers.delete(timer.id);},
  async advance(ms){const end=now+ms;let steps=0;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort(([,a],[,b])=>a.at-b.at)[0];if(!next)break;if(++steps>100)throw Error('UNBOUNDED_PROGRESS_LOOP');now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();}now=end;await settle();}};
}

test('Speaking Docs hints share one empty scan and the durable fallback survives a missing hint',async()=>{
 const time=fakeClock();let scans=0;
 const worker=createSpeakingProgressDispatcher({worker:{async once(){scans++;return false;}},...time});
 try{await time.advance(0);assert.equal(scans,1);for(let n=0;n<30;n++)worker.wake();await time.advance(0);assert.equal(scans,2);await time.advance(1999);assert.equal(scans,2);await time.advance(1);assert.equal(scans,3);}finally{await worker.stop();}
 await time.advance(10000);assert.equal(scans,3);
});

test('Speaking Docs stays serial and repeated hints cannot bypass its native four-item burst cooldown',async()=>{
 const time=fakeClock(),first=gate(),started=[];let remaining=8,active=0,maximum=0;
 const worker=createSpeakingProgressDispatcher({worker:{async once(){if(!remaining)return false;remaining--;maximum=Math.max(maximum,++active);started.push(time.clock());if(started.length===1)await first.promise;active--;return true;}},...time});
 try{await time.advance(0);assert.equal(active,1);for(let n=0;n<20;n++)worker.wake();await time.advance(0);assert.equal(started.length,1);first.resolve();await settle();await time.advance(0);assert.deepEqual(started,[0,0,0,0]);
  for(let n=0;n<10;n++)worker.wake();await time.advance(1000);worker.wake();await time.advance(999);assert.equal(started.length,4);await time.advance(1);assert.deepEqual(started,[0,0,0,0,2000,2000,2000,2000]);assert.equal(maximum,1);
 }finally{first.resolve();await worker.stop();}
});

test('An empty Speaking Docs scan does not reset the remaining burst allowance',async()=>{
 const time=fakeClock(),started=[];let remaining=2;
 const worker=createSpeakingProgressDispatcher({worker:{async once(){if(!remaining)return false;remaining--;started.push(time.clock());return true;}},...time});
 try{await time.advance(0);assert.equal(started.length,2);remaining=5;worker.wake();await time.advance(0);assert.equal(started.length,4);worker.wake();await time.advance(1999);assert.equal(started.length,4);await time.advance(1);assert.equal(started.length,7);}finally{await worker.stop();}
});

test('Speaking Docs shutdown waits for its in-flight write and starts no further document',async()=>{
 const time=fakeClock(),pending=gate();let starts=0,closed=false;
 const worker=createSpeakingProgressDispatcher({worker:{async once(){starts++;await pending.promise;return true;}},...time});
 await time.advance(0);const closing=worker.stop().then(()=>closed=true);assert.equal(closed,false);worker.wake();pending.resolve();await closing;await time.advance(10000);assert.equal(starts,1);assert.equal(worker.snapshot().closed,true);
});

test('Speaking Docs admission failure and a throwing logger retain fallback processing',async()=>{
 const time=fakeClock();let attempts=0;
 const worker=createSpeakingProgressDispatcher({worker:{async once(){if(++attempts===1)throw Error('DB_UNAVAILABLE');return false;}},onError(){throw Error('LOGGER_FAILED');},...time});
 try{await time.advance(0);assert.equal(worker.snapshot().errors,1);await time.advance(2000);assert.equal(attempts,2);}finally{await worker.stop();}
});

test('Disabled Speaking Docs never scans even after wake or elapsed fallback',async()=>{
 const time=fakeClock();let calls=0;
 const worker=createSpeakingProgressDispatcher({worker:{once(){calls++;}},enabled:false,...time});worker.wake();await time.advance(10000);await worker.stop();assert.equal(calls,0);
});

test('A failed Speaking Docs claim destroys its borrowed connection so a possible session lock cannot leak',async()=>{
 const released=[],pool={async query(){return{rows:[{present:true}]};},async connect(){return{async query(){throw Error('CLAIM_TRANSPORT_LOST');},release:value=>released.push(value)};}};
 const worker=createSpeakingProgressDocsWorker({pool,schema:'speaking_independent',gateway:{}});
 await assert.rejects(worker.claim(),/CLAIM_TRANSPORT_LOST/);assert.deepEqual(released,[true]);
});

test('An unlock failure destroys the Speaking Docs connection after preserving its durable retry',async()=>{
 const released=[],queries=[],pool={async query(){return{rows:[{present:true}]};},async connect(){return{async query(sql){queries.push(sql);if(sql.includes('WITH candidate'))return{rows:[{unit_id:'fixture-unit',document_id:'fixture-doc',locked_document_id:'fixture-doc',lock_acquired:true,attempts:1,sequence:'1'}]};if(sql.includes('pg_advisory_unlock'))throw Error('UNLOCK_TRANSPORT_LOST');return{rows:[]};},release:value=>released.push(value)};}};
 const worker=createSpeakingProgressDocsWorker({pool,schema:'speaking_independent',gateway:{get(){throw Error('GOOGLE_UNAVAILABLE');}}}),[job]=await worker.claim();
 await assert.rejects(worker.run(job),/UNLOCK_TRANSPORT_LOST/);assert.deepEqual(released,[true]);assert.ok(queries.some(sql=>sql.includes('available_at=now()+')));await assert.rejects(worker.run(job),/DOC_PROGRESS_CLAIM_INVALID/);
});

test('Speaking Docs rejects forged work, a different schema and capacity above its native one writer',async()=>{
 const worker=createSpeakingProgressDocsWorker({pool:{},schema:'speaking_independent',gateway:null});
 assert.deepEqual(await worker.claim(),[]);await assert.rejects(worker.claim(2),/DOC_PROGRESS_CAPACITY_INVALID/);await assert.rejects(worker.run({}),/DOC_PROGRESS_CLAIM_INVALID/);
 assert.throws(()=>createSpeakingProgressDocsWorker({pool:{},schema:'learning',gateway:{}}),/DOC_PROGRESS_SCOPE_INVALID/);
});
