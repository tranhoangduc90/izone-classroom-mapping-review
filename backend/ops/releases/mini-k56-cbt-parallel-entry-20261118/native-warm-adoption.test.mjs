import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
process.env.K56_REAL_ROSTER_FIXTURE='1';
process.env.K56_MINI_CBT_PARALLEL_ENTRY_MODE='on';
process.env.MINI_K56_CBT_OFFLINE_NEW='true';
delete process.env.MINI_K56_OFFLINE_CONFIG_FILE;
delete process.env.MINI_K56_LISTENING_REPORT_TELEGRAM_FILE;
const {fixture}=await import('./native-fixture.mjs');
test('Mini prepared legacy run adopts parallel capability without changing native identity, draft, clock or receipts',async()=>{
 const f=await fixture('read_first',{skipPrepare:true,realtime:true,listeningInterruption:true});
 try{
  await f.db.query('DELETE FROM assessment.term_test_attempt WHERE id=$1',[f.a]);
  await f.db.query('DELETE FROM assessment.term_test_exam_session WHERE id=$1',[f.s]);
  await f.db.exec(await readFile(new URL('./parallel-attempts.sql',import.meta.url),'utf8'));
  const identity={classCode:'FIXTURE',studentRef:f.student,attemptMode:'cbt',mode:'read_first',identityConfirmed:true};
  const old=await f.request('/attempt/prepare',identity);assert.equal(old.status,200);
  assert.equal(old.miniCbtParallelEntry,undefined);
  const scope={attemptToken:old.attemptToken,examSessionToken:old.examSessionToken,generation:old.generation,ownerId:randomUUID()};
  const offline=await f.request('/offline/prepare',{...identity,...scope});assert.equal(offline.status,200);
  const startedAt=new Date().toISOString(),deadlineAt=new Date(Date.parse(startedAt)+25*60000).toISOString();
  for(const kind of ['start','draft']){
   const response=await f.request('/offline/operation',{...scope,operationId:randomUUID(),section:'reading',kind,revision:kind==='start'?0:1,
    occurredAt:new Date().toISOString(),dependency:null,payload:{startedAt,deadlineAt,timeValid:true,answers:{'1':'Warm Reading before upgrade'}}},offline.offline.permit);
   assert.equal(response.receipt?.status,'accepted',JSON.stringify(response));
  }
  const snapshot=async()=>({
   attempt:(await f.db.query("SELECT to_jsonb(a)-'mini_cbt_parallel_entry' AS value FROM assessment.term_test_attempt a WHERE id=$1",[scope.attemptToken])).rows[0].value,
   session:(await f.db.query("SELECT to_jsonb(s)-'mini_cbt_parallel_entry' AS value FROM assessment.term_test_exam_session s WHERE id=$1",[scope.examSessionToken])).rows[0].value,
   run:(await f.db.query('SELECT to_jsonb(r) AS value FROM assessment.mini_k56_offline_run r WHERE attempt_id=$1',[scope.attemptToken])).rows[0].value,
   operations:(await f.db.query('SELECT to_jsonb(o) AS value FROM assessment.mini_k56_offline_operation o WHERE attempt_id=$1 ORDER BY operation_id',[scope.attemptToken])).rows});
  const before=await snapshot();
  const upgraded=await f.request('/attempt/prepare',{...identity,...scope,miniCbtContinuationVersion:1});
  assert.equal(upgraded.status,200,JSON.stringify(upgraded));assert.equal(upgraded.miniCbtParallelEntry,true);
  assert.equal(upgraded.attemptToken,scope.attemptToken);assert.equal(upgraded.examSessionToken,scope.examSessionToken);
  assert.deepEqual(await snapshot(),before);
  const resumed=await f.request('/offline/prepare',{...identity,...scope},offline.offline.permit);
  assert.equal(resumed.offline.permit,offline.offline.permit);
  const another=await f.request('/attempt/prepare',{...identity,miniCbtContinuationVersion:1});
  assert.equal(another.status,200);assert.notEqual(another.attemptToken,scope.attemptToken);
  const mixed=await f.request('/attempt/prepare',{...identity,...scope,examSessionToken:another.examSessionToken,miniCbtContinuationVersion:1});
  assert.equal(mixed.status,403);
  console.log(JSON.stringify({legacyCapabilityAdopted:true,sameNativeScope:true,samePermit:true,sameDraftAndClock:true,allOperationReceiptsUnchanged:true,mixedScopeDenied:true}));
 }finally{await f.close();}
});

test('Mini drain refuses a new parallel profile but keeps an issued scope and its first valid seal',async()=>{
 process.env.K56_MINI_CBT_PARALLEL_ENTRY_MODE='drain';
 const f=await fixture('read_first',{skipPrepare:true,realtime:true,listeningInterruption:true});
 try{
  await f.db.exec(await readFile(new URL('./parallel-attempts.sql',import.meta.url),'utf8'));
  await f.db.query("UPDATE assessment.term_test_exam_session SET test_slug='mini-test-k56',mini_cbt_parallel_entry=true WHERE id=$1",[f.s]);
  await f.db.query('UPDATE assessment.term_test_attempt SET mini_cbt_parallel_entry=true WHERE id=$1',[f.a]);
  const identity={classCode:'FIXTURE',studentRef:f.student,attemptMode:'cbt',mode:'read_first',identityConfirmed:true,miniCbtContinuationVersion:1};
  assert.equal((await f.request('/attempt/prepare',identity)).error,'OFFLINE_NEW_DISABLED');
  const kept=await f.request('/attempt/prepare',{...identity,...f.scope});assert.equal(kept.status,200,JSON.stringify(kept));
  assert.equal(kept.attemptToken,f.a);assert.equal(kept.miniCbtParallelEntry,true);
  const prepared=await f.request('/offline/prepare',{...identity,...f.scope});assert.equal(prepared.status,200,JSON.stringify(prepared));
  const startedAt=new Date().toISOString(),deadlineAt=new Date(Date.parse(startedAt)+25*60000).toISOString();
  for(const kind of ['start','seal']){
   const result=await f.request('/offline/operation',{...f.scope,operationId:randomUUID(),section:'reading',kind,revision:kind==='start'?0:1,
    occurredAt:new Date().toISOString(),dependency:null,payload:{startedAt,deadlineAt,timeValid:true,answers:{'1':'A'},...(kind==='seal'?{reason:'manual'}:{})}},prepared.offline.permit);
   assert.equal(result.receipt?.status,'accepted',JSON.stringify(result));
  }
  assert.equal((await f.db.query('SELECT mini_cbt_official_submission FROM assessment.term_test_attempt WHERE id=$1',[f.a])).rows[0].mini_cbt_official_submission,true);
  console.log(JSON.stringify({drainBlocksNew:true,issuedScopeContinues:true,firstSealStillProtected:true}));
 }finally{await f.close();process.env.K56_MINI_CBT_PARALLEL_ENTRY_MODE='on';}
});
