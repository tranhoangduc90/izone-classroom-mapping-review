// Ported from the qualified Homework signals contract; product channel and coalescing are explicit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkSignals as createWebWorkSignals} from '../src/test-work-runtime.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fakeClock(){
 let now=0,id=0;const pending=new Map();
 return {setTimer(fn,delay){const timer={id:++id,unref(){}};pending.set(timer.id,{fn,at:now+delay});return timer;},clearTimer(timer){if(timer)pending.delete(timer.id);},
  async advance(ms){const target=now+ms;let steps=0;while(true){const next=[...pending].filter(([,t])=>t.at<=target).sort(([,a],[,b])=>a.at-b.at)[0];if(!next)break;if(++steps>100)throw Error('Timer loop');now=next[1].at;pending.delete(next[0]);next[1].fn();await settle();}now=target;await settle();}};
}
function fixture(extra={}){
 const time=fakeClock(),clients=[],queries=[],wakes=[],errors=[];
 class Client extends EventEmitter{async connect(){}async query(sql){this.listen=sql;}async end(){this.ended=(this.ended||0)+1;this.emit('end');}}
 const signals=createWebWorkSignals({channel:'test_work_v1',query:async(...args)=>{queries.push(args);},createClient:()=>{const c=new Client();clients.push(c);return c;},onWake:lane=>wakes.push(lane),onError:e=>errors.push(e),...time,...extra});
 return {signals,time,clients,queries,wakes,errors};
}

test('Work signals wake locally immediately and coalesce different lanes into one notification without identities',async()=>{
 const {signals,time,clients,queries,wakes}=fixture();await settle();
 assert.equal(clients[0].listen,'LISTEN test_work_v1');assert.equal(signals.snapshot().connected,true);
 signals.publish('state');signals.publish('state');signals.publish('docs');
 assert.deepEqual(wakes,[undefined,'state','state','docs']);assert.equal(queries.length,0);
 await time.advance(25);assert.equal(queries.length,1);
 const [channel,payload]=queries[0][1];assert.equal(channel,'test_work_v1');
 const value=JSON.parse(payload);assert.deepEqual(new Set(value.lanes),new Set(['state','docs']));assert.deepEqual(Object.keys(value).sort(),['lanes','sender','v']);
 await signals.close();assert.equal(clients[0].ended,1);
});

test('Only a valid other instance wakes a lane; own, stale, malformed or unrelated notifications are ignored',async()=>{
 const {signals,time,clients,queries,wakes}=fixture();await settle();signals.publish('docs');await time.advance(25);
 const payload=JSON.parse(queries[0][1][1]),base=wakes.length,c=clients[0];
 for(const message of [{channel:'other',payload:JSON.stringify({...payload,sender:'other'})},{channel:'test_work_v1',payload:'{'},{channel:'test_work_v1',payload:JSON.stringify(payload)},{channel:'test_work_v1',payload:JSON.stringify({...payload,sender:'other',lanes:['private-lane']})}])c.emit('notification',message);
 assert.equal(wakes.length,base);
 c.emit('notification',{channel:'test_work_v1',payload:JSON.stringify({...payload,sender:'other',lanes:['state','state']})});assert.deepEqual(wakes.slice(base),['state']);
 await signals.close();
});

test('A dropped listener reconnects and reconciles missed work; closing cancels subsequent reconnects',async()=>{
 const {signals,time,clients,wakes,errors}=fixture();await settle();
 clients[0].emit('error',Error('CONNECTION_LOST'));await settle();assert.equal(signals.snapshot().connected,false);assert.equal(errors.length,1);
 await time.advance(250);assert.equal(clients.length,2);assert.equal(signals.snapshot().connected,true);assert.deepEqual(wakes,[undefined,undefined]);
 const before=wakes.length;clients[0].emit('notification',{channel:'test_work_v1',payload:JSON.stringify({v:1,sender:'other',lanes:['docs']})});assert.equal(wakes.length,before);
 clients[1].emit('end');await signals.close();await time.advance(20000);assert.equal(clients.length,2);assert.equal(signals.snapshot().closed,true);
});

test('Publisher and logger failures cannot prevent a local wake or reject a committed operation',async()=>{
 const time=fakeClock(),wakes=[];
 class Client extends EventEmitter{async connect(){throw Error('LISTEN_FAILED');}async end(){}}
 const signals=createWebWorkSignals({channel:'test_work_v1',query:async()=>{throw Error('NOTIFY_FAILED');},createClient:()=>new Client(),onWake:lane=>wakes.push(lane),onError(){throw Error('LOGGER_FAILED');},...time});
 await settle();assert.doesNotThrow(()=>signals.publish('docs'));await time.advance(25);assert.deepEqual(wakes,['docs']);assert.equal(signals.snapshot().errors,2);
 await signals.close();await time.advance(10000);assert.equal(signals.snapshot().errors,2);
});

test('Closing during connection waits for cleanup and never starts LISTEN or publishes queued work',async()=>{
 const time=fakeClock();let release,end=0,listens=0,queries=0;
 const wait=new Promise(resolve=>release=resolve);
 class Client extends EventEmitter{connect(){return wait;}async query(){listens++;}async end(){end++;}}
 const signals=createWebWorkSignals({channel:'test_work_v1',query:async()=>{queries++;},createClient:()=>new Client(),onWake(){},...time});
 signals.publish('docs');const closing=signals.close();release();await closing;await time.advance(10000);assert.deepEqual({end,listens,queries},{end:1,listens:0,queries:0});
});

test('An initial client construction failure remains observable and retries without an unhandled rejection',async()=>{
 const time=fakeClock();let calls=0;
 class Client extends EventEmitter{async connect(){}async query(){}async end(){}}
 const signals=createWebWorkSignals({channel:'test_work_v1',query:async()=>{},createClient(){if(++calls===1)throw Error('CLIENT_UNAVAILABLE');return new Client();},onWake(){},...time});
 await settle();assert.equal(signals.snapshot().errors,1);await time.advance(250);assert.equal(signals.snapshot().connected,true);assert.equal(calls,2);await signals.close();
});
