import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
assert.ok(process.env.K56_NATIVE_FIXTURE?.includes('term1-k56-candidate/candidate/fixture.mjs'));
assert.ok(process.env.K56_RECEIPT_LINK_MODULE?.includes('term1-k56-candidate/journal-'));
const {fixture}=await import(pathToFileURL(process.env.K56_NATIVE_FIXTURE));
const {k56WritingReceipt}=await import(pathToFileURL(process.env.K56_RECEIPT_LINK_MODULE));
const product=Number(process.env.K56_TEST_PRODUCT||1),task=product===1?2:1,slug='term-test-'+product+'-k56';
test('K56 Term'+product+' grading receipt follows the submitting profile without crossing people or generations',async()=>{
 const f=await fixture('read_first',{skipPrepare:true,realtime:true,listeningInterruption:true});
 try{
  await f.db.exec('DELETE FROM assessment.term_test_attempt;DELETE FROM assessment.term_test_exam_session;');
  await f.db.exec('ALTER TABLE assessment.term_test_writing_grading_run ADD COLUMN created_at timestamptz DEFAULT now()');
  if(product===2)await f.db.exec("INSERT INTO assessment.term_test_class_access VALUES ('term-test-2-k56',5601,true)");
  const identity={classCode:'FIXTURE',studentRef:f.student,attemptMode:'cbt',...(product===1?{term1ContinuationVersion:1}:{term2ContinuationVersion:1})};
  const open=async mode=>{
   const prepared=await f.request('/attempt/prepare',{...identity,mode});assert.equal(prepared.status,200);
   const scope={attemptToken:prepared.attemptToken,examSessionToken:prepared.examSessionToken,generation:prepared.generation,ownerId:randomUUID()};
   const offline=await f.request('/offline/prepare',{...identity,...scope,mode});assert.equal(offline.status,200);
   return {scope,permit:offline.offline.permit};
  };
  const a=await open('read_first'),b=await open('lis_first');
  const send=async(who,section,dependency=null)=>{
   const startedAt=new Date().toISOString(),writing=section==='writing';
   const make=kind=>({...who.scope,operationId:randomUUID(),section,kind,revision:kind==='start'?0:1,
    occurredAt:new Date().toISOString(),dependency,payload:{startedAt,timeValid:true,
     deadlineAt:section==='listening'?null:new Date(Date.parse(startedAt)+(section==='reading'?(product===1?40:60):(product===1?55:30))*60000).toISOString(),
     ...(writing?{['task'+task]:'Synthetic canonical writing from source profile B.'}:{answers:{'1':'A'}}),...(kind==='seal'?{reason:'manual'}:{})}});
   const start=await f.request('/offline/operation',make('start'),who.permit);assert.equal(start.receipt?.status,'accepted',JSON.stringify(start));
   const seal=await f.request('/offline/operation',make('seal'),who.permit);assert.equal(seal.receipt?.status,'accepted',JSON.stringify(seal));return seal.receipt;
  };
  await send(a,'reading');const listening=await send(b,'listening');
  const writing=await send(b,'writing',listening.operationId);
  const run=(await f.db.query('SELECT id,attempt_id,task_number FROM assessment.term_test_writing_grading_run')).rows[0];
  assert.equal(run.attempt_id,a.scope.attemptToken);assert.equal(run.task_number,task);
  const owner={token:a.scope.attemptToken,run_id:run.id,task_number:task,test_slug:slug};
  const query=(...args)=>f.db.query(...args);
  const linked=await k56WritingReceipt(query,'term-mini-k56','assessment',owner);
  assert.deepEqual(linked,{submission_operation_id:writing.operationId,submission_receipt_id:writing.receiptId});
  assert.deepEqual(await k56WritingReceipt(query,'term-mini-k56','assessment',{...owner,task_number:task===2?1:2}),{});
  await f.db.exec('BEGIN');
  await f.db.query('UPDATE assessment.term1_offline_run SET generation=generation+1 WHERE attempt_id=$1'.replace('term1_',`term${product}_`),[b.scope.attemptToken]);
  assert.deepEqual(await k56WritingReceipt(query,'term-mini-k56','assessment',owner),{});
  await f.db.exec('ROLLBACK');
  await f.db.exec('BEGIN');
  await f.db.query('UPDATE assessment.term_test_attempt SET erp_student_contact_id=9999 WHERE id=$1',[b.scope.attemptToken]);
  assert.deepEqual(await k56WritingReceipt(query,'term-mini-k56','assessment',owner),{});
  await f.db.exec('ROLLBACK');
  console.log(JSON.stringify({product,task,officialAttempt:a.scope.attemptToken,sourceAttempt:b.scope.attemptToken,
   operationId:writing.operationId,receiptId:writing.receiptId,wrongTaskDenied:true,wrongGenerationDenied:true,wrongPersonDenied:true}));
 }finally{await f.close();}
});
