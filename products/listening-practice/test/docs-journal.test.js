import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {fixture} from './helpers.js';
import {docsTextBuffer} from '../../test-support/homework-docs.js';
import {localPool} from '../tools/local-pool.mjs';
import {createDocsWorker,CTA,STATUS_HEADING} from '../src/docs.js';
import {CODE,uuid} from '../src/domain.js';

const schema='listening_practice',createFixture=options=>fixture(options);
async function setup(t){
 const pool=await localPool(),records=[];let failures=0;
 const journal={recordReceipt(){},recordProgress(scope,value){if(!scope){failures++;return{ok:false};}records.push({scope,...value});return{ok:true,persisted:true};}};
 const f=await createFixture({poolFactory:async()=>pool,journal});t.after(f.close);await tick();
 return{...f,journal,records,get failures(){return failures;}};
}
function fakeDocs(b,{onWrite=async()=>{}}={}){
 const status=docsTextBuffer(200);
 let writes=0;
 const paragraph=(start,text,url='')=>({paragraph:{elements:[{startIndex:start,endIndex:start+text.length,textRun:{content:text,textStyle:url?{link:{url}}:{}}},{startIndex:start+text.length,endIndex:start+text.length+1,textRun:{content:'\n'}}]}});
 const docs={read:async id=>{assert.equal(id,b.document_id);return{documentId:id,revisionId:'fixture-'+writes,tabs:[{tabProperties:{tabId:b.tab_id},documentTab:{body:{content:[paragraph(1,CODE),paragraph(50,CTA),{table:{tableRows:[{tableCells:[{content:[paragraph(100,STATUS_HEADING)]}]},{tableCells:[{content:[{paragraph:{elements:status.elements()}}]}]}]}}]}}}]};},
 write:async(id,plan)=>{assert.equal(id,b.document_id);assert.equal(plan.revisionId,'fixture-'+writes);writes++;
  for(const request of plan.requests)status.apply(request);
  await onWrite();
 }};
 return{docs,get writes(){return writes;},get value(){return status.text;}};
}
async function statusSetup(t){
 const f=await setup(t),started=await f.begin();await f.pool.query(`DELETE FROM ${schema}.doc_job WHERE kind='cta'`);await tick();
 const b=(await f.pool.query(`SELECT * FROM ${schema}.binding`)).rows[0];return{f,b,started};
}

test('Docs queued phản ánh job đã commit; CTA ở scope0, status thuộc lượt gốc sau Reset',async t=>{
 const{f,b,started}=await statusSetup(t),old=started.attempts.at(-1);
 const cta=f.records.find(r=>r.data.phase==='queued'&&r.data.jobKind==='cta');assert.ok(cta);assert.equal(cta.scope.attemptNo,0);assert.equal(cta.scope.attemptId,b.id);
 const current=await f.service.reset({token:f.token,attemptId:old.id,lease:started.lease,owner:'device1',operationId:uuid()});await tick();
 const next=current.attempts.at(-1);assert.notEqual(old.id,next.id);
 const fake=fakeDocs(b),worker=createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal});await worker.once();await worker.once();await tick();
 const verified=f.records.filter(r=>r.data.phase==='verified');assert.equal(verified.length,2);
 assert.equal(verified[0].scope.attemptId,old.id);assert.equal(verified[1].scope.attemptId,next.id);
 assert.deepEqual((await f.pool.query(`SELECT status FROM ${schema}.doc_job ORDER BY sequence`)).rows,[{status:'verified'},{status:'verified'}]);
 assert.ok(verified.every(r=>r.data.readCalls===2&&r.data.writeCalls===1&&r.data.targetHash.length===64));
 for(const secret of [b.document_id,b.tab_id,'Đã bắt đầu','example.test'])assert.equal(JSON.stringify(f.records).includes(secret),false);
});

test('Docs mất phản hồi sau ghi: unknown/retry, readback không ghi đôi rồi mới verified',async t=>{
 const{f,b}=await statusSetup(t);let cut=true;
 const fake=fakeDocs(b,{onWrite:async()=>{if(cut){cut=false;throw Error('PRIVATE CANARY lost ACK');}}}),worker=createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal});
 await worker.once();await tick();assert.equal(f.records.some(r=>r.data.phase==='verified'),false);
 assert.ok(f.records.some(r=>r.data.phase==='outcome_unknown'));assert.ok(f.records.some(r=>r.data.phase==='retry'));
 await f.pool.query(`UPDATE ${schema}.doc_job SET available_at=now()`);await worker.once();await tick();
 assert.equal(fake.writes,1);assert.equal(f.records.filter(r=>r.data.phase==='verified').length,1);
 assert.equal(f.records.find(r=>r.data.phase==='verified').data.jobAttempt,2);
 assert.equal(f.records.find(r=>r.data.phase==='verified').data.writeCalls,0);
 assert.equal(JSON.stringify(f.records).includes('PRIVATE CANARY'),false);
});

test('Docs không có quyền hoặc sai chủ: blocked có mã, không nhận verified/không đọc nhầm đích',async t=>{
 const{f,b}=await statusSetup(t);const worker=createDocsWorker({pool:f.pool,journal:f.journal,docs:{read:async()=>{throw Object.assign(Error('private'),{code:'DOC_HTTP_403'});}}});
 await worker.once();await tick();assert.equal(f.records.some(r=>r.data.phase==='verified'),false);
 assert.ok(f.records.some(r=>r.data.phase==='blocked'&&r.data.errorCode==='DOC_HTTP_403'));
 await f.pool.query(`UPDATE ${schema}.doc_job SET status='pending',available_at=now()`);
 await f.pool.query(`UPDATE ${schema}.binding SET document_id=NULL,tab_id=NULL,owner_proof=$1`,[{mode:'shared'}]);
 let reads=0;const wrong=createDocsWorker({pool:f.pool,journal:f.journal,resolveSharedHomework:async()=>({classId:'1124',studentRef:uuid(),code:CODE,documentId:'wrong',tabId:'wrong'}),docs:{read:async()=>{reads++;}}});
 await wrong.once();await tick();assert.equal(reads,0);
 assert.ok(f.records.some(r=>r.data.phase==='blocked'&&r.data.errorCode==='DOC_IDENTITY_MISMATCH'));
});

test('Docs mất lease hoặc rollback SQL sau Google: không có marker verified giả',async t=>{
 const{f,b}=await statusSetup(t);let loseLease=true;
 const fake=fakeDocs(b,{onWrite:async()=>{if(loseLease)await f.pool.query(`UPDATE ${schema}.doc_job SET lease_id=$1`,[uuid()]);}});
 const worker=createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal});await worker.once();await tick();
 assert.equal(f.records.some(r=>r.data.phase==='verified'),false);assert.ok(f.records.some(r=>r.data.errorCode==='DOC_LEASE_LOST'));
 loseLease=false;await f.pool.query(`UPDATE ${schema}.doc_job SET status='pending',available_at=now()`);
 const connect=f.pool.connect.bind(f.pool);let rollback=true;
 f.pool.connect=async()=>{const c=await connect();return{query(sql,args){if(rollback&&String(sql).startsWith(`UPDATE ${schema}.binding SET last_doc_sequence`))throw Error('rollback fixture');return c.query(sql,args);},release:()=>c.release()};};
 await worker.once();await tick();assert.equal(f.records.some(r=>r.data.phase==='verified'),false);
 assert.equal((await f.pool.query(`SELECT status FROM ${schema}.doc_job`)).rows[0].status,'pending');
 rollback=false;await f.pool.query(`UPDATE ${schema}.doc_job SET available_at=now()`);await worker.once();await tick();
 assert.equal(f.records.filter(r=>r.data.phase==='verified').length,1);assert.equal(fake.writes,1);
});

test('queued rollback không phát event; logger treo không cản transaction hoặc Docs',async t=>{
 const f=await setup(t),connect=f.pool.connect.bind(f.pool);let failCommit=true;
 f.pool.connect=async()=>{const c=await connect();return{query(sql,args){if(failCommit&&sql==='COMMIT')throw Error('commit fixture');return c.query(sql,args);},release:()=>c.release()};};
 const before=f.records.length;await assert.rejects(f.service.begin({token:f.token,owner:'device1',operationId:uuid()}));await tick();assert.equal(f.records.length,before);
 assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${schema}.doc_job WHERE kind='status'`)).rows[0].n,0);
 failCommit=false;f.journal.recordProgress=()=>new Promise(()=>{});
 const started=await f.begin();assert.equal(started.attempts.at(-1).no,1);await f.pool.query(`DELETE FROM ${schema}.doc_job WHERE kind='cta'`);
 const b=(await f.pool.query(`SELECT * FROM ${schema}.binding`)).rows[0],fake=fakeDocs(b);
 await createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal}).once();assert.equal(fake.writes,1);
 assert.equal((await f.pool.query(`SELECT status FROM ${schema}.doc_job`)).rows[0].status,'verified');
});

test('legacy payload thiếu ID vẫn nối theo sequence; payload sai không được gắn sang lượt khác',async t=>{
 const{f,b,started}=await statusSetup(t);await f.pool.query(`UPDATE ${schema}.doc_job SET payload=payload-'attemptId'-'attemptNo'`);
 const fake=fakeDocs(b);await createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal}).once();await tick();
 assert.equal(f.records.find(r=>r.data.phase==='verified').scope.attemptId,started.attempts.at(-1).id);
 const old=started.attempts.at(-1);await f.service.reset({token:f.token,attemptId:old.id,lease:started.lease,owner:'device1',operationId:uuid()});await tick();
 await f.pool.query(`UPDATE ${schema}.doc_job SET payload=jsonb_set(payload,'{attemptId}',$1::jsonb) WHERE status='pending'`,[JSON.stringify(uuid())]);
 const before=f.records.filter(r=>r.data.phase==='verified').length;
 await createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal}).once();await tick();
 assert.equal(f.records.filter(r=>r.data.phase==='verified').length,before);assert.ok(f.failures>0);
 assert.equal((await f.pool.query(`SELECT status FROM ${schema}.doc_job ORDER BY sequence DESC LIMIT 1`)).rows[0].status,'verified');
});


test('Docs source callbacks register synchronously and stay inside the drain barrier',async t=>{
 const{f,b,started}=await statusSetup(t),scheduled=[];const before=f.records.length;
 f.journal.scheduleSource=work=>{scheduled.push(work);return true;};
 const fake=fakeDocs(b);await createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal}).once();
 assert.ok(scheduled.length>0);await tick();assert.equal(f.records.length,before);
 assert.equal((await f.pool.query(`SELECT status FROM ${schema}.doc_job`)).rows[0].status,'verified');
 while(scheduled.length)await scheduled.shift()();
 assert.equal(f.records.filter(r=>r.data.phase==='verified').length,1);
 f.journal.scheduleSource=()=>false;const records=f.records.length;
 const old=started.attempts.at(-1);
 await f.service.reset({token:f.token,attemptId:old.id,lease:started.lease,owner:'device1',operationId:uuid()});
 await createDocsWorker({pool:f.pool,docs:fake.docs,journal:f.journal}).once();await tick();
 assert.equal(f.records.length,records,'full/closed barrier must never start untracked callbacks');
});
