import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createSpeakingJournalBoundary} from '../src/speaking-journal-boundary.js';

test('queue ACK is separate from Collector persistence; ambiguous ACK never proves delivery',async()=>{
 const boundary=createSpeakingJournalBoundary({transaction:async(_,work)=>work({}),journal:async row=>[
  {persisted:false,durableQueued:true},{persisted:true},{persisted:true,durableQueued:true},{persisted:false},
 ][row.n]});
 const result=await boundary.transaction({},async db=>{for(let n=0;n<4;n++)boundary.record(db,{n});return'native committed';});
 assert.equal(result,'native committed');await nextTurn();await nextTurn();
 assert.equal(boundary.snapshot().delivered,1);assert.equal(boundary.snapshot().durableQueued,1);
 assert.equal(boundary.snapshot().unknown,2);assert.equal(boundary.snapshot().pending,0);
});

test('batch results bind by unique delivery ID, including out-of-order and partial failure',async()=>{
 let batches=0;
 const journal=async()=>{throw Error('must use the batch capability');};
 journal.batch=async rows=>{batches++;assert.equal(new Set(rows.map(r=>r.deliveryId)).size,3);
  return [{deliveryId:rows[2].deliveryId,receipt:{persisted:false,durableQueued:true}},
   {deliveryId:rows[0].deliveryId,receipt:{persisted:true}}];};
 const boundary=createSpeakingJournalBoundary({transaction:async(_,work)=>work({}),journal});
 for(const owner of ['first','missing','last'])boundary.recordCommitted({owner});
 await nextTurn();await nextTurn();
 assert.equal(batches,1);assert.equal(boundary.snapshot().delivered,1);assert.equal(boundary.snapshot().durableQueued,1);
 assert.equal(boundary.snapshot().unknown,1);assert.equal(boundary.snapshot().pending,0);
});

test('a duplicate or foreign delivery ID cannot borrow a valid ACK from another item',async()=>{
 for(const foreign of [false,true]){
  let batches=0;const journal=async()=>{throw Error('must use batch');};
  journal.batch=async rows=>{batches++;return[
   {deliveryId:rows[0].deliveryId,receipt:{persisted:true}},
   {deliveryId:foreign?'00000000-0000-4000-8000-000000000099':rows[0].deliveryId,receipt:{persisted:true}},
  ];};
  const boundary=createSpeakingJournalBoundary({transaction:async(_,work)=>work({}),journal});
  boundary.recordCommitted({owner:'a'});boundary.recordCommitted({owner:'b'});await nextTurn();await nextTurn();
  assert.equal(batches,1);assert.equal(boundary.snapshot().delivered,0);assert.equal(boundary.snapshot().unknown,2);
 }
});

test('batching is bounded and flush waits for durable ACK without delaying native work',async()=>{
 let release;const held=new Promise(r=>{release=r;}),sizes=[],seen=[];
 const journal=async()=>{throw Error('must use batch');};
 journal.batch=async rows=>{sizes.push(rows.length);seen.push(...rows.map(r=>r.projection.owner));await held;
  return rows.map(r=>({deliveryId:r.deliveryId,receipt:{persisted:false,durableQueued:true}}));};
 const boundary=createSpeakingJournalBoundary({transaction:async(_,work)=>work({}),journal});
 for(let n=0;n<65;n++)boundary.recordCommitted({owner:n});
 await nextTurn();assert.deepEqual(sizes,[32]);assert.equal(boundary.snapshot().pending,65);
 let flushed=false;const pending=boundary.flush().then(r=>{flushed=true;return r;});await nextTurn();assert.equal(flushed,false);
 release();const result=await pending;assert.deepEqual(sizes,[32,32,1]);assert.equal(new Set(seen).size,65);
 assert.equal(result.pending,0);assert.equal(result.durableQueued,65);assert.equal(result.delivered,0);
});
