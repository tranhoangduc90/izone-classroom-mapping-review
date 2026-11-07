import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {createTermTestWritingGradingService} from '../src/term-test-writing-grading.js';

const slug='/api/term-tests/term-test-1';
const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
const definitions=[{id:'task2',prompt:'Đề giả Task 2'}];
const assets={supports:()=>true,getContent:()=>({title:'Fixture',writing:{tasks:definitions}}),
  getTiming:()=>({readingDurationMinutes:1,listeningDurationSeconds:6,listeningTotalSeconds:8,
    listeningReviewSeconds:2,writingDurationMinutes:1}),getSessionAudioKey:()=>Buffer.alloc(32)};

for(const mode of ['lis_first','read_first'])test(`Term 1 offline L/R/W in order and one Writing receipt · ${mode}`,async()=>{
  let grading;
  const gradingCalls=[];
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,term1CbtJourneyMode:'on',
    termTestWritingGradingService:{ensureSubmission:input=>{
      const job=grading.ensureSubmission(input);gradingCalls.push(job);return job;
    }}});
  try{
    grading=createTermTestWritingGradingService({pool:f.pool});
    await f.db.exec(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
      SELECT 'term-test-1','Đề giả Term 1',1,listening_definition,reading_definition,true
      FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
    const api=request(f.app);
    const prepared=await api.post(slug+'/session/prepare').send({...identity,examMode:mode,examDelivery:'cbt',orderClientVersion:1});
    assert.ok(prepared.ok,prepared.text);
    const scope={examSessionToken:prepared.body.examSessionToken,generation:0,deviceProof:'a'.repeat(64)};
    const offer=await api.post(slug+'/cbt-journey/prepare').send({...identity,...scope});
    assert.ok(offer.ok,offer.text);
    assert.equal(offer.body.examMode,mode);
    assert.equal(offer.body.version,'term1-k67-cbt-journey-v1');
    const post=(route,body)=>api.post(slug+'/cbt-journey/'+route).set('x-term2-permit',offer.body.permit).send({...scope,...body});
    assert.ok((await post('begin',{})).ok);
    assert.equal((await post('begin',{deviceProof:'b'.repeat(64)})).status,403);
    const wrongTest=await api.post('/api/term-tests/mini-test-lesson-5/cbt-journey/prepare').send({...identity,...scope});
    assert.equal(wrongTest.status,404);
    const before=await f.db.query(`UPDATE assessment.term_k67_cbt_journey SET activated_at=clock_timestamp()-interval '3 minutes'
      WHERE session_id=$1 RETURNING activated_at`,[scope.examSessionToken]);
    const firstAt=new Date(before.rows[0].activated_at).getTime();
    const writing={section:'writing',operationId:randomUUID(),previousOperationId:null,startedAt:firstAt,
      capturedAt:firstAt+60_000,revision:1,automatic:true,eofAt:null,heardSeconds:0,answers:{task1:'',task2:''}};
    assert.equal((await post('seal',writing)).body.error,'OFFLINE_TIMELINE');
    let nextAt=firstAt,previousOperationId=null,attemptToken;
    const order=mode==='lis_first'?['listening','reading']:['reading','listening'];
    for(const section of order){
      const listening=section==='listening';
      const operation={section,operationId:randomUUID(),previousOperationId,startedAt:nextAt,
        capturedAt:nextAt+(listening?8_000:2_000),revision:1,automatic:listening,eofAt:listening?nextAt+6_000:null,
        heardSeconds:listening?6:0,answers:listening?{11:'A'}:{14:'A'}};
      if(listening){
        assert.equal((await post('seal',{...operation,eofAt:null})).body.error,'AUDIO_END_NOT_CONFIRMED');
        assert.equal((await post('seal',{...operation,capturedAt:operation.eofAt+100})).body.error,'OFFLINE_REVIEW_REQUIRED');
      }
      const accepted=await post('seal',operation);
      assert.ok(accepted.ok,accepted.text);
      assert.equal(accepted.body.receipt.completed,false);
      assert.equal(accepted.body.receipt.nextSection,previousOperationId?'writing':order[1]);
      assert.deepEqual((await post('status',{section,operationId:operation.operationId})).body.receipt,accepted.body.receipt);
      previousOperationId=operation.operationId;
      nextAt=operation.capturedAt+1_000;
      attemptToken=accepted.body.receipt.attemptToken;
    }
    const native=await api.post('/api/term-tests/writing').send({attemptToken,action:'start',task1:'',task2:''});
    assert.equal(native.body.error,'TERM_OFFLINE_JOURNEY_ACTIVE',native.text);
    const essay=mode==='lis_first'?'':'This is a synthetic essay.';
    Object.assign(writing,{previousOperationId,startedAt:nextAt,capturedAt:nextAt+60_000,answers:{task1:'',task2:essay}});
    assert.equal((await post('seal',{...writing,capturedAt:writing.capturedAt-1})).body.error,'OFFLINE_REVIEW_REQUIRED');
    assert.equal((await post('status',{section:'writing',operationId:writing.operationId})).body.persisted,false);
    const sealed=await post('seal',writing);
    assert.ok(sealed.ok,sealed.text);
    assert.equal(sealed.body.receipt.completed,true);
    assert.equal(sealed.body.receipt.nextSection,'result');
    assert.deepEqual((await post('seal',writing)).body.receipt,sealed.body.receipt);
    assert.equal((await post('seal',{...writing,answers:{task1:'',task2:'Different'}})).body.error,'OFFLINE_CONFLICT');
    assert.deepEqual((await post('status',{section:'writing',operationId:writing.operationId})).body.receipt,sealed.body.receipt);
    const row=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attemptToken])).rows[0];
    assert.deepEqual(row.listening_answers,{11:'A'});
    assert.deepEqual(row.reading_answers,{14:'A'});
    assert.equal(row.writing_task_2,essay);
    assert.equal(new Date(row.writing_submitted_at).getTime(),writing.capturedAt);
    for(let n=0;n<40&&gradingCalls.length<3;n++)await delay(10);
    assert.equal(gradingCalls.length,3);
    const results=await Promise.all(gradingCalls);
    if(!essay)assert.equal(results[0].writingScore,0);
    const jobs=await f.db.query("SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job WHERE job_type='dispatch'");
    assert.equal(jobs.rows[0].n,essay?1:0);
  }finally{await f.db.close();}
});
