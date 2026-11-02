import test from 'node:test';
import assert from 'node:assert/strict';
import {startIndependentWorker} from '../src/speaking-independent-server.js';
import {withSpeakingTransaction,startSpeakingWorkCoordinator} from '../src/speaking-work-runtime.js';
import {markWorkReady,registerWorkPublisher} from '../src/test-work-runtime.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const until=async check=>{const end=performance.now()+2000;while(performance.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('SPEAKING_DISPATCH_TIMEOUT');};
test('A free Speaking slot receives its next batch job while a slow peer stays in flight',async()=>{
 const queue=Array.from({length:7},(_,n)=>({id:String(n),kind:'write_doc'})),gates=new Map(queue.map(job=>[job.id,deferred()])),started=[],claims=[];let active=0,maximum=0;
 const service={claimJob(){throw Error('SINGLE_JOB_PATH_MUST_NOT_RUN');},async claimJobs(n){claims.push(n);return queue.splice(0,n);},workerService:()=>({})};
 const worker=startIndependentWorker({service,coordinated:true,pollMs:60000,dependencies:{async writeDocument(_service,job){started.push(job.id);maximum=Math.max(maximum,++active);try{await gates.get(job.id).promise;}finally{active--;}}}});
 try{
  await until(()=>started.length===4);assert.deepEqual(claims,[4]);gates.get('1').resolve();await until(()=>started.length===5);assert.equal(started.at(-1),'4');assert.equal(active,4);assert.equal(worker.snapshot().running,4);
  gates.get('2').reject(Object.assign(Error('Synthetic failure'),{code:'SYNTHETIC_FAILURE'}));await until(()=>started.length===6);assert.equal(started.at(-1),'5');assert.equal(maximum,4);assert.ok(claims.slice(1).every(n=>n===1));
 }finally{for(const gate of gates.values())gate.resolve();await worker.stop();}
 assert.equal(maximum,4);assert.equal(worker.snapshot().closed,true);
});
test('Stopping during admission drains exactly its already-owned batch and makes no subsequent claim',async()=>{
 const admission=deferred(),started=[];let claims=0;
 const worker=startIndependentWorker({service:{claimJobs:()=>{claims++;return admission.promise;},workerService:()=>({})},coordinated:true,dependencies:{async writeDocument(_service,job){started.push(job.id);}}});
 await until(()=>claims===1);const stopped=worker.stop();admission.resolve([{id:'owned-a',kind:'write_doc'},{id:'owned-b',kind:'write_doc'}]);await stopped;assert.deepEqual(started,['owned-a','owned-b']);assert.equal(claims,1);
});
test('A disabled Speaking worker never admits work in either startup mode',async()=>{
 for(const coordinated of [false,true]){let calls=0;const worker=startIndependentWorker({service:{claimJob(){calls++;},claimJobs(){calls++;}},enabled:false,coordinated});await new Promise(resolve=>setTimeout(resolve,5));await worker.stop();assert.equal(calls,0);}
});
test('Speaking publishes only after its own commit; rollback and a failed publisher never turn a save into failure',async()=>{
 const calls=[],client={async query(sql){calls.push(sql);},release(){calls.push('RELEASE');}},pool={async connect(){return client;}},published=[];
 let detach=registerWorkPublisher(pool,lane=>published.push({lane,last:calls.at(-1)}));
 assert.equal(await withSpeakingTransaction(pool,async db=>{markWorkReady(db,'ai');return'ack';}),'ack');assert.deepEqual(published,[{lane:'ai',last:'COMMIT'}]);
 await assert.rejects(withSpeakingTransaction(pool,async db=>{markWorkReady(db,'ai');throw Error('SYNTHETIC_ROLLBACK');}),/SYNTHETIC_ROLLBACK/);assert.equal(published.length,1);
 await withSpeakingTransaction(pool,async()=>{});assert.equal(published.length,1);detach();detach=registerWorkPublisher(pool,()=>{throw Error('NOTIFIER_FAILED');});
 assert.equal(await withSpeakingTransaction(pool,async db=>{markWorkReady(db,'ai');return'committed-ack';}),'committed-ack');detach();
});
test('Speaking coordinator rejects a different product schema before opening a listener',()=>{
 assert.throws(()=>startSpeakingWorkCoordinator({schema:'learning',createClient(){throw Error('MUST_NOT_CONNECT');}}),/SPEAKING_WORK_SCOPE_INVALID/);
});
test('A second coordinator fails before constructing another listener for the same pool',()=>{
 const pool={},detach=registerWorkPublisher(pool,()=>{});let clients=0;
 try{assert.throws(()=>startSpeakingWorkCoordinator({pool,schema:'speaking_independent',worker:{},createClient(){clients++;throw Error('MUST_NOT_CONNECT');}}),/WORK_PUBLISHER_ALREADY_REGISTERED/);assert.equal(clients,0);}finally{detach();}
});
