import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {createTermTestWritingGradingService} from '../src/term-test-writing-grading.js';
import {publicAudioCatalog} from '../src/public-audio-catalog.js';

const slug='/api/term-tests/term-test-1';
const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
const definitions=[{id:'task2',prompt:'Đề giả Task 2'}];
const assets={supports:()=>true,getContent:()=>({title:'Fixture',writing:{tasks:definitions}}),
  getTiming:()=>({readingDurationMinutes:1,listeningDurationSeconds:6,listeningTotalSeconds:8,
    listeningReviewSeconds:2,writingDurationMinutes:1}),getSessionAudioKey:()=>Buffer.alloc(32)};

for(const mode of ['lis_first','read_first'])test(`Term 1 offline L/R/W in order and one Writing receipt · ${mode}`,async t=>{
  let grading;
  const gradingCalls=[];
  const directory=await mkdtemp(join(tmpdir(),'term1-r2-test-'));
  const term1R2ConfigFile=join(directory,'config.json');
  await writeFile(term1R2ConfigFile,JSON.stringify({enabled:true,accountId:'0'.repeat(32),bucket:'synthetic',
    accessKeyId:'synthetic',secretAccessKey:'synthetic',assets:[publicAudioCatalog['term-test-1'].sha256]}));
  t.after(async()=>{await unlink(term1R2ConfigFile);await rmdir(directory);});
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,term1CbtJourneyMode:'on',term1R2ConfigFile,
    writingHold:{term1WritingHoldHours:2,term1WritingHoldLimit:20,term1WritingHoldClasses:new Set([identity.classCode])},
    termTestWritingGradingService:{ensureSubmission:input=>{
      const job=grading.ensureSubmission(input);gradingCalls.push(job);return job;
    },ensureSubmissionInTransaction:async (db,input)=>{
      const result=await grading.ensureSubmissionInTransaction(db,input);
      gradingCalls.push(result);
      return result;
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
    const wrongOwner=await api.post(slug+'/cbt-journey/prepare').send({...identity,...scope,studentRef:'44444444-4444-4444-8444-444444444444'});
    assert.equal(wrongOwner.status,403);
    assert.equal(wrongOwner.body.audioDownload,undefined);
    const offer=await api.post(slug+'/cbt-journey/prepare').send({...identity,...scope});
    assert.ok(offer.ok,offer.text);
    assert.equal(offer.body.examMode,mode);
    assert.equal(offer.body.version,'term1-k67-cbt-journey-v1');
    assert.equal(offer.body.audioDownload?.sha256,publicAudioCatalog['term-test-1'].sha256);
    assert.equal(offer.body.audioDownload?.validForSeconds,600);
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
    assert.equal((await post('seal',{...writing,operationId:randomUUID()})).body.error,'OFFLINE_TIMELINE');
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
    const essay=mode==='lis_first'?'\u200b\u2060\u200d':'This is a synthetic essay.';
    const shouldDispatch=mode==='read_first';
    Object.assign(writing,{previousOperationId,startedAt:nextAt,capturedAt:nextAt+60_000,answers:{task1:'',task2:essay}});
    const wrongCapture={...writing,operationId:randomUUID(),capturedAt:writing.capturedAt-1};
    const invalidTask={...writing,operationId:randomUUID(),answers:{task1:'Invalid Task 1',task2:essay}};
    const review=await post('seal',wrongCapture);
    assert.equal(review.body.error,'OFFLINE_REVIEW_REQUIRED');
    assert.equal(review.body.reasonCode,'AUTO_CAPTURE_NOT_AT_DEADLINE');
    assert.ok(review.body.held?.payloadHash);
    assert.equal((await post('seal',invalidTask)).status,400);
    const writingStatus=()=>post('status',{section:'writing',operationId:writing.operationId});
    const connect=f.pool.connect;
    f.pool.connect=async()=>{
      const db=await connect.call(f.pool);
      return {release:()=>db.release(),query:(sql,params)=>sql==='SELECT clock_timestamp() AS now'
        ? Promise.resolve({rows:[{now:new Date(writing.capturedAt-500)}]}) : db.query(sql,params)};
    };
    try{
      const early=await post('seal',writing);
      assert.equal(early.status,409);
      assert.equal(early.body.reasonCode,'SERVER_BEFORE_DEADLINE');
      assert.equal(early.body.retryAfterMs,500);
      const status=await writingStatus();
      assert.equal(status.body.persisted,false);
      assert.deepEqual(status.body.held,early.body.held);
      const held=await f.db.query(`SELECT operation_id,payload FROM assessment.term_k67_writing_submission_hold
        WHERE session_id=$1 AND operation_id IN ($2,$3)`,[scope.examSessionToken,writing.operationId,invalidTask.operationId]);
      assert.equal(held.rows.length,1);
      assert.deepEqual(held.rows[0].payload.answers,writing.answers);
      assert.equal(gradingCalls.length,0);
    }finally{f.pool.connect=connect;}
    const sealed=await post('seal',writing);
    assert.ok(sealed.ok,sealed.text);
    assert.equal(sealed.body.receipt.completed,true);
    assert.equal(sealed.body.receipt.nextSection,'result');
    assert.deepEqual((await post('seal',writing)).body.receipt,sealed.body.receipt);
    assert.equal((await post('seal',{...writing,answers:{task1:'',task2:'Different'}})).body.error,'OFFLINE_CONFLICT');
    assert.deepEqual((await writingStatus()).body.receipt,sealed.body.receipt);
    const row=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attemptToken])).rows[0];
    assert.deepEqual(row.listening_answers,{11:'A'});
    assert.deepEqual(row.reading_answers,{14:'A'});
    assert.equal(row.writing_task_2,essay);
    assert.equal(new Date(row.writing_submitted_at).getTime(),writing.capturedAt);
    assert.equal(gradingCalls.length,3);
    const results=await Promise.all(gradingCalls);
    if(!shouldDispatch)assert.equal(results[0].writingScore,0);
    const jobs=await f.db.query("SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job WHERE job_type='dispatch'");
    assert.equal(jobs.rows[0].n,shouldDispatch?1:0);
  }finally{await f.db.close();}
});
