import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
import {createHmac} from 'node:crypto';
const {createApp}=await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT+'/src/app.js'));
const term1=await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT+'/src/term1-offline.mjs'));
const term2=await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT+'/src/term2-offline.mjs'));
test('Term2 v1 permit giữ byte cũ, Term1 policy không dùng chéo cùng scope/secret',()=>{
 const row={attempt_id:'11111111-1111-4111-8111-111111111111',session_id:'22222222-2222-4222-8222-222222222222',generation:3,owner_id:'33333333-3333-4333-8333-333333333333',prepared_at:'2026-11-06T01:02:03.004Z'},secret='fixture-secret-only';
 const wire='term2-offline-v1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:3:33333333-3333-4333-8333-333333333333:2026-11-06T01:02:03.004Z';
 assert.equal(term2.permitFor(secret,row),createHmac('sha256',secret).update(wire).digest('hex'));assert.notEqual(term1.permitFor(secret,row),term2.permitFor(secret,row));assert.ok(term2.schema.includes('assessment.term2_offline_operation'));assert.ok(!term1.schema.includes('term2_offline_'));
});
test('Hai route offline chọn slug trước limiter, mỗi request chỉ tính quota đúng một lần',async()=>{
 const express=createRequire(process.env.TERM2_DEPS_PACKAGE||process.env.TERM2_RUNTIME_ROOT+'/package.json')('express'),app=express(),router=express.Router(),hits={1:0,2:0},stops=[];app.use(express.json());
 for(const [n,mod]of [[2,term2],[1,term1]]){const limit=(_q,_r,next)=>{hits[n]++;next();};stops.push(mod[`registerTerm${n}Offline`](router,{pool:{query:async()=>({rows:[]})},secret:'x'.repeat(40),limiter:limit,record(){}}));}app.use('/api/term-tests',router);const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));
 try{for(const n of [1,2])for(const path of ['prepare','status','operation']){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/term-test-${n}-k56/offline/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,400);}assert.deepEqual(hits,{1:3,2:3});}
 finally{stops.forEach(stop=>stop());await new Promise(ok=>server.close(ok));}
});
test('CORS production cho phép đúng header permit và correlation của client Pages',async()=>{
 const app=createApp({config:{nodeEnv:'test',authMode:'legacy',legacyReviewToken:'fixture',allowedOrigins:new Set(['https://tranhoangduc90.github.io']),trustProxyHops:0,
 deploymentProfileName:'k56-ic2264',termTestSessionSecret:'x'.repeat(40)},pool:{query:async()=>({rows:[],rowCount:0})},journalEnv:{EXAM_JOURNAL_ENABLED:'false'}});
 const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/term-test-2-k56/offline/operation`,{method:'OPTIONS',headers:{Origin:'https://tranhoangduc90.github.io','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-term2-permit,x-exam-journal-request-id'}});
 assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),'https://tranhoangduc90.github.io');
 for(const h of ['x-term2-permit','x-exam-journal-request-id'])assert.ok(r.headers.get('access-control-allow-headers').includes(h));
 }finally{await new Promise(ok=>server.close(ok));}
});
test('Journal giữ requestId/operationId/receiptId/mã lỗi có nghĩa qua adapter và contract',async()=>{
 const runtime=process.env.TERM2_RUNTIME_ROOT,{mountTermJournal}=await import(pathToFileURL(runtime+'/src/exam-journal-runtime/adapters/term.mjs'));
 const {normalizeEvent}=await import(pathToFileURL(runtime+'/src/exam-journal-runtime/src/contract.mjs'));
 const express=createRequire(process.env.TERM2_DEPS_PACKAGE||runtime+'/package.json')('express');const app=express();app.use(express.json());
 const rows=[],id=randomUUID(),requestId=randomUUID(),operationId=randomUUID(),receiptId=randomUUID();
 const journal={ready:Promise.resolve(),status:()=>({contextReady:true}),registerCounters(){},scopeForOwner:async()=>({}),close:async()=>{},
  emit:async(_context,type,data)=>{rows.push(normalizeEvent({id:randomUUID(),pageVisitId:id,schemaVersion:1,eventVersion:1,sequence:rows.length+1,elapsedMs:1,occurredAt:new Date().toISOString(),build:'fixture',type,data},'server'));}};
 const term=mountTermJournal(app,{config:{allowedOrigins:new Set()},productId:'term-mini-k56',schema:'assessment_k56',journal,
  lookupQuery:async()=>({rows:[{source_id:id,proof_id:id,test_slug:'term-test-2-k56',class_code:'FIXTURE',student_ref:'123',generation:0,definition_version:1,current_definition:{}}]})});
 app.post('/api/term-tests/term-test-2-k56/offline/fixture',(_q,r)=>{term.business('offline_request_failed','term-test-2-k56',id,{operationId,receiptId,errorCode:'OFFLINE_SCOPE_CONFLICT',phase:'after_commit',durationMs:8});r.json({ok:true});});
 const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));try{
 await fetch(`http://127.0.0.1:${server.address().port}/api/term-tests/term-test-2-k56/offline/fixture`,{method:'POST',headers:{'content-type':'application/json','x-exam-journal-request-id':requestId},body:JSON.stringify({attemptToken:id})});
 for(let i=0;i<100&&rows.length<3;i++)await new Promise(ok=>setImmediate(ok));
 const business=rows.find(r=>r.data.action==='offline_request_failed');assert.ok(business);assert.equal(business.data.requestId,requestId);assert.deepEqual(business.data.checkpointState,{term2OfflineVersion:1,operationId,receiptId,errorCode:'OFFLINE_SCOPE_CONFLICT',phase:'after_commit',durationMs:8});
 assert.ok(rows.some(r=>r.type==='request_completed'&&r.data.status===200&&r.data.operationStatus==='http_response_only'));
 }finally{await new Promise(ok=>server.close(ok));await journal.close();}
});
