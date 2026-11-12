import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const identity = {classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
const assets = {supports:()=>true,getContent:()=>({title:'Fixture'}),
  getTiming:()=>({readingDurationMinutes:1,listeningDurationSeconds:6,listeningTotalSeconds:8,
    listeningReviewSeconds:2,writingDurationMinutes:1}),getSessionAudioKey:()=>Buffer.alloc(32),
  getJourneyManifest:()=>({sha256:'c'.repeat(64),byteLength:240,durationSeconds:6})};

for (const [testSlug,hasWriting,modeFlag] of [
  ['term-test-1',true,'term1CbtJourneyMode'],
  ['pretest-lesson-16',false,'pretestCbtJourneyMode']
]) for (const mode of ['lis_first','read_first']) test(testSlug+' interruption keeps valid sections independent · '+mode,async t=>{
  const slug = '/api/term-tests/' + testSlug;
  const portal=[];
  const fixture=await createMiniFixture({examOrder:true,completeSchema:true,assets,[modeFlag]:'on',
    syncErpGrades:async payload=>portal.push(payload)});
  const {db,app}=fixture;
  t.after(()=>db.close());
  if(hasWriting)await db.exec(await readFile(new URL('../db/028-listening-interruption.sql',import.meta.url),'utf8'));
  await db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,'Đề kiểm gián đoạn',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[testSlug]);
  if(!hasWriting)await db.query('UPDATE assessment.test_definition SET open_class_ids=$2 WHERE slug=$1',[testSlug,JSON.stringify(['1293'])]);
  const api=request(app);
  const prepared=await api.post(slug+'/session/prepare')
    .send({...identity,examMode:mode,examDelivery:'cbt',orderClientVersion:1});
  assert.ok(prepared.ok,prepared.text);
  const scope={examSessionToken:prepared.body.examSessionToken,generation:0,deviceProof:'a'.repeat(64)};
  const offer=await api.post(slug+'/cbt-journey/prepare').send({...identity,...scope});
  assert.ok(offer.ok,offer.text);
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
    assert.equal(receipt.nextSection,previousOperationId?(hasWriting?'writing':'result'):order[1]);
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
  if (hasWriting) {
    const writing=await post('seal',{section:'writing',operationId:randomUUID(),previousOperationId,startedAt:start,
      capturedAt:start+2_000,revision:1,automatic:false,eofAt:null,heardSeconds:0,answers:{task1:'',task2:'Writing fixture'}});
    assert.ok(writing.ok,writing.text);
  }
  const {rows:[row]}=await db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attemptToken]);
  assert.ok(row.listening_interrupted_at);
  assert.equal(row.listening_submitted_at,null);
  assert.equal(row.listening_result,null);
  assert.deepEqual(row.reading_answers,{14:'A'});
  assert.equal(Boolean(row.writing_submitted_at),hasWriting);
  const result=await api.post('/api/term-tests/result').send({attemptToken,orderClientVersion:1});
  assert.ok(result.ok,result.text);
  assert.equal(result.body.result.listeningStatus,'interrupted');
  assert.equal(result.body.result.listening,null);
  assert.equal(result.body.result.reading.correct,1);
  assert.equal(result.body.result.summary.averageBand,null);
  assert.equal(portal.length,hasWriting?1:0);
  if (hasWriting) {
    assert.ok('reading' in portal[0].grades);
    assert.ok(!('listening' in portal[0].grades));
  }
});
