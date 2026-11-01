import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTestObservationHub} from '../src/test-state-runtime.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fakeClock(){let now=0,id=0;const timers=new Map();return{setTimer(fn,delay){const t={id:++id,unref(){}};timers.set(t.id,{fn,at:now+delay});return t;},clearTimer(t){if(t)timers.delete(t.id);},async advance(ms){const end=now+ms;let n=0;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort(([,a],[,b])=>a.at-b.at)[0];if(!next)break;if(++n>100)throw Error('STATE_TIMER_LOOP');now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();}now=end;await settle();}};}
function setup(options={}){
 const time=fakeClock(),sessions=new Map([['A',{email:'A'}],['B',{email:'B'}]]),states=new Map([['one',{revision:1}],['two',{revision:1}]]);let reads=0;
 const hub=createTestObservationHub({read:async()=>{reads++;return{sessions:new Map(sessions),states:new Map(states)};},...time,...options});
 const guard=(hash,key=hash)=>({hash,key,verify:async row=>row,assertCurrent:row=>{if(row.email!==hash)throw Object.assign(Error('REVOKED'),{status:401,code:'REVOKED'});},state:base=>base});
 return{hub,time,sessions,states,guard,get reads(){return reads;}};
}
test('Thirty watchers share one read and guard per scope; unchanged fallback scans never repeat frames',async()=>{
 const f=setup(),frames=[];let checks=0;
 for(let n=0;n<30;n++){const key=n%2?'one':'two',guard=f.guard(n%2?'A':'B');guard.verify=async row=>{checks++;return row;};f.hub.subscribe({scope:{key},guard,send:(event,value)=>frames.push({event,value})});}
 await f.time.advance(0);assert.equal(f.reads,1);assert.equal(checks,2);assert.equal(frames.length,30);
 await f.time.advance(29999);assert.equal(f.reads,1);await f.time.advance(1);assert.equal(f.reads,2);assert.equal(frames.length,30);
 f.states.set('one',{revision:2});for(let n=0;n<20;n++)f.hub.wake();await f.time.advance(0);assert.equal(f.reads,3);assert.equal(frames.length,45);await f.hub.close();
});
test('A slow permission source never holds another group; late verification rechecks current session identity',async()=>{
 const f=setup(),a=[],b=[];let release;const delayed=new Promise(r=>release=r),guard=f.guard('A');guard.verify=()=>delayed;
 f.hub.subscribe({scope:{key:'one'},guard,send:(event,value)=>a.push({event,value})});f.hub.subscribe({scope:{key:'two'},guard:f.guard('B'),send:(event,value)=>b.push({event,value})});
 await f.time.advance(0);assert.equal(a.length,0);assert.equal(b.length,1);
 f.sessions.set('A',{email:'changed-owner'});f.states.set('two',{revision:2});f.hub.wake();await f.time.advance(0);assert.equal(b.length,2);
 release({email:'A'});await settle();assert.equal(a.length,1);assert.equal(a[0].event,'access_revoked');assert.equal(f.hub.snapshot().connections,1);await f.hub.close();
});
test('Session revocation closes only its watchers; transient errors recover without publishing empty state',async()=>{
 let down=false;const f=setup({read:async()=>{if(down)throw Object.assign(Error('DB_DOWN'),{code:'DB_DOWN',status:503});return{sessions:f.sessions,states:f.states};}}),a=[],b=[];
 f.hub.subscribe({scope:{key:'one'},guard:f.guard('A'),send:(event,value)=>a.push({event,value})});f.hub.subscribe({scope:{key:'two'},guard:f.guard('B'),send:(event,value)=>b.push({event,value})});
 await f.time.advance(0);down=true;f.hub.wake();await f.time.advance(0);assert.equal(a.at(-1).event,'unavailable');assert.equal(a.filter(row=>row.event==='state').length,1);
 down=false;f.sessions.delete('A');f.hub.wake();await f.time.advance(0);assert.equal(a.at(-1).event,'access_revoked');assert.equal(b.at(-1).event,'state');assert.equal(f.hub.snapshot().connections,1);await f.hub.close();
});
test('Concurrent one-shot reads join the shared scan, abort cleans up, and close rejects pending reads',async()=>{
 const f=setup(),a=f.hub.readOnce({key:'one'},f.guard('A')),b=f.hub.readOnce({key:'two'},f.guard('B'));await f.time.advance(0);assert.equal((await a).revision.length,64);await b;assert.equal(f.reads,1);assert.equal(f.hub.snapshot().connections,0);
 const controller=new AbortController(),aborted=f.hub.readOnce({key:'one'},f.guard('A'),{signal:controller.signal});controller.abort();await assert.rejects(aborted);assert.equal(f.hub.snapshot().connections,0);
 const pending=f.hub.readOnce({key:'two'},f.guard('B')),rejected=assert.rejects(pending,{code:'STATE_UNAVAILABLE'});await f.hub.close();await rejected;
});
test('Authorization errors with a reused code still revoke after an earlier temporary failure',async()=>{
 let status=503;const f=setup(),frames=[],guard=f.guard('A');guard.verify=async()=>{throw Object.assign(Error('SOURCE'),{status,code:'SOURCE'});};
 f.hub.subscribe({scope:{key:'one'},guard,send:(event,value)=>frames.push({event,value})});await f.time.advance(0);assert.equal(frames[0].event,'unavailable');
 status=403;f.hub.wake();await f.time.advance(0);assert.equal(frames[1].event,'access_revoked');assert.equal(f.hub.snapshot().connections,0);await f.hub.close();
});
test('Standalone observation adapters exactly match their canonical pinned dependencies',async()=>{
 for(const name of ['test-state-runtime.js','test-practice-observation.js'])for(const product of ['reading-practice','listening-practice'])assert.deepEqual(await readFile(new URL('../src/'+name,import.meta.url)),await readFile(new URL('../../products/'+product+'/src/'+name,import.meta.url)));
});
