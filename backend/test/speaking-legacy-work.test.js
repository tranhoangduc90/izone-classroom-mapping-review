import test from 'node:test';
import assert from 'node:assert/strict';
import {startSpeakingLegacyWorker} from '../src/speaking-legacy-work.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fakeClock(){let now=0,id=0;const timers=new Map();return{clock:()=>now,setTimer(fn,delay){const t={id:++id,unref(){}};timers.set(t.id,{fn,at:now+delay});return t;},clearTimer(t){if(t)timers.delete(t.id);},async advance(ms){const end=now+ms;let steps=0;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort(([,a],[,b])=>a.at-b.at)[0];if(!next)break;if(++steps>100)throw Error('LEGACY_WORK_TIMER_LOOP');now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();}now=end;await settle();}};}
function dispatcherFixture(){
 const time=fakeClock(),queues=Object.fromEntries(['check','doctor','practice','grade'].map(lane=>[lane,[]])),gates=new Map(),started=[],claims=[],active={check:0,doctor:0,practice:0,grade:0},max={...active};
 function add(lane,id,kind){const job={lane,job_id:id,...(kind?{work_kind:kind}:{})};queues[lane].push(job);gates.set(id,gate());return job;}
 const service={async claimWorkerJobs(free,options){claims.push({free:{...free},options});const jobs=[];for(const lane of Object.keys(queues)){if(lane==='practice'&&free.practice){const preferred=options.practiceAnalysisFirst?'practice_analysis':'practice_check',index=queues.practice.findIndex(job=>job.work_kind===preferred);if(queues.practice.length)jobs.push(...queues.practice.splice(Math.max(0,index),1));}else jobs.push(...queues[lane].splice(0,free[lane]));}return jobs;}};
 const handlers=Object.fromEntries(Object.keys(queues).map(lane=>[lane,async(_service,job)=>{started.push(job);max[lane]=Math.max(max[lane],++active[lane]);try{await gates.get(job.job_id).promise;}finally{active[lane]--;}}]));
 return{time,add,gates,started,claims,active,max,service,handlers,async stop(worker){for(const pending of gates.values())pending.resolve();await worker.stop();}};
}

test('One legacy admission loop preserves check4/Doctor2/practice1/grade1 and refills only the released native slot',async()=>{
 const f=dispatcherFixture();for(const [lane,n]of Object.entries({check:6,doctor:3,practice:2,grade:2}))for(let i=0;i<n;i++)f.add(lane,lane+i,lane==='practice'?'practice_check':null);
 const worker=startSpeakingLegacyWorker({service:f.service,dependencies:{handlers:f.handlers},loopOptions:f.time});
 try{await f.time.advance(0);assert.deepEqual(f.active,{check:4,doctor:2,practice:1,grade:1});assert.equal(f.claims.length,1);f.gates.get('check1').resolve();await settle();await f.time.advance(0);assert.equal(f.started.at(-1).job_id,'check4');assert.deepEqual(f.max,{check:4,doctor:2,practice:1,grade:1});assert.deepEqual(f.claims.at(-1).free,{check:1,doctor:0,practice:0,grade:0});assert.ok(!f.started.some(job=>job.job_id==='doctor2'));}finally{await f.stop(worker);}
});

test('A fully occupied legacy worker makes no extra SQL admission call on fallback scans or wake bursts',async()=>{
 const f=dispatcherFixture();for(const [lane,n]of Object.entries({check:4,doctor:2,practice:1,grade:1}))for(let i=0;i<n;i++)f.add(lane,lane+i,lane==='practice'?'practice_check':null);
 const worker=startSpeakingLegacyWorker({service:f.service,dependencies:{handlers:f.handlers},loopOptions:f.time});
 try{await f.time.advance(0);for(let i=0;i<30;i++)worker.wake();await f.time.advance(15000);assert.equal(f.claims.length,1);assert.equal(f.started.length,8);}finally{await f.stop(worker);}
});

test('Legacy practice alternates check and analysis preference while keeping their shared one-worker limit',async()=>{
 const f=dispatcherFixture();f.add('practice','check-a','practice_check');f.add('practice','check-b','practice_check');f.add('practice','analysis-a','practice_analysis');f.add('practice','analysis-b','practice_analysis');
 const worker=startSpeakingLegacyWorker({service:f.service,dependencies:{handlers:f.handlers},loopOptions:f.time});
 try{await f.time.advance(0);assert.equal(f.started[0].job_id,'check-a');f.gates.get('check-a').resolve();await settle();await f.time.advance(0);assert.equal(f.started[1].job_id,'analysis-a');f.gates.get('analysis-a').resolve();await settle();await f.time.advance(0);assert.equal(f.started[2].job_id,'check-b');assert.equal(f.max.practice,1);}finally{await f.stop(worker);}
});

test('Legacy shutdown drains the batch committed during a racing admission before resolving stop',async()=>{
 const time=fakeClock(),admission=gate(),done=gate();let calls=0,started=0,closed=false;
 const worker=startSpeakingLegacyWorker({service:{async claimWorkerJobs(){calls++;return admission.promise;}},dependencies:{handlers:{check:async()=>{started++;await done.promise;}}},loopOptions:time});
 await time.advance(0);const closing=worker.stop().then(()=>closed=true);admission.resolve([{lane:'check',job_id:'owned'}]);await settle();assert.equal(started,1);assert.equal(closed,false);done.resolve();await closing;await time.advance(10000);assert.equal(calls,1);
});

test('A legacy admission failure and throwing logger preserve durable fallback processing',async()=>{
 const time=fakeClock();let calls=0;
 const worker=startSpeakingLegacyWorker({service:{async claimWorkerJobs(){if(++calls===1)throw Error('DB_UNAVAILABLE');return[];}},onError(){throw Error('LOGGER_FAILED');},loopOptions:time});
 try{await time.advance(0);assert.equal(worker.snapshot().errors,1);await time.advance(5000);assert.equal(calls,2);}finally{await worker.stop();}
});

test('Disabled legacy dispatch never asks the service for work',async()=>{
 const time=fakeClock();let calls=0;const worker=startSpeakingLegacyWorker({enabled:false,service:{claimWorkerJobs(){calls++;}},loopOptions:time});worker.wake();await time.advance(10000);await worker.stop();assert.equal(calls,0);
});

test('Malformed, duplicated and over-capacity legacy batches cannot enter a handler',async()=>{
 const samples=[[{lane:'another-product',job_id:'x'}],[{lane:'practice',job_id:'x',work_kind:'unknown'}],[{lane:'grade',job_id:'x'},{lane:'grade',job_id:'y'}],[{lane:'check',job_id:'x'},{lane:'check',job_id:'x'}]];
 for(const jobs of samples){const time=fakeClock();let starts=0;const worker=startSpeakingLegacyWorker({service:{async claimWorkerJobs(){return jobs;}},dependencies:{handlers:{check(){starts++;},grade(){starts++;},practice(){starts++;}}},loopOptions:time});await time.advance(0);await worker.stop();assert.equal(starts,0);assert.equal(worker.snapshot().errors,1);}
});

test('A legacy grade failure is retained through the native outbox failure method',async()=>{
 const time=fakeClock(),failures=[];let claimed=false;
 const worker=startSpeakingLegacyWorker({service:{async claimWorkerJobs(){if(claimed)return[];claimed=true;return[{lane:'grade',job_id:'grade-owned'}];},async completeGradeJob(){throw Error('SYNTHETIC_GRADE_FAILURE');},async failOutboxJob(value){failures.push(value);}},loopOptions:time});
 await time.advance(0);await worker.stop();assert.deepEqual(failures,[{jobId:'grade-owned',errorCode:'GRADE_ERROR'}]);assert.equal(worker.snapshot().completed,1);
});
