import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

const base='/api/term-tests/term-test-2';
const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
const assets={
  supports:()=>true,
  getContent:()=>({title:'Fixture',writing:{tasks:[{id:'task1'},{id:'task2'}]}}),
  getTiming:()=>({readingDurationMinutes:1,listeningDurationSeconds:1844,
    listeningReviewSeconds:120,listeningTotalSeconds:1964,writingDurationMinutes:1}),
  getSessionAudioKey:()=>Buffer.alloc(32)
};

for (const [mode,clientVersion] of [['lis_first',1],['read_first',1],['lis_first',undefined]]) {
  test(`Term 2 K67 Listening clock · ${mode} · client ${clientVersion??'legacy'}`,async()=>{
    const fixture=await createMiniFixture({assets,examOrder:true,completeSchema:true,term2CbtJourneyMode:'on',
      listeningContinuityEnabled:true,term2CbtListeningRecoveryV1:true});
    try {
      await fixture.db.exec(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
        SELECT 'term-test-2','Term 2 fixture',1,listening_definition,reading_definition,true
        FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
      const api=request(fixture.app);
      const prepared=await api.post(base+'/session/prepare').send({
        ...identity,examMode:mode,examDelivery:'cbt',orderClientVersion:1
      });
      assert.ok(prepared.ok,prepared.text);
      const scope={examSessionToken:prepared.body.examSessionToken,generation:0,deviceProof:'a'.repeat(64)};
      const offer=await api.post(base+'/cbt-journey/prepare').send({
        ...scope,...identity,listeningRecoveryClientVersion:clientVersion
      });
      assert.ok(offer.ok,offer.text);
      assert.equal(offer.body.listeningRecoveryVersion,clientVersion);
      const send=(path,payload)=>api.post(base+'/cbt-journey/'+path).set('x-term2-permit',offer.body.permit)
        .send({...scope,...payload});
      const began=await send('begin',{});
      assert.ok(began.ok,began.text);
      const firstAt=began.body.activatedAt;
      if(mode==='read_first'){
        const reading=await send('seal',{section:'reading',operationId:randomUUID(),previousOperationId:null,
          startedAt:firstAt,capturedAt:firstAt,revision:1,automatic:false,eofAt:null,heardSeconds:0,answers:{14:'A'}});
        assert.ok(reading.ok,reading.text);
        assert.equal(reading.body.receipt.nextSection,'listening');
      }
      const pause={operationId:randomUUID(),playerId:randomUUID(),expectedRevision:0,phase:'paused',
        positionMs:450,resumeCount:0,interruptionId:randomUUID(),recoverable:true,startedAt:firstAt,
        observedAt:new Date(firstAt+600).toISOString()};
      const stopped=await send('listening-clock',pause);
      if(!clientVersion){
        assert.equal(stopped.body.error,'LISTENING_CLOCK_NOT_ENABLED',stopped.text);
        const reopened=await api.post(base+'/cbt-journey/prepare').send({
          ...scope,...identity,listeningRecoveryClientVersion:1
        });
        assert.ok(reopened.ok,reopened.text);
        assert.equal(reopened.body.listeningRecoveryVersion,undefined);
        return;
      }
      assert.ok(stopped.ok,stopped.text);
      const durationMs=Math.round(offer.body.timing.listeningDurationSeconds*1000);
      assert.equal(stopped.body.clock.remainingMs,durationMs-450);
      assert.equal((await send('listening-clock',{...pause,deviceProof:'b'.repeat(64)})).status,403);
      assert.equal((await send('listening-clock',{...pause,positionMs:451})).status,409);
      assert.deepEqual((await send('listening-clock',pause)).body,stopped.body);
      const resume={...pause,operationId:randomUUID(),phase:'running',positionMs:550,
        resumeCount:1,expectedRevision:1,recoverable:null,observedAt:new Date(firstAt+900).toISOString()};
      const continued=await send('listening-clock',resume);
      assert.ok(continued.ok,continued.text);
      assert.deepEqual((await send('listening-clock',resume)).body,continued.body);
      assert.equal(continued.body.clock.remainingMs,durationMs-550);
      const operations=await fixture.db.query(`SELECT receipt FROM assessment.term_k67_cbt_listening_clock_operation
        WHERE session_id=$1 ORDER BY (receipt->>'revision')::int`,[scope.examSessionToken]);
      assert.deepEqual(operations.rows.map(row=>row.receipt),[stopped.body,continued.body]);
      const session=await fixture.db.query(`SELECT listening_submitted_at,listening_eof_at
        FROM assessment.term_test_exam_session WHERE id=$1`,[scope.examSessionToken]);
      assert.deepEqual(session.rows[0],{listening_submitted_at:null,listening_eof_at:null});
    }finally{await fixture.db.close();}
  });
}
