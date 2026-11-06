import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
const {createApp}=await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT+'/src/app.js'));
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
