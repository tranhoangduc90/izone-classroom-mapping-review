import test from 'node:test';import assert from 'node:assert/strict';import{pathToFileURL}from'node:url';import{randomUUID}from'node:crypto';
process.env.TERM2_FIXTURE_IMPORT_ONLY='1';process.env.K56_TEST_PRODUCT='1';
const{writeFile}=await import('node:fs/promises');
const{fixture,op}=await import('./test.mjs');const{completeFakeResult}=await import('./fake-grading.mjs');
const{gradeSection}=await import(pathToFileURL(process.env.TERM2_RUNTIME_ROOT+'/src/term-tests.js'));
test('Term1 native: 41 ô /40 điểm, câu32 cả hai đúng; R26; key lạ bị từ chối',async()=>{
 const f=await fixture();try{const row=await f.load(f.pool,'term-test-1-k56',f.a),answers=Object.fromEntries(Array.from({length:40},(_,i)=>[i+1,'A']));delete answers['32'];Object.assign(answers,{'32a':'A','32b':'B'});
 assert.equal(Object.keys(answers).length,41);assert.equal(gradeSection(row.listening_definition,answers,0,'raw').correct,40);
 for(const pair of [{'32a':'A'},{'32b':'B'},{'32a':'X','32b':'B'},{'32a':'B','32b':'A'}]){const data={...answers};delete data['32a'];delete data['32b'];Object.assign(data,pair);assert.equal(gradeSection(row.listening_definition,data,0,'raw').correct,39);}
 const r=gradeSection(row.reading_definition,answers,0,'raw');assert.equal(r.correct,26);assert.equal(r.total,26);assert.equal(r.band,undefined);
 const start=op(f,'listening','start');start.payload.answers=answers;assert.equal((await f.request('/offline/operation',start)).receipt.status,'accepted');
 const draft=op(f,'listening','draft',{startedAt:start.payload.startedAt,revision:1});draft.payload.answers={'32a':'A','32b':'B'};assert.equal((await f.request('/offline/operation',draft)).receipt.status,'accepted');
 const bad=structuredClone(draft);bad.operationId=randomUUID();bad.revision=2;bad.payload.answers={'32':'A'};assert.equal((await f.request('/offline/operation',bad)).error,'OFFLINE_ANSWER_KEYS');
 }finally{await f.close();}
});
test('Task2 mất phản hồi sau commit rồi gửi lại: một bài, một job, chấm đúng bản đã lưu',async()=>{
 let writingOperationId, lostReceipt;
 const journalObservations=[];
 const f=await fixture('lis_first',{record(action,slug,_token,details){journalObservations.push({action,slug,details});},
  dropResponse(requestBody,responseBody){
  if(lostReceipt || !writingOperationId || requestBody?.operationId!==writingOperationId
    || responseBody?.receipt?.status!=='accepted')return false;
  lostReceipt=responseBody.receipt;
  return true;
 }});
 try {
  let dependency=null;
  for(const skill of ['listening','reading','writing']){
   const start=op(f,skill,'start',{dependency});
   assert.equal((await f.request('/offline/operation',start)).receipt.status,'accepted');
   const seal=op(f,skill,'seal',{dependency,startedAt:start.payload.startedAt,
    task1:skill==='writing'?'This is a Task 2 essay.':''});
   if(skill==='writing'){
    writingOperationId=seal.operationId;
    await assert.rejects(f.request('/offline/operation',seal),error=>error.cause?.code==='UND_ERR_SOCKET');
    assert.equal(lostReceipt.status,'accepted');
    const committed=(await f.load(f.pool,'term-test-1-k56',f.a));
    assert.ok(committed.writing_submitted_at);
    assert.equal(committed.writing_task_2,'This is a Task 2 essay.');
    assert.deepEqual((await f.request('/offline/operation',seal)).receipt,lostReceipt);
    const observed=journalObservations.filter(row=>row.action==='offline_operation_committed'
     && row.slug==='term-test-1-k56'&&row.details.operationId===writingOperationId);
    assert.ok(observed.length>0);
    for(const row of observed){
     assert.equal(row.details.phase,'after_commit');
     assert.equal(row.details.accepted,true);
     assert.equal(row.details.receiptId,lostReceipt.receiptId);
    }
   }else{
    assert.equal((await f.request('/offline/operation',seal)).receipt.status,'accepted');
   }
   dependency=seal.operationId;
  }
  const final=await completeFakeResult(f,2);
  const runs=(await f.db.query('SELECT task_number,essay_text FROM assessment.term_test_writing_grading_run')).rows;
  assert.deepEqual(runs.map(x=>[x.task_number,x.essay_text]),[[2,'This is a Task 2 essay.']]);
  if(process.env.TERM1_FIXTURE_WRITING_PROOF){
   await writeFile(process.env.TERM1_FIXTURE_WRITING_PROOF,JSON.stringify({
    kind:'term1-k56-writing-fixture-v1',attemptId:f.a,operationId:writingOperationId,receiptId:lostReceipt.receiptId,writingScore:Number(final.writing_score),
   }),{flag:'wx'});
  }
 }finally{await f.close();}
});
test('Term1 opt-in unset/false đều tắt cấp mới; true cấp được và tắt vẫn nhận pending',async()=>{
 const before=process.env.TERM1_OFFLINE_NEW_ENABLED;delete process.env.TERM1_OFFLINE_NEW_ENABLED;
 const f=await fixture('lis_first',{skipPrepare:true,defaultPolicy:true});try{const body={...f.scope,classCode:'FIXTURE',studentRef:randomUUID(),mode:'lis_first'};
 assert.equal((await f.request('/offline/prepare',body)).error,'OFFLINE_NEW_DISABLED');process.env.TERM1_OFFLINE_NEW_ENABLED='false';assert.equal((await f.request('/offline/prepare',body)).error,'OFFLINE_NEW_DISABLED');process.env.TERM1_OFFLINE_NEW_ENABLED='true';const p=await f.request('/offline/prepare',body);assert.equal(p.status,200);process.env.TERM1_OFFLINE_NEW_ENABLED='false';assert.equal((await f.request('/offline/operation',op(f,'listening','start'),p.offline.permit)).receipt.status,'accepted');
 }finally{if(before===undefined)delete process.env.TERM1_OFFLINE_NEW_ENABLED;else process.env.TERM1_OFFLINE_NEW_ENABLED=before;await f.close();}
});
