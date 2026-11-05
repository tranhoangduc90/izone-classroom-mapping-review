import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http,{createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import * as modern from './fixture-independent.mjs';
import {withSpeakingProviderJournal,speakingProviderCall} from '../independent/src/speaking-provider-journal.js';
import {fetchSpeakingEvidence} from '../independent/src/speaking-ai-verification.js';
import {readSpeakingShare} from '../independent/src/speaking-share-reader.js';
import {startIndependentWorker} from '../independent/src/speaking-independent-server.js';
import {runSpeakingDoctorJob,analyzeDoctorConversation} from '../independent/src/speaking-doctor-worker.js';
const libraryRoot=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;
if(!libraryRoot)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const library=relative=>import(pathToFileURL(resolve(libraryRoot,relative)).href);
const {createSpeakingHomeworkJournal,speakingHomeworkBinding,speakingHomeworkSchemas}=await library('adapters/speaking-homework.mjs');
const {createJournalService}=await library('src/service.mjs');
const {RemoteJournalStore}=await library('src/remote-store.mjs');
const {ProductLogRegistry,storageScope}=await library('src/product-record.mjs');
const product='speaking-homework',registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});

async function fixture(t){
 const key=Buffer.alloc(32,9),collector=await createJournalService({version:1,role:'primary',
  dataRoot:mkdtempSync(join(tmpdir(),'speaking-provider-log-')),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',
   ingestKey:key,genericSchemas:speakingHomeworkSchemas,replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],
   drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}}, {fixtureMode:true});
 await new Promise(r=>collector.server.listen(0,'127.0.0.1',r));
 const remote=new RemoteJournalStore({endpoint:`http://127.0.0.1:${collector.server.address().port}/rpc/${product}`,productId:product,key,fixtureMode:true});
 await remote.ready;t.after(async()=>{await remote.close();await collector.close();});
 const projections=[],journal=createSpeakingHomeworkJournal({append:(...args)=>remote.append(...args)});
 const f=await modern.fixture({journal:p=>{projections.push(structuredClone(p));return journal.recordCommitted(speakingHomeworkBinding(p.scope),p);}});
 t.after(()=>f.db.close());
 return{...f,async read(){
  const until=Date.now()+8000;while(f.service.journalHealth().pending&&Date.now()<until)await delay(10);
  assert.equal(f.service.journalHealth().pending,0);assert.equal(f.service.journalHealth().unknown,0);assert.equal(f.service.journalHealth().overflow,0);
  const scopes=new Map(projections.map(p=>{const b=speakingHomeworkBinding(p.scope);return[JSON.stringify(b),storageScope(b)];}));
  const rows=[];for(const scope of scopes.values())for(const row of await collector.stores.get(product).read(scope))rows.push(registry.decode(scope,row));
  for(const secret of ['PRIVATE_PROMPT','PRIVATE_MESSAGE','FIXTURE_SECRET','chatgpt.com',f.identity.accessToken])assert.ok(!JSON.stringify(rows).includes(secret));
  return rows;
 }};
}
const waitUntil=async check=>{const until=Date.now()+8000;while(Date.now()<until){if(await check())return;await delay(10);}throw Error('NATIVE_WORKER_NOT_FINISHED');};

test('native Share direct/fallback retry and AI correction count actual HTTP calls under the committed claim',async t=>{
 const f=await fixture(t);let direct=0,gateway=0,ai=0;
 const html='<!DOCTYPE html><script id="octane-conversation-transcript">'+JSON.stringify({rows:[
  {key:'u',frame:{role:'user',id:'u',text:'PRIVATE_MESSAGE'}},
  {key:'a',frame:{role:'assistant',id:'a'},source:{markdown:'PRIVATE_MESSAGE assistant'}},
 ]})+'</script>';
 const server=createServer((req,res)=>{
  req.resume();res.setHeader('Content-Type','application/json');
  if(req.url==='/direct'){direct++;res.writeHead(503);res.end('{}');}
  else if(req.url.startsWith('/gateway')){gateway++;res.writeHead(gateway===1?503:200);res.end(JSON.stringify(gateway===1?{}:{html}));}
  else if(req.url==='/ai'){ai++;res.end(JSON.stringify({text:ai===1?'invalid JSON':JSON.stringify({ok:true})}));}
  else{res.writeHead(404);res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const endpoint=`http://127.0.0.1:${server.address().port}`,oldGet=https.get,oldEnv=process.env.CODEX_CHATGPT_SHARE_ENDPOINT;
 https.get=(url,options,callback)=>{assert.ok(String(url).startsWith('https://chatgpt.com/share/'));return http.get(endpoint+'/direct',options,callback);};
 process.env.CODEX_CHATGPT_SHARE_ENDPOINT=endpoint+'/gateway?token=FIXTURE_SECRET';
 t.after(()=>{https.get=oldGet;if(oldEnv===undefined)delete process.env.CODEX_CHATGPT_SHARE_ENDPOINT;else process.env.CODEX_CHATGPT_SHARE_ENDPOINT=oldEnv;});
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(71)});
 const job=await f.service.claimJob(),adapter=f.service.workerService(job);
 await withSpeakingProviderJournal(adapter.observeProvider,async()=>{
  const conversation=await readSpeakingShare(job.share_url);assert.equal(conversation.messages.length,2);
  const result=await fetchSpeakingEvidence(endpoint+'/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'PRIVATE_PROMPT'})},
   {anchored:false,messages:conversation.messages,validate:data=>assert.equal(data.ok,true)});
  assert.deepEqual(await result.json(),{text:'{"ok":true}'});
 });
 assert.deepEqual([direct,gateway,ai],[2,2,2]);
 await adapter.completeCheck({qualityPassed:true,questionCount:2,fingerprint:modern.fingerprint(1)});
 const rows=await f.read(),requests=rows.filter(r=>r.kind==='provider.progress'),started=requests.filter(r=>r.data.phase==='started');
 assert.equal(requests.length,12);assert.deepEqual(started.map(r=>r.data.requestOrdinal),[1,2,3,4,5,6]);
 assert.deepEqual(started.map(r=>r.data.route),['share_direct','share_direct','share_gateway','share_gateway','check_ai','check_ai']);
 assert.deepEqual(started.map(r=>r.data.reason),['initial','retry','initial','retry','initial','correction']);
 const claim=rows.find(r=>r.kind==='check.progress'&&r.data.phase==='started');
 assert.ok(requests.every(r=>r.data.jobAttempt===1&&r.data.runHash===claim.data.runHash&&r.data.jobId===job.id&&r.data.linkRevision===1));
 assert.equal(requests.filter(r=>r.data.phase==='headers'&&r.data.httpStatus===503).length,3);
 assert.equal(rows.filter(r=>r.kind==='check.progress'&&r.data.phase==='accepted').length,1);
});

for(const coordinated of [false,true])test(`native worker dispatch installs provider context, coordinated=${coordinated}`,async t=>{
 const f=await fixture(t);let calls=0;
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(coordinated?72:73)});
 const worker=startIndependentWorker({service:f.service,coordinated,pollMs:20,dependencies:{check:async()=>{
  calls++;await speakingProviderCall('check_ai',async()=>Response.json({private:'PRIVATE_MESSAGE'}))();
  return{kind:'pass',count:2,fingerprint:modern.fingerprint(2)};
 }}});
 try{await waitUntil(async()=>!(await f.pool.query("SELECT 1 FROM speaking_independent.job WHERE kind='check_main' AND status!='done'")).rows.length);}
 finally{await worker.stop();}
 assert.equal(calls,1);
 const rows=await f.read(),requests=rows.filter(r=>r.kind==='provider.progress');assert.equal(requests.length,2);
 assert.deepEqual(requests.map(r=>r.data.phase),['started','headers']);assert.ok(requests.every(r=>r.data.part==='reason_action'));
 const accepted=rows.find(r=>r.kind==='check.progress'&&r.data.phase==='accepted');assert.ok(accepted);
 assert.ok(requests.every(r=>r.data.runHash===accepted.data.runHash&&r.data.jobId===accepted.data.jobId));
});

test('a late I/O response keeps the original run after retry/reset; cloned claims cannot relabel provider facts',async t=>{
 const f=await fixture(t);
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(74)});
 const old=await f.service.claimJob(),oldAdapter=f.service.workerService(old);let release;
 const gate=new Promise(r=>{release=r;});
 const late=withSpeakingProviderJournal(oldAdapter.observeProvider,()=>speakingProviderCall('check_ai',async()=>{await gate;return{status:200};})());
 await f.service.failJob(old,'AI_TIMEOUT');
 await f.pool.query("UPDATE speaking_independent.job SET attempts=0,available_at=now()-interval '1 second' WHERE id=$1",[old.id]);
 const retry=await f.service.claimJob(),adapter=f.service.workerService(retry);
 assert.notEqual(old.owner,retry.owner);assert.equal(f.service.workerService({...retry}).observeProvider,undefined);
 await withSpeakingProviderJournal(adapter.observeProvider,()=>speakingProviderCall('check_ai',async()=>({status:200}))());
 await adapter.completeCheck({qualityPassed:true,questionCount:2,fingerprint:modern.fingerprint(3)});
 release();await late;
 const rows=await f.read(),requests=rows.filter(r=>r.kind==='provider.progress'),starts=rows.filter(r=>r.kind==='check.progress'&&r.data.phase==='started');
 assert.equal(requests.length,4);assert.equal(starts.length,2);assert.notEqual(starts[0].data.runHash,starts[1].data.runHash);
 assert.ok(requests.every(r=>r.data.jobAttempt===1&&r.data.requestOrdinal===1));
 assert.equal(requests.at(-1).data.runHash,starts[0].data.runHash);
 assert.equal(rows.find(r=>r.kind==='check.progress'&&r.data.phase==='accepted').data.runHash,starts[1].data.runHash);
});

test('native Doctor parallel parts keep individual part names and one committed job run',async t=>{
 const f=await fixture(t);let next=4;
 const drain=async()=>{
  for(let turn=0;turn<8;turn++){
   const jobs=await f.service.claimJobs(4);if(!jobs.length)return;
   for(const job of jobs){
    const adapter=f.service.workerService(job),pass={qualityPassed:true,questionCount:2,fingerprint:modern.fingerprint(next++)};
    if(job.kind==='check_main')await adapter.completeCheck(pass);
    else if(job.kind==='check_practice')await adapter.completePracticeCheck({...pass,matchedExerciseId:job.exercise_id});
    else{const catalog=await adapter.getDoctorCatalog();await adapter.completeDoctorJob({catalogDigest:catalog.digest,matches:[]});}
   }
  }throw Error('FIXTURE_DRAIN_LIMIT');
 };
 for(const [i,part] of ['benefit_harm','reason_action','freestyle'].entries())await f.service.requestCheck({...f.identity,part,rawUrl:modern.url(80+i)});
 await drain();
 for(const slot of [1,2])await f.service.requestPracticeCheck({...f.identity,slot,exerciseId:modern.exercise(slot),rawUrl:modern.url(83+slot)});
 await drain();await f.service.finish(f.identity);
 const job=await f.service.claimJob();assert.equal(job.kind,'analyze_homework');const adapter=f.service.workerService(job);
 // A fake already accepted snapshot avoids any external Share/AI dependency.
 adapter.getAcceptedConversation=async()=>({messages:[{role:'user',text:'PRIVATE_MESSAGE'},{role:'assistant',text:'PRIVATE_MESSAGE feedback'}]});
 let calls=0;const server=createServer((req,res)=>{req.resume();const n=++calls;setTimeout(()=>{
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:JSON.stringify({confidence:.9,matches:[]})}));
 },n===1?20:1);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 await withSpeakingProviderJournal(adapter.observeProvider,()=>runSpeakingDoctorJob(adapter,job,{
  analyze:(part,conversation,catalog)=>analyzeDoctorConversation(part,conversation,catalog,`http://127.0.0.1:${server.address().port}/ai`),
 }));
 assert.equal(calls,2);
 const rows=await f.read(),requests=rows.filter(r=>r.kind==='provider.progress');assert.equal(requests.length,4);
 assert.deepEqual(requests.filter(r=>r.data.phase==='started').map(r=>r.data.part).sort(),['freestyle','reason_action']);
 assert.equal(new Set(requests.map(r=>r.data.requestOrdinal)).size,2);
 const done=rows.find(r=>r.kind==='doctor.progress'&&r.data.jobKind==='analyze_homework'&&r.data.phase==='completed');assert.ok(done);
 assert.ok(requests.every(r=>r.data.runHash===done.data.runHash&&r.data.jobKind==='analyze_homework'&&r.data.route==='doctor_ai'));
});
