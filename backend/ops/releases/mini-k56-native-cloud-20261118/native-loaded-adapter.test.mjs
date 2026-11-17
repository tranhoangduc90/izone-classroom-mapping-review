import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
const {fixture}=await import(pathToFileURL(process.env.MINI_NATIVE_FIXTURE));
assert.ok(process.env.MINI_NATIVE_JOURNAL_ROOT,'Use an isolated staged journal runtime');
const rootUrl=pathToFileURL(process.env.MINI_NATIVE_JOURNAL_ROOT.replaceAll('\\','/')+'/');
const {mountTermJournal}=await import(new URL('adapters/term.mjs',rootUrl));
const {producerKeys,openProducerFrame}=await import(new URL('src/producer-frame.mjs',rootUrl));
const {matchRpc,signRpc}=await import(new URL('src/remote-store.mjs',rootUrl));
const {checkMiniK56CbtNativeEvent}=await import(new URL('adapters/mini-k56-cbt-native/native-event-policy.mjs',rootUrl));
const transport='term-mini-k56-mini-cbt-cloud';
test('Mini loaded adapter links source-profile receipt and preserves SQL seal/content when spool fails',async()=>{
 const rows=[],f=await fixture('read_first',{skipPrepare:true,realtime:true,listeningInterruption:true,record:(...row)=>rows.push(row)});
 const root=await mkdtemp(join(tmpdir(),'mini-k56-native-')),originalFetch=globalThis.fetch;
 const counters=new Map(),delivered=[],collector=[],contents=[],lookupErrors=[];
 let bridge,refuse=false;
 try{
  await f.db.exec('DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;');
  await f.db.exec(await import('node:fs/promises').then(fs=>fs.readFile(process.env.MINI_NATIVE_MIGRATION,'utf8')));
  await f.db.exec("ALTER TABLE assessment.term_test_exam_session ADD COLUMN IF NOT EXISTS class_name_snapshot text DEFAULT 'FIXTURE'; ALTER TABLE assessment.term_test_attempt ADD COLUMN IF NOT EXISTS class_name_snapshot text DEFAULT 'FIXTURE', ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(); CREATE TABLE IF NOT EXISTS assessment.test_definition(slug text PRIMARY KEY)");
  const identity={classCode:'FIXTURE',studentRef:f.student,attemptMode:'cbt',miniCbtContinuationVersion:1};
  const open=async mode=>{
   const a=await f.request('/attempt/prepare',{...identity,mode});assert.equal(a.status,200,JSON.stringify(a));
   const scope={attemptToken:a.attemptToken,examSessionToken:a.examSessionToken,generation:a.generation,ownerId:randomUUID()};
   const o=await f.request('/offline/prepare',{...identity,...scope,mode});assert.equal(o.status,200);
   return {scope,permit:o.offline.permit};
  };
  const a=await open('read_first'),b=await open('lis_first');
  const policy=join(root,'route.json'),credential=join(root,'key'),key=Buffer.alloc(32,7),{authKey}=producerKeys(key,transport);
  const enabled={version:1,mode:'cloud',classCode:'FIXTURE',opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+60000).toISOString()};
  await writeFile(policy,JSON.stringify(enabled));await writeFile(credential,key.toString('base64'));
  const scopeForOwner=owner=>({product:'term-mini-k56',testSlug:owner.testSlug,classCode:owner.classCode,studentRef:owner.studentRef,generation:owner.generation,journeyId:createHash('sha256').update(owner.sourceId).digest('hex')});
  const journal={ready:Promise.resolve(),status:()=>({contextReady:true}),close:async()=>{},registerCounters:(name,read)=>counters.set(name,read),scopeForOwner,
   emit:async(...row)=>collector.push(row),content:async(...row)=>contents.push(row)};
  globalThis.fetch=async(url,options)=>{
   if(!String(url).startsWith('https://fixture.invalid/'))return originalFetch(url,options);
   assert.equal(String(url),'https://fixture.invalid/producer-spool/'+transport);
   const {envelope,signature}=JSON.parse(options.body);assert.ok(matchRpc(authKey,envelope,signature));
   const groups=openProducerFrame({frame:envelope.frame,productId:transport,key,clock:Date.now});delivered.push(groups);
   const receipt={version:1,productId:transport,nonce:envelope.nonce,operation:'enqueue-frame',
    ...(refuse?{error:{code:'SPOOL_UNAVAILABLE',status:503}}:{result:{ok:true,persisted:false,durableQueued:true,frameId:envelope.frame.frameId}})};
   return Response.json({receipt,signature:signRpc(authKey,receipt)},{status:refuse?503:200});
  };
  bridge=mountTermJournal(createRequire(process.env.TERM2_DEPS_PACKAGE)('express')(),{productId:'term-mini-k56',schema:'assessment_k56',journal,config:{allowedOrigins:[],buildSha:'mini-native-fixture'},logger:{warn:()=>{}},
   lookupQuery:async(sql,...args)=>{try{return await f.db.query(sql.replaceAll('assessment_k56.','assessment.'),...args);}catch(e){lookupErrors.push(e.message);throw e;}},
   env:{K56_MINI_CBT_NATIVE_ROUTE_FILE:policy,K56_MINI_CBT_NATIVE_SPOOL_KEY_FILE:credential,K56_MINI_CBT_NATIVE_SPOOL_ENDPOINT:'https://fixture.invalid/producer-spool/'+transport}});
  const settled=async()=>{const end=Date.now()+4000;while(counters.get('ownerLookup')().pending){assert.ok(Date.now()<end,'Owner lookup did not settle');await delay(10);}};
  const submit=async(who,section,dependency=null)=>{
   const startedAt=new Date().toISOString();
   const make=kind=>({...who.scope,operationId:randomUUID(),kind,section,revision:kind==='start'?0:1,occurredAt:new Date().toISOString(),dependency,payload:{startedAt,timeValid:true,deadlineAt:section==='listening'?null:new Date(Date.parse(startedAt)+(section==='reading'?25:15)*60000).toISOString(),...(section==='writing'?{task2:'Synthetic Task 2 after source-profile continuation.'}:{answers:{'1':'A'}}),...(kind==='seal'?{reason:'manual'}:{})}});
   assert.equal((await f.request('/offline/operation',make('start'),who.permit)).receipt?.status,'accepted');
   const response=await f.request('/offline/operation',make('seal'),who.permit);assert.equal(response.receipt?.status,'accepted',JSON.stringify(response));
   const event=rows.find(row=>row[0]==='offline_operation_committed'&&row[3]?.receiptId===response.receipt.receiptId);assert.ok(event);
   bridge.business(...event);await settled();return response.receipt;
  };
  await submit(a,'reading');const listening=await submit(b,'listening');
  assert.equal(delivered.length,2,JSON.stringify({lookupErrors,metrics:counters.get('ownerLookup')()}));assert.equal(collector.length,0);
  const sourceJourney=createHash('sha256').update(b.scope.examSessionToken).digest('hex');
  assert.equal(delivered[1][0].scope.journeyId,sourceJourney);
  assert.equal(delivered[1][0].events[0].data.checkpointState.receiptId,listening.receiptId);
  assert.equal(delivered[1][0].events[0].data.checkpointState.continuedFromOtherSession,true);
  const wireScope={...delivered[1][0].scope,product:'term-mini-k56'};
  if(process.env.MINI_K56_CBT_NATIVE_SYNTHETIC_EVENT)await writeFile(process.env.MINI_K56_CBT_NATIVE_SYNTHETIC_EVENT,JSON.stringify({scope:wireScope,event:delivered[1][0].events[0]})+'\n',{flag:'wx'});
  for(const group of delivered.flat())for(const event of group.events)checkMiniK56CbtNativeEvent(event,{...group.scope,product:'term-mini-k56'});
  const request={testSlug:'mini-test-k56',token:b.scope.attemptToken,type:'request_completed',data:{requestId:randomUUID(),method:'POST',route:'/api/term-tests/mini-test-k56/offline/operation',status:200,operationStatus:'http_response_only'},content:{syntheticContent:'content retains existing Collector path'}};
  refuse=true;const writing=await submit(b,'writing',listening.operationId);
  assert.equal(writing.officialAttemptToken,a.scope.attemptToken);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_run')).rows[0].n,1);
  assert.ok(counters.get('ownerLookup')().failed>0);
  refuse=false;
  const job=(await f.db.query('SELECT id FROM assessment.term_test_writing_grading_job')).rows[0];assert.ok(job);
  bridge.business('job_queued','mini-test-k56',b.scope.attemptToken,{section:'writing',task:2,jobId:job.id,operationId:writing.operationId,receiptId:writing.receiptId});await settled();
  let observed=delivered.at(-1)[0].events[0];assert.equal(observed.data.task,2);assert.equal(observed.data.jobId,job.id);
  const jobEvent=observed;
  const incidentId=randomUUID();
  bridge.business('mini_listening_report','mini-test-k56',b.scope.attemptToken,{incidentId,generation:0,status:'open',phase:'enqueue',mode:'offline'});await settled();
  observed=delivered.at(-1)[0].events[0];assert.equal(observed.data.checkpointState.incidentId,incidentId);assert.equal(observed.data.checkpointState.miniListeningReportVersion,1);
  if(process.env.MINI_K56_CBT_WORKER_FIXTURE)await writeFile(process.env.MINI_K56_CBT_WORKER_FIXTURE,JSON.stringify({scope:wireScope,event:delivered[1][0].events[0],additionalEvents:[jobEvent,observed]})+'\n',{flag:'wx'});
  for(const group of delivered.flat())for(const event of group.events)checkMiniK56CbtNativeEvent(event,{...group.scope,product:'term-mini-k56'});
  refuse=true;
  await bridge.observe(request);assert.equal(contents.length,1);assert.equal(collector.length,0);
  await writeFile(policy,JSON.stringify({...enabled,mode:'collector'}));await bridge.observe(request);
  assert.equal(collector.length,1);assert.equal(contents.length,2);
  await assert.rejects(Promise.resolve().then(()=>checkMiniK56CbtNativeEvent(delivered[1][0].events[0],{...wireScope,testSlug:'term-test-2-k56'})),/PILOT_NATIVE_RECEIPT_DENIED/);
  assert.deepEqual(lookupErrors,[]);
  console.log(JSON.stringify({nativeSeals:3,sourceProfileReceipt:true,Task2Run:1,SQLSealPreservedOnSpoolFailure:true,Task2JobMetadata:true,reportMetadata:true,contentPreserved:true,collectorRollback:true,wrongVariantDenied:true,boundary:'Native HTTP/SQL and loaded adapter with signed synthetic spool ACK; content remains Collector, no new cloud enabled'}));
 }finally{globalThis.fetch=originalFetch;await bridge?.journal.close();await f.close();await rm(join(root,'route.json'),{force:true});await rm(join(root,'key'),{force:true});await import('node:fs/promises').then(fs=>fs.rmdir(root));}
});
