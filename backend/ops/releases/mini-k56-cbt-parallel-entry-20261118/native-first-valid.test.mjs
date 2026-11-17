import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
assert.ok(process.env.TERM2_RUNTIME_ROOT,'Captured or staged synthetic runtime required');
process.env.K56_REAL_ROSTER_FIXTURE='1';
process.env.K56_TERM1_PARALLEL_ENTRY_MODE='on';
process.env.K56_TERM2_PARALLEL_ENTRY_MODE='on';
process.env.K56_MINI_CBT_PARALLEL_ENTRY_MODE='on';
process.env.MINI_K56_CBT_OFFLINE_NEW='true';
delete process.env.MINI_K56_OFFLINE_CONFIG_FILE;
delete process.env.MINI_K56_LISTENING_REPORT_TELEGRAM_FILE;
const {fixture}=await import('./native-fixture.mjs');
const {canonicalMiniWriting}=await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT+'/src/mini-offline.mjs'));
const {k56WritingReceipt}=await import(pathToFileURL((process.env.MINI_RECEIPT_LINK_BASELINE||process.env.TERM2_RUNTIME_ROOT+'/src/exam-journal-runtime/adapters/term-k56-offline.mjs')));
for(const {mode,blank} of [{mode:'read_first',blank:false},{mode:'lis_first',blank:false},{mode:'read_first',blank:true}])test('Mini CBT '+mode+(blank?' blank Task2':' Task2')+' protects the first valid skill and accepts the remaining skills from a second profile once after ACK loss',async()=>{
 const firstSkill=mode==='read_first'?'reading':'listening',secondSkill=mode==='read_first'?'listening':'reading';
 let lose=false,lost=false,failLog=false;
 const events=[];
 const f=await fixture(mode,{skipPrepare:true,realtime:true,listeningInterruption:true,
  record:(event,slug,token,details)=>{events.push({event,slug,token,details});if(failLog)throw Error('Synthetic journal unavailable');},
  dropResponse:(request,response)=>{if(lose&&!lost&&request.section==='writing'&&request.kind==='seal'&&response.receipt?.status==='accepted'){lost=true;return true;}return false;}});
 try{
  await f.db.query('DELETE FROM assessment.term_test_attempt WHERE id=$1',[f.a]);
  await f.db.query('DELETE FROM assessment.term_test_exam_session WHERE id=$1',[f.s]);
  await f.db.exec('ALTER TABLE assessment.term_test_writing_grading_run ADD COLUMN created_at timestamptz DEFAULT now()');
  await f.db.exec(await readFile(new URL('./parallel-attempts.sql',import.meta.url),'utf8'));
  const identity={classCode:'FIXTURE',studentRef:f.student,attemptMode:'cbt',mode,identityConfirmed:true,miniCbtContinuationVersion:1};
  const open=async()=>{
   const result=await f.request('/attempt/prepare',identity);assert.equal(result.status,200,JSON.stringify(result));
   const scope={attemptToken:result.attemptToken,examSessionToken:result.examSessionToken,generation:result.generation,ownerId:randomUUID()};
   const prepared=await f.request('/offline/prepare',{...identity,...scope});assert.equal(prepared.status,200,JSON.stringify(prepared));
   return {scope,permit:prepared.offline.permit};
  };
  const a=await open(),b=await open();assert.notEqual(a.scope.attemptToken,b.scope.attemptToken);
  const state=new Map();
  const operation=(who,section,kind,dependency=null,text='A')=>{
   const key=who.scope.attemptToken+':'+section;
   if(kind==='start')state.set(key,new Date().toISOString());
   const startedAt=state.get(key);
   return {...who.scope,operationId:randomUUID(),section,kind,revision:kind==='start'?0:1,occurredAt:new Date().toISOString(),dependency,
    payload:{startedAt,timeValid:true,deadlineAt:section==='listening'?null:new Date(Date.parse(startedAt)+(section==='reading'?25:15)*60000).toISOString(),
     ...(section==='writing'?{task2:text}:{answers:{'1':text}}),...(kind==='seal'?{reason:'manual'}:{})}};
  };
  const send=(who,body)=>f.request('/offline/operation',body,who.permit);
  for(const who of [a,b])assert.equal((await send(who,operation(who,firstSkill,'start'))).receipt?.status,'accepted');
  const first=operation(a,firstSkill,'seal',null,'A');
  assert.equal((await send(a,first)).receipt?.status,'accepted');
  const loser=await send(b,operation(b,firstSkill,'seal',null,'B'));
  assert.equal(loser.persisted,false);assert.equal(loser.receipt,null);assert.equal(loser.officialProgress[firstSkill],'sealed');
  const resumed=await f.request('/attempt/active',{...identity,...b.scope});
  assert.equal(resumed.attemptToken,b.scope.attemptToken);assert.equal(resumed.officialProgress[firstSkill],'sealed');
  assert.equal((await send(b,operation(b,secondSkill,'start'))).receipt?.status,'accepted');
  const second=operation(b,secondSkill,'seal');const heard=await send(b,second);
  assert.equal(heard.receipt?.status,'accepted',JSON.stringify(heard));
  assert.equal(heard.receipt.officialAttemptToken,a.scope.attemptToken);
  assert.equal((await send(b,operation(b,'writing','start',second.operationId,''))).receipt?.status,'accepted');
  const essay=blank?' \t\u200b ':'Synthetic Mini Task 2 retained in the first official attempt, submitted by profile B.';
  const writing=operation(b,'writing','seal',second.operationId,essay);
  lose=true;failLog=true;
  await assert.rejects(send(b,writing),/fetch failed/);assert.equal(lost,true);
  const again=await send(b,writing);assert.equal(again.receipt?.status,'accepted',JSON.stringify(again));
  const status=await f.request('/offline/status',{...b.scope,operationId:writing.operationId},b.permit);
  assert.deepEqual(status.receipt,again.receipt);
  const rows=(await f.db.query('SELECT * FROM assessment.term_test_attempt ORDER BY id')).rows;
  const official=rows.find(row=>row.id===a.scope.attemptToken),source=rows.find(row=>row.id===b.scope.attemptToken);
  assert.equal(official.mini_cbt_official_submission,true);assert.equal(source.mini_cbt_official_submission,false);
  assert.deepEqual(official.reading_answers,{'1':'A'});assert.ok(official.listening_submitted_at);assert.equal(official.writing_task_2,essay);
  assert.equal(source.reading_submitted_at,null);assert.equal(source.listening_submitted_at,null);assert.equal(source.writing_submitted_at,null);
  assert.deepEqual(await canonicalMiniWriting(f.pool,official),{task2:essay,blank});
  if(blank)assert.deepEqual(await f.grading.ensureSubmission({attemptToken:official.id,testSlug:'mini-test-k56',task2:'A stale client essay must not be graded',taskDefinitions:f.content.writing.tasks}),{status:'blank',ready:true,mode:'blank',taskStates:{task2:'blank'}});
  const runs=(await f.db.query('SELECT id,attempt_id,task_number,essay_text FROM assessment.term_test_writing_grading_run')).rows;
  const jobs=(await f.db.query('SELECT * FROM assessment.term_test_writing_grading_job')).rows;
  assert.equal(runs.length,blank?0:1);assert.equal(jobs.length,blank?0:1);
  let journalOwner;
  if(!blank){
   assert.equal(runs[0].attempt_id,official.id);assert.equal(runs[0].task_number,2);assert.equal(runs[0].essay_text,essay);
   journalOwner={token:official.id,run_id:runs[0].id,task_number:2,test_slug:'mini-test-k56'};
   assert.deepEqual(await k56WritingReceipt(f.pool.query,'term-mini-k56','assessment',journalOwner),{submission_operation_id:writing.operationId,submission_receipt_id:again.receipt.receiptId});
   assert.deepEqual(await k56WritingReceipt(f.pool.query,'term-mini-k56','assessment',{...journalOwner,task_number:1}),{});
  }
  const receipts=(await f.db.query("SELECT receipt FROM assessment.mini_k56_offline_operation WHERE section='writing' AND kind='seal'")).rows;
  assert.equal(receipts.length,1);assert.deepEqual(receipts[0].receipt,again.receipt);
  for(const sql of [
   'UPDATE assessment.mini_k56_offline_run SET generation=generation+1 WHERE attempt_id=$1',
   'UPDATE assessment.term_test_exam_session SET generation=generation+1 WHERE id=(SELECT exam_session_id FROM assessment.term_test_attempt WHERE id=$1)',
   'UPDATE assessment.term_test_attempt SET definition_version=definition_version+1 WHERE id=$1',
   'UPDATE assessment.term_test_attempt SET erp_student_contact_id=9999 WHERE id=$1',
   "UPDATE assessment.mini_k56_offline_operation SET receipt=jsonb_set(receipt,'{examSessionToken}',to_jsonb(gen_random_uuid()::text)) WHERE attempt_id=$1 AND section='writing' AND kind='seal'"
  ]){
   await f.db.exec('BEGIN');
   try{await f.db.query(sql,[b.scope.attemptToken]);await assert.rejects(canonicalMiniWriting(f.pool,official),{code:'WRITING_CANONICAL_MISSING'});
    if(journalOwner)assert.deepEqual(await k56WritingReceipt(f.pool.query,'term-mini-k56','assessment',journalOwner),{});}
   finally{await f.db.exec('ROLLBACK');}
  }
  await assert.rejects(f.db.query("UPDATE assessment.term_test_attempt SET reading_answers='{\"1\":\"overwrite\"}' WHERE id=$1",[official.id]),{code:'P5664'});
  const proof={at:new Date().toISOString(),mode,blank,distinctProfiles:true,firstSkillProtected:firstSkill,secondProfileContinued:true,task2OnOfficial:true,wrongGenerationPersonReceiptDenied:true,
   sourceScopePreserved:again.receipt.attemptToken===b.scope.attemptToken,oneWritingReceipt:true,runAndJobCount:runs.length,writingReceiptLinked:!blank,lostAckRecovered:true,journalFailureDoesNotBlock:true,
   receipt:again.receipt,run:runs[0],events:events.length,boundary:'Real staged native HTTP, synthetic roster/content and PGlite SQL. Manual short Listening seal, no audio/browser/AI/Portal or concurrent SQL claim'};
  if(process.env.MINI_NATIVE_PROOF)await writeFile(process.env.MINI_NATIVE_PROOF.replace(/\.json$/,'.'+mode+(blank?'.blank':'')+'.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof));
 }finally{await f.close();}
});
