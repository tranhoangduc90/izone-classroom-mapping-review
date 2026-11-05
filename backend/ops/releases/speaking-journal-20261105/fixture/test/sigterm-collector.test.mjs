import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as modern from './fixture-independent.mjs';
import {startSpeakingSpoolAgent} from './spool-agent.mjs';
const libraryRoot=process.env.SPEAKING_JOURNAL_LIBRARY_ROOT;if(!libraryRoot)throw Error('SPEAKING_JOURNAL_LIBRARY_ROOT_REQUIRED');
const lib=path=>import(pathToFileURL(resolve(libraryRoot,path)).href);
const {createJournalService}=await lib('src/service.mjs');
const {ProductLogRegistry,storageScope}=await lib('src/product-record.mjs');
const {speakingHomeworkBinding,speakingHomeworkSchemas}=await lib('adapters/speaking-homework.mjs');

test('Linux SIGTERM drains native SQL callbacks to external durable Agent before API exit; parent delivers exact committed IDs',
 {skip:process.platform!=='linux'},async t=>{
 const key=Buffer.alloc(32,7),product='speaking-homework',root=mkdtempSync(join(tmpdir(),'journal-producer-e2e-sigterm-'));
 const collector=await createJournalService({version:1,role:'primary',dataRoot:join(root,'collector'),maxPhysicalBytes:64*1024*1024,incrementalAccounting:true,
  products:{[product]:{storageEngine:'scoped-drive-v2',encryptionKeys:{fixture:Buffer.alloc(32,4)},currentKeyId:'fixture',ingestKey:key,genericSchemas:speakingHomeworkSchemas,
   replicas:[{id:'fixture-copy',endpoint:'http://127.0.0.1:1/replica',key}],drive:{broker:'http://127.0.0.1:1/fixture-broker',receiptKey:key.toString('base64')}}}},{fixtureMode:true});
 t.after(()=>collector.close());await new Promise(r=>collector.server.listen(0,'127.0.0.1',r));
 const port=collector.server.address().port,agent=await startSpeakingSpoolAgent(libraryRoot,root,port);t.after(()=>agent.close());
 const file=join(root,'api.json'),encoded=key.toString('base64');writeFileSync(file,JSON.stringify({version:1,identityKey:encoded,ticketKeys:{fixture:encoded},currentTicketKeyId:'fixture',
  rpc:{endpoint:`http://127.0.0.1:${port}/rpc/${product}`,key:encoded,producerSpool:{version:1,endpoint:agent.ready.endpoint}}}));
 const child=fork(new URL('./sigterm-api-fixture.mjs',import.meta.url),[],{execArgv:['--no-warnings','--max-old-space-size=256'],windowsHide:true,
  env:{...process.env,SPEAKING_SIGTERM_FIXTURE:'synthetic-native-sigterm-v1',EXAM_JOURNAL_ENABLED:'1',EXAM_JOURNAL_CONFIG_FILE:file},stdio:['ignore','ignore','pipe','ipc']});
 let stderr='',last;child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});child.on('message',row=>{last=row;});
 const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));let timer;
 const bounded=async(promise,ms)=>{try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('FIXTURE_CHILD_DEADLINE '+stderr)),ms);})]);}finally{clearTimeout(timer);}};
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await bounded(exit,10000);}});
 const ready=await bounded(new Promise((r,reject)=>{
  child.on('message',row=>{if(row.ready)r(row);});child.once('error',reject);child.once('exit',()=>reject(Error('FIXTURE_START_EXIT '+stderr)));
 }),30000);
 const response=await fetch(`http://127.0.0.1:${ready.port}/api/speaking-homework-independent/checks/request`,{
  method:'POST',headers:{'content-type':'application/json',origin:'https://fixture.invalid'},body:JSON.stringify({...ready.identity,part:'reason_action',url:modern.url(119)})});
 assert.equal(response.status,202);const link=(await response.json()).check.id;
 child.kill('SIGTERM');assert.deepEqual(await bounded(exit,30000),{code:0,signal:null});
 assert.equal(last.stopped,true);assert.equal(last.runtime.closed,true);assert.equal(last.runtime.shutdownUnknown,false);
 assert.ok(last.boundary.durableQueued>=2);assert.equal(last.boundary.pending,0);assert.equal(last.boundary.unknown,0);
 assert.equal((await collector.stores.get(product).size()).eventCount,0,'Agent queue ACK is not Collector persistence');
 assert.ok((await agent.command('status')).queue.frames>0);
 for(let turn=0;turn<8;turn++){
  const state=await agent.command('drain');if(!state.queue.frames)break;
  await agent.command('advance',{seconds:11});if(turn===7)throw Error('FIXTURE_DRAIN_LIMIT');
 }
 const scope=storageScope(speakingHomeworkBinding({mode:'independent',assignmentRef:modern.code,classRef:'1293',subjectRef:modern.ref,unitId:ready.unitId}));
 const registry=new ProductLogRegistry({product,schemas:speakingHomeworkSchemas}),rows=(await collector.stores.get(product).read(scope)).map(row=>registry.decode(scope,row));
 assert.equal(rows.filter(row=>row.kind==='link.saved'&&row.data.linkId===link).length,1);
 assert.equal(rows.filter(row=>row.kind==='api.request'&&row.data.route==='check_main'&&row.data.linkId===link).length,1);
 assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.id)).size,2);
 await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/health`));
});
