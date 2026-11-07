import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

const root='/api/term-tests/term-test-1';
const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111',identityConfirmed:true};
const deviceProof='a'.repeat(64);
const assets={supports:()=>true,getTiming:()=>({readingDurationMinutes:60}),getContent:()=>{
  throw new Error('Paper must not load CBT content');
}};

for(const examMode of ['lis_first','read_first'])test(`Term 1 paper preserves both section policies · ${examMode}`,async t=>{
  const portal=[];
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,term1PaperJourneyMode:'on',term1CbtJourneyMode:'on',
    syncErpGrades:async payload=>portal.push(payload)});
  t.after(()=>f.db.close());
  await f.db.exec(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT 'term-test-1','Đề giả Term 1',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
  const api=request(f.app);
  const prepare=body=>api.post(root+'/paper-journey/prepare').send({...identity,deviceProof,examMode,...body});
  assert.equal((await prepare({classCode:'WRONG'})).status,403);
  const ready=await prepare();
  assert.ok(ready.ok,ready.text);
  assert.deepEqual(ready.body.timing,{readingDurationMinutes:60});
  assert.equal(ready.body.audioManifest,undefined);
  assert.equal(ready.body.content,undefined);
  assert.equal(ready.body.examMode,examMode);
  assert.equal((await prepare({deviceProof:'b'.repeat(64)})).status,403);
  const reopened=await prepare({examMode:examMode==='lis_first'?'read_first':'lis_first'});
  assert.equal(reopened.body.examSessionToken,ready.body.examSessionToken);
  assert.equal(reopened.body.examMode,examMode);
  const scope={examSessionToken:ready.body.examSessionToken,generation:ready.body.generation,deviceProof};
  const wrongMode=await api.post(root+'/cbt-journey/prepare').send({...identity,...scope});
  assert.equal(wrongMode.status,403);
  const post=(route,body)=>api.post(root+'/paper-journey/'+route).set('x-term2-permit',ready.body.permit).send({...scope,...body});
  const start=(await f.db.query(`UPDATE assessment.term_k67_cbt_journey SET activated_at=clock_timestamp()-interval '61 minutes'
    WHERE session_id=$1 RETURNING activated_at`,[scope.examSessionToken])).rows[0].activated_at;
  let startedAt=new Date(start).getTime()+100;
  let previousOperationId=null;
  const order=examMode==='lis_first'?['listening','reading']:['reading','listening'];
  for(const section of order){
    const listening=section==='listening';
    const operation={section,previousOperationId,operationId:randomUUID(),startedAt,
      capturedAt:startedAt+(listening?1000:60*60_000),revision:1,automatic:!listening,eofAt:null,heardSeconds:0,
      answers:listening?{11:'A'}:{14:'A'}};
    if(listening)assert.equal((await post('seal',{...operation,automatic:true})).body.error,'PAPER_MANUAL_ONLY');
    else assert.equal((await post('seal',{...operation,capturedAt:operation.capturedAt-1})).body.error,'OFFLINE_REVIEW_REQUIRED');
    assert.equal((await post('status',{section,operationId:operation.operationId})).body.persisted,false);
    const saved=await post('seal',operation);
    assert.ok(saved.ok,saved.text);
    assert.equal(saved.body.receipt.completed,previousOperationId!==null);
    assert.deepEqual((await post('status',{section,operationId:operation.operationId})).body.receipt,saved.body.receipt);
    assert.deepEqual((await post('seal',operation)).body.receipt,saved.body.receipt);
    previousOperationId=operation.operationId;
    startedAt=operation.capturedAt+500;
  }
  const row=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE exam_session_id=$1',[scope.examSessionToken])).rows[0];
  assert.equal(row.writing_scope,'lr_only');
  assert.equal(row.writing_submitted_at,null);
  assert.equal(row.exam_delivery,'answer_sheet');
  assert.equal(new Date(row.reading_deadline_at)-new Date(row.reading_started_at),60*60_000);
  assert.deepEqual(row.listening_answers,{11:'A'});
  assert.deepEqual(row.reading_answers,{14:'A'});
  const session=(await f.db.query('SELECT * FROM assessment.term_test_exam_session WHERE id=$1',[scope.examSessionToken])).rows[0];
  assert.equal(session.listening_deadline_at,null);
  assert.equal(session.listening_eof_at,null);
  for(let n=0;n<30&&!portal.length;n++)await delay(10);
  assert.ok(portal.length>0);
  assert.equal(portal[0].testSlug,'term-test-1');
  assert.equal(portal[0].attemptToken,row.id);
  assert.equal(portal[0].classId,'1293');
  assert.equal(portal[0].studentId,'900001');
  assert.equal(portal[0].grades.writing,undefined);
});
