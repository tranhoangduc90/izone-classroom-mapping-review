import test from 'node:test';import assert from 'node:assert/strict';import{pathToFileURL}from'node:url';import{randomUUID}from'node:crypto';
process.env.TERM2_FIXTURE_IMPORT_ONLY='1';process.env.K56_TEST_PRODUCT='1';
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
test('Task2 có chữ dùng canonical, một job; AI giả6 → tổng6 và không có Task1 giả',async()=>{
 const f=await fixture();try{let dependency=null;for(const skill of ['listening','reading','writing']){const start=op(f,skill,'start',{dependency});await f.request('/offline/operation',start);const seal=op(f,skill,'seal',{dependency,startedAt:start.payload.startedAt,task1:skill==='writing'?'This is a Task 2 essay.':''});assert.equal((await f.request('/offline/operation',seal)).receipt.status,'accepted');dependency=seal.operationId;}
 await completeFakeResult(f,2);const runs=(await f.db.query('SELECT task_number,essay_text FROM assessment.term_test_writing_grading_run')).rows;assert.deepEqual(runs.map(x=>[x.task_number,x.essay_text]),[[2,'This is a Task 2 essay.']]);
 }finally{await f.close();}
});
test('Term1 opt-in unset/false đều tắt cấp mới; true cấp được và tắt vẫn nhận pending',async()=>{
 const before=process.env.TERM1_OFFLINE_NEW_ENABLED;delete process.env.TERM1_OFFLINE_NEW_ENABLED;
 const f=await fixture('lis_first',{skipPrepare:true,defaultPolicy:true});try{const body={...f.scope,classCode:'FIXTURE',studentRef:randomUUID(),mode:'lis_first'};
 assert.equal((await f.request('/offline/prepare',body)).error,'OFFLINE_NEW_DISABLED');process.env.TERM1_OFFLINE_NEW_ENABLED='false';assert.equal((await f.request('/offline/prepare',body)).error,'OFFLINE_NEW_DISABLED');process.env.TERM1_OFFLINE_NEW_ENABLED='true';const p=await f.request('/offline/prepare',body);assert.equal(p.status,200);process.env.TERM1_OFFLINE_NEW_ENABLED='false';assert.equal((await f.request('/offline/operation',op(f,'listening','start'),p.offline.permit)).receipt.status,'accepted');
 }finally{if(before===undefined)delete process.env.TERM1_OFFLINE_NEW_ENABLED;else process.env.TERM1_OFFLINE_NEW_ENABLED=before;await f.close();}
});
