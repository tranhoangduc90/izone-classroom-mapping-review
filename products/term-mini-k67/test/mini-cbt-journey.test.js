import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

const slug='/api/term-tests/mini-test-lesson-5';
const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
const assets={supports:()=>true,getContent:()=>({title:'Fixture'}),getTiming:()=>({readingDurationMinutes:1,listeningDurationSeconds:6,
  listeningTotalSeconds:8,listeningReviewSeconds:2}),getSessionAudioKey:()=>Buffer.alloc(32)};

for(const recovery of [false,true])for(const mode of ['lis_first','read_first'])
test(`Mini journey preserves native order and requires EOF ${mode} · recovery ${recovery}`,async()=>{
  const f=await createMiniFixture({examOrder:true,assets,miniCbtJourneyMode:'on',writingHold:recovery
    ?{miniCbtLrHoldHours:2,miniCbtLrHoldLimit:20,miniCbtLrHoldClasses:new Set([identity.classCode])}:{}});
  try{
    const api=request(f.app);
    const prepared=await api.post(slug+'/session/prepare').send({...identity,examMode:mode,examDelivery:'cbt',orderClientVersion:1});
    assert.ok(prepared.ok,prepared.text);
    const scope={examSessionToken:prepared.body.examSessionToken,generation:0,deviceProof:'a'.repeat(64)};
    const offer=await api.post(slug+'/cbt-journey/prepare').send({...identity,...scope});
    assert.ok(offer.ok,offer.text);
    assert.equal(offer.body.examMode,mode);
    assert.equal(offer.body.readingDeadlineReviewVersion,recovery?1:undefined);
    const post=(path,body)=>api.post(slug+'/cbt-journey/'+path).set('x-term2-permit',offer.body.permit).send({...scope,...body});
    const start=await post('begin',{});
    assert.ok(start.ok,start.text);
    assert.equal((await post('begin',{deviceProof:'b'.repeat(64)})).status,403);
    const old=await api.post(slug+(mode==='read_first'?'/reading/start':'/session/start')).send({...scope,
      attemptToken:prepared.body.attemptToken||undefined,orderClientVersion:1});
    assert.equal(old.body.error,'MINI_OFFLINE_JOURNEY_ACTIVE',old.text);
    const before=await f.db.query(`UPDATE assessment.mini_k67_cbt_journey SET activated_at=clock_timestamp()-interval '2 minutes'
      WHERE session_id=$1 RETURNING activated_at`,[scope.examSessionToken]);
    const firstAt=new Date(before.rows[0].activated_at).getTime();
    const order=mode==='lis_first'?['listening','reading']:['reading','listening'];
    const premature={section:'listening',operationId:randomUUID(),previousOperationId:null,startedAt:firstAt,
      capturedAt:firstAt+8_000,revision:1,automatic:true,eofAt:null,heardSeconds:0,answers:{11:'A'}};
    const rejected=await post('seal',premature);
    assert.equal(rejected.body.error,mode==='lis_first'?'AUDIO_END_NOT_CONFIRMED':'OFFLINE_TIMELINE',rejected.text);
    assert.equal(Boolean(rejected.body.held),recovery);
    let nextAt=firstAt,previousOperationId=null;
    for(const section of order){
      const listening=section==='listening';
      const operation={section,operationId:randomUUID(),previousOperationId,startedAt:nextAt,
        capturedAt:nextAt+(listening?8_000:2_000),revision:1,automatic:listening,
        eofAt:listening?nextAt+6_000:null,heardSeconds:listening?6:0,answers:listening?{11:'A'}:{14:'A'}};
      if(listening){
        const early=await post('seal',{...operation,operationId:randomUUID(),capturedAt:operation.eofAt+100});
        assert.equal(early.body.error,'OFFLINE_REVIEW_REQUIRED',early.text);
      }else if(recovery){
        const review={...operation,operationId:randomUUID(),capturedAt:nextAt+60_001,automatic:true};
        const held=await post('reading-review',review);
        assert.equal(held.body.reasonCode,'READING_DRAFT_NOT_VERIFIED');
        assert.ok(held.body.held?.payloadHash);
        assert.deepEqual((await post('status',{section,operationId:review.operationId})).body,
          {ok:true,persisted:false,receipt:null,held:held.body.held});
        assert.equal((await post('seal',review)).body.reasonCode,'READING_DRAFT_NOT_VERIFIED');
      }
      const accepted=await post('seal',operation);
      assert.ok(accepted.ok,accepted.text);
      if(recovery)assert.deepEqual((await post('status',{section,operationId:operation.operationId})).body.receipt,accepted.body.receipt);
      assert.deepEqual((await post('seal',operation)).body.receipt,accepted.body.receipt);
      assert.equal((await post('seal',{...operation,operationId:randomUUID()})).status,409);
      assert.equal(accepted.body.receipt.completed,Boolean(previousOperationId));
      previousOperationId=operation.operationId;
      nextAt=operation.capturedAt+1_000;
    }
    const row=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE exam_session_id=$1',[scope.examSessionToken])).rows[0];
    assert.deepEqual(row.listening_answers,{11:'A'});
    assert.deepEqual(row.reading_answers,{14:'A'});
    assert.ok(row.completed_at);
  }finally{await f.db.close();}
});
