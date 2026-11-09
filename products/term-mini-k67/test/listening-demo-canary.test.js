import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

assert.ok(!process.env.K67_ORDER_NATIVE_URL, 'Run with embedded PGlite only');

const slug = '/api/term-tests/term-test-1';
const identity = {classCode:'CODEXDEMO806',studentRef:'11111111-1111-4111-8111-111111111111'};
const assets = {supports:()=>true,getContent:()=>({title:'Fixture'}),
  getTiming:()=>({readingDurationMinutes:1,listeningDurationSeconds:6,listeningTotalSeconds:8,
    listeningReviewSeconds:2,writingDurationMinutes:1}),getSessionAudioKey:()=>Buffer.alloc(32)};

for (const mode of ['lis_first','read_first']) test('K67 demo reset clears only the interrupted demo run · '+mode,async t=>{
  const portal=[];
  const fixture=await createMiniFixture({examOrder:true,completeSchema:true,assets,term1CbtJourneyMode:'on',listeningContinuityEnabled:true,
    syncErpGrades:async payload=>portal.push(payload)});
  const {db,app}=fixture;
  t.after(()=>db.close());
  await db.exec(await readFile(new URL('../db/028-listening-interruption.sql',import.meta.url),'utf8'));
  await db.exec(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT 'term-test-1','Đề giả Term 1',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
  await db.exec("UPDATE mapping.classroom_course_mapping SET erp_class_name_snapshot='CODEXDEMO806' WHERE erp_course_class_id=1293");
  const schema=await readFile(new URL('../db/003-assessment.sql',import.meta.url),'utf8');
  const resetStart=schema.indexOf('CREATE OR REPLACE FUNCTION assessment.reset_demo_term_test_student');
  const bodyStart=schema.indexOf('$function$',resetStart);
  const bodyEnd=schema.indexOf('$function$',bodyStart+10);
  const resetFunction=schema.slice(resetStart,schema.indexOf(';',bodyEnd)+1);
  await db.exec(resetFunction);
  const migration=await readFile(new URL('../db/029-demo-reset-interrupted-listening.sql',import.meta.url),'utf8');
  const api=request(app);
  const prepared=await api.post(slug+'/session/prepare')
    .send({...identity,examMode:mode,examDelivery:'cbt',orderClientVersion:1});
  assert.ok(prepared.ok,prepared.text);
  const scope={examSessionToken:prepared.body.examSessionToken,generation:0,deviceProof:'a'.repeat(64)};
  const offer=await api.post(slug+'/cbt-journey/prepare').send({...identity,...scope});
  assert.ok(offer.ok,offer.text);
  assert.equal(offer.body.listeningContinuityVersion,1);
  const post=(route,body)=>api.post(slug+'/cbt-journey/'+route).set('x-term2-permit',offer.body.permit).send({...scope,...body});
  assert.ok((await post('begin',{})).ok);
  const {rows:[journey]}=await db.query(`UPDATE assessment.term_k67_cbt_journey SET activated_at=clock_timestamp()-interval '3 minutes'
    WHERE session_id=$1 RETURNING activated_at`,[scope.examSessionToken]);
  let start=new Date(journey.activated_at).getTime(),previousOperationId=null,attemptToken;
  const order=mode==='lis_first'?['listening','reading']:['reading','listening'];
  for (const section of order) {
    const interruption=section==='listening';
    const body={section,operationId:randomUUID(),previousOperationId,startedAt:start,capturedAt:start+2_000,
      revision:1,automatic:false,eofAt:null,heardSeconds:0,answers:interruption?{}:{14:'A'}};
    if (interruption) {
      assert.equal((await post('interrupt',{...body,deviceProof:'b'.repeat(64)})).status,403);
      assert.equal((await post('interrupt',{...body,answers:{11:'A'}})).status,400);
    }
    const route=interruption?'interrupt':'seal';
    const accepted=await post(route,body);
    assert.ok(accepted.ok,accepted.text);
    const receipt=accepted.body.receipt;
    assert.equal(receipt.nextSection,previousOperationId?'writing':order[1]);
    assert.equal(receipt.outcome,interruption?'interrupted':undefined);
    assert.deepEqual((await post(route,body)).body.receipt,receipt);
    assert.deepEqual((await post('status',{section,operationId:body.operationId})).body.receipt,receipt);
    if (interruption) {
      assert.equal((await post('seal',body)).status,409);
      assert.equal((await post('interrupt',{...body,operationId:randomUUID()})).status,409);
    }
    attemptToken=receipt.attemptToken;
    previousOperationId=body.operationId;
    start=body.capturedAt+1_000;
  }
  const writing=await post('seal',{section:'writing',operationId:randomUUID(),previousOperationId,startedAt:start,
    capturedAt:start+2_000,revision:1,automatic:false,eofAt:null,heardSeconds:0,answers:{task1:'',task2:'Writing fixture'}});
  assert.ok(writing.ok,writing.text);
  const {rows:[row]}=await db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attemptToken]);
  assert.ok(row.listening_interrupted_at);
  assert.equal(row.listening_submitted_at,null);
  assert.equal(row.listening_result,null);
  assert.deepEqual(row.reading_answers,{14:'A'});
  assert.ok(row.writing_submitted_at);
  const result=await api.post('/api/term-tests/result').send({attemptToken,orderClientVersion:1});
  assert.ok(result.ok,result.text);
  assert.equal(result.body.result.listeningStatus,'interrupted');
  assert.equal(result.body.result.listening,null);
  assert.equal(result.body.result.reading.correct,1);
  assert.equal(result.body.result.summary.averageBand,null);
  assert.equal(portal.length,0);
  const other=await api.post(slug+'/session/prepare').send({...identity,
    studentRef:'44444444-4444-4444-8444-444444444444',examMode:mode,examDelivery:'cbt',orderClientVersion:1});
  assert.ok(other.ok,other.text);
  const resetRequest={...identity,testSlug:'term-test-1',confirmation:'RESET_DEMO_STUDENT'};
  assert.equal((await api.post('/api/term-tests/demo/reset').send(resetRequest)).status,500);
  assert.equal((await db.query('SELECT id FROM assessment.term_test_attempt WHERE id=$1',[attemptToken])).rows.length,1);
  await db.exec(migration);
  await db.exec(migration);
  const reset=await api.post('/api/term-tests/demo/reset').send(resetRequest);
  assert.ok(reset.ok,reset.text);
  assert.deepEqual(reset.body.reset,{attempts:1,sessions:1});
  const oldJourney=await db.query('SELECT session_id FROM assessment.term_k67_cbt_journey WHERE session_id=$1',[scope.examSessionToken]);
  assert.equal(oldJourney.rows.length,0);
  const otherSession=await db.query('SELECT id FROM assessment.term_test_exam_session WHERE id=$1',[other.body.examSessionToken]);
  assert.equal(otherSession.rows.length,1);
  assert.ok(!(await post('status',{section:'reading',operationId:previousOperationId})).ok);
  const fresh=await api.post(slug+'/session/prepare')
    .send({...identity,examMode:mode,examDelivery:'cbt',orderClientVersion:1});
  assert.ok(fresh.ok,fresh.text);
  assert.notEqual(fresh.body.examSessionToken,scope.examSessionToken);
});
