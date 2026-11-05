import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as modern from './fixture-independent.mjs';
import {withSpeakingProviderJournal,speakingProviderCall} from '../independent/src/speaking-provider-journal.js';
import {createSpeakingProgressDocsWorker,startSpeakingProgressDocsWorker} from '../independent/src/speaking-progress-docs.js';
import {startSpeakingJournalRuntime} from '../independent/src/speaking-journal-runtime.js';
import {startSpeakingSpoolAgent} from './spool-agent.mjs';
const libraryRoot=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;
if(!libraryRoot)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const library=relative=>import(pathToFileURL(resolve(libraryRoot,relative)).href);
const {createSpeakingProducerJournal,createSpeakingProducerJournalFromEnv}=await library('adapters/speaking-producer.mjs');
const {speakingHomeworkBinding,speakingHomeworkSchemas}=await library('adapters/speaking-homework.mjs');
const {createJournalService}=await library('src/service.mjs');
const {ProductLogRegistry,storageScope}=await library('src/product-record.mjs');
const product='speaking-homework',registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas});

async function fixture(t,{loseEnqueueAck=false,startup=false}={}){
 const key=Buffer.alloc(32,7),collector=await createJournalService({version:1,role:'primary',
  dataRoot:mkdtempSync(join(tmpdir(),'speaking-spool-collector-')),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',
   ingestKey:key,genericSchemas:speakingHomeworkSchemas,replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],
   drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}}, {fixtureMode:true});
 await new Promise(r=>collector.server.listen(0,'127.0.0.1',r));
 const port=collector.server.address().port,root=mkdtempSync(join(tmpdir(),'journal-producer-e2e-speaking-'));
 let agent=await startSpeakingSpoolAgent(libraryRoot,root,port),dropped=false;
 const options={endpoint:`http://127.0.0.1:${port}/rpc/${product}`,key,fixtureMode:true,
  producerSpool:{version:1,endpoint:agent.ready.endpoint},fetcher:async(url,options)=>{
   const response=await fetch(url,options);
   if(loseEnqueueAck&&!dropped&&String(url).includes('/producer-spool/')){dropped=true;await response.arrayBuffer();throw Error('fake lost enqueue ACK');}
   return response;
  }};
 let runtime;
 if(startup){
  const file=join(root,'api.json'),encoded=key.toString('base64');
  writeFileSync(file,JSON.stringify({version:1,identityKey:encoded,ticketKeys:{fixture:encoded},currentTicketKeyId:'fixture',
   rpc:{endpoint:options.endpoint,key:encoded,producerSpool:options.producerSpool}}));
  runtime=await startSpeakingJournalRuntime({env:{EXAM_JOURNAL_ENABLED:'1',EXAM_JOURNAL_CONFIG_FILE:file},
   load:async()=>({createSpeakingProducerJournalFromEnv:input=>createSpeakingProducerJournalFromEnv({...input,fixtureMode:true,fetcher:options.fetcher})})});
 }
 const journal=runtime?runtime.journal:createSpeakingProducerJournal(options);
 const f=await modern.fixture({journal});
 t.after(async()=>{if(runtime)await runtime.close({flushers:[f.service.flushJournal]});else{await f.service.flushJournal();await journal.close();}await agent.close();await collector.close();await f.db.close();});
 return{...f,journal,runtime,collector,agent:()=>agent,async restart(){await agent.exit;await agent.close();agent=await startSpeakingSpoolAgent(libraryRoot,root,port);return agent;},
  async read(unitId){
   const binding=speakingHomeworkBinding({mode:'independent',assignmentRef:modern.code,classRef:'1293',subjectRef:modern.ref,unitId});
   const scope=storageScope(binding),events=await collector.stores.get(product).read(scope);
   const rows=events.map(event=>registry.decode(scope,event));
   for(const privateValue of ['PRIVATE_PROMPT','PRIVATE_MESSAGE','chatgpt.com',f.identity.accessToken])assert.ok(!JSON.stringify(rows).includes(privateValue));
   return rows;
  }};
}
async function drain(agent){
 for(let n=0;n<8;n++){
  const result=await agent.command('drain');if(result.queue.frames===0)return result;
  await agent.command('advance',{seconds:11});
 }
 throw Error('SPEAKING_SPOOL_DRAIN_LIMIT');
}

test('native commit batches into real durable Agent spool, survives claimed-process death and lost Collector ACK',async t=>{
 const f=await fixture(t);
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(91)});
 const job=await f.service.claimJob(),adapter=f.service.workerService(job);
 await withSpeakingProviderJournal(adapter.observeProvider,()=>Promise.all(Array.from({length:36},()=>
  speakingProviderCall('check_ai',async()=>Response.json({private:'PRIVATE_PROMPT'}))())));
 assert.equal((await adapter.completeCheck({qualityPassed:true,questionCount:2,fingerprint:modern.fingerprint(1)})).status,'accepted');
 const state=await f.service.flushJournal();assert.equal(state.pending,0);assert.equal(state.unknown,0);
 assert.equal(state.committed,75);assert.equal(state.durableQueued,75);assert.equal(state.delivered,0);
 assert.equal((await f.collector.stores.get(product).size()).eventCount,0,'queue ACK does not prove Collector persistence');
 assert.ok(f.journal.metrics().producerSpool.requests<=10,'75 metadata callbacks are not 75 enqueue requests');
 const queued=await f.agent().command('status');assert.ok(queued.queue.frames>0);
 const budget=await f.agent().command('budget-status');assert.ok(budget.spoolAllocationBytes<=budget.spoolMaximumBytes);
 await f.journal.close();const claimed=await f.agent().command('claim-and-die');assert.ok(claimed.claimed>0);
 const agent=await f.restart();assert.ok(agent.ready.queue.frames>0);
 const recovered=await agent.command('budget-status');assert.equal(recovered.recovered.spool,true);
 const lost=await agent.command('drain-lost-ack');assert.equal(lost.retried,1);assert.ok(lost.queue.frames>0);
 await agent.command('advance',{seconds:11});await drain(agent);
 const rows=await f.read(job.u.id);assert.equal(rows.length,75);assert.equal(new Set(rows.map(row=>row.id)).size,75);
 assert.equal(rows.filter(row=>row.kind==='provider.progress'&&row.data.phase==='started').length,36);
 assert.equal(rows.filter(row=>row.kind==='provider.progress'&&row.data.phase==='headers').length,36);
 assert.equal(rows.filter(row=>row.kind==='check.progress'&&row.data.phase==='accepted').length,1);
});

test('lost enqueue ACK remains unknown, bounded retry replays the same event and Collector deduplicates',async t=>{
 const f=await fixture(t,{loseEnqueueAck:true});
 await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(92)});
 const state=await f.service.flushJournal();assert.equal(state.unknown,1);assert.equal(state.durableQueued,0);assert.equal(state.delivered,0);
 assert.equal(f.journal.metrics().retryBatches,1);assert.equal((await f.agent().command('status')).queue.frames,1);
 await f.journal.flush();assert.equal(f.journal.metrics().retryBatches,0);assert.equal(f.journal.metrics().lostCount,0);
 assert.equal(f.service.journalHealth().unknown,1,'historical unknown is not rewritten into an ACK');
 await drain(f.agent());
 const unit=(await f.pool.query('SELECT id FROM speaking_independent.work_unit')).rows[0];
 const rows=await f.read(unit.id);assert.equal(rows.length,1);assert.equal(rows[0].kind,'link.saved');
 const requests=f.journal.metrics().producerSpool.requests;
 assert.equal((await f.journal({scope:{mode:'legacy'}})).persisted,false);
 assert.equal(f.journal.metrics().producerSpool.requests,requests,'excluded legacy mode is not sent');
});

test('producer journal requires the durable spool capability, not a silent direct-Collector fallback',()=>{
 for(const producerSpool of [undefined,{version:2}])assert.throws(()=>createSpeakingProducerJournal({producerSpool}),/PRODUCER_CONFIG_INVALID/);
});

test('Docs readback metadata uses the same durable spool and remains separate from queue ACK',async t=>{
 const f=await fixture(t),id=(await f.pool.query('SELECT id FROM speaking_independent.work_unit')).rows[0].id;
 const docId='fake-spool-progress-document';let text='',link='',writes=0;
 await f.pool.query("UPDATE speaking_independent.work_unit SET document_id=$2,tab_id='t.0' WHERE id=$1",[id,docId]);
 const gateway={get:async()=>({documentId:docId,revisionId:'fake-rev-'+writes,
  tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:modern.code+'\n'}}]}},
   {table:{tableRows:[{tableCells:[{content:[{paragraph:{elements:[{textRun:{content:'TÌNH TRẠNG NỘP BÀI SPEAKING\n'}}]}}]}]},
    {tableCells:[{content:[{paragraph:{elements:[{startIndex:100,endIndex:101+text.length,textRun:{content:text+'\n',textStyle:{link:{url:link}}}}]}}]}]}]}}]}}}]}),
  write:async(target,body)=>{assert.equal(target,docId);writes++;text=body.requests.find(r=>r.insertText).insertText.text;
   link=body.requests.find(r=>r.updateTextStyle?.textStyle?.link).updateTextStyle.textStyle.link.url;}};
 await f.service.requestCheck({...f.identity,part:'benefit_harm',rawUrl:modern.url(93)});
 const worker=createSpeakingProgressDocsWorker({pool:f.pool,schema:'speaking_independent',gateway,journal:f.journal});
 await worker.once(id);const api=await f.service.flushJournal(),docs=await worker.flushJournal();
 assert.equal(api.unknown,0);assert.equal(docs.unknown,0);assert.equal(docs.delivered,0);assert.ok(docs.durableQueued>0);
 assert.equal((await f.pool.query('SELECT status FROM speaking_independent.doc_progress WHERE unit_id=$1',[id])).rows[0].status,'verified');
 assert.equal(writes,1);assert.equal((await f.collector.stores.get(product).size()).eventCount,0);
 await drain(f.agent());const rows=await f.read(id),events=rows.filter(row=>row.kind==='docs.progress');
 assert.deepEqual(events.map(row=>row.data.phase).sort(),['queued','started','write_attempt','write_received','verified'].sort());
 assert.ok(!JSON.stringify(rows).includes(docId));assert.equal(events.find(row=>row.data.phase==='verified').data.status,'verified');
});

test('configured native Speaking startup drains late committed callbacks before transport closes',async t=>{
 const f=await fixture(t,{startup:true});assert.equal(f.runtime.snapshot().configured,true);
 const result=await f.service.requestCheck({...f.identity,part:'reason_action',rawUrl:modern.url(94)});
 const id=(await f.pool.query('SELECT id FROM speaking_independent.work_unit')).rows[0].id;
 assert.ok(result);await f.runtime.close({flushers:[f.service.flushJournal]});
 assert.equal(f.runtime.snapshot().closed,true);assert.equal(f.runtime.snapshot().shutdownUnknown,false);
 assert.equal(f.service.journalHealth().unknown,0);assert.equal(f.service.journalHealth().delivered,0);
 assert.equal(f.service.journalHealth().durableQueued,1);
 await drain(f.agent());const rows=await f.read(id);assert.equal(rows.length,1);
 assert.equal(rows[0].kind,'link.saved');
});

test('native Docs startup exposes boundary drain in both existing dispatcher modes while disabled',async()=>{
 for(const coordinated of [false,true]){
  let queries=0;const worker=startSpeakingProgressDocsWorker({pool:{query(){queries++;throw Error('MUST_NOT_QUERY');}},schema:'speaking_independent',gateway:null,coordinated,journal:false});
  assert.equal(typeof worker.flushJournal,'function');await worker.stop();const stats=await worker.flushJournal();
  assert.equal(queries,0);assert.equal(stats.enabled,false);
 }
});
