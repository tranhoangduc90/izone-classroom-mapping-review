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
  const holdScopeFile=mode==='lis_first'?join(directory,'hold-scope.json'):undefined;
  await writeFile(term1R2ConfigFile,JSON.stringify({enabled:true,accountId:'0'.repeat(32),bucket:'synthetic',
    accessKeyId:'synthetic',secretAccessKey:'synthetic',assets:[publicAudioCatalog['term-test-1'].sha256]}));
  if(holdScopeFile)await writeFile(holdScopeFile,JSON.stringify({classes:[identity.classCode]}));
  t.after(async()=>{
    if(holdScopeFile)await unlink(holdScopeFile);
    await unlink(term1R2ConfigFile);
    await rmdir(directory);
  });
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,term1CbtJourneyMode:'on',term1R2ConfigFile,
    writingHold:{term1WritingHoldHours:2,term1WritingHoldLimit:mode==='lis_first'?2:20,
      term1WritingHoldClasses:new Set(holdScopeFile?[]:[identity.classCode]),term1WritingHoldClassesFile:holdScopeFile,
      termCbtLrHoldHours:2,termCbtLrHoldLimit:20,term1CbtLrHoldClasses:new Set([identity.classCode])},
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
    assert.equal(offer.body.readingDeadlineReviewVersion,1);
    assert.equal(offer.body.audioDownload?.sha256,publicAudioCatalog['term-test-1'].sha256);
    assert.equal(offer.body.audioDownload?.validForSeconds,600);
    if(holdScopeFile){
      const cohort=async token=>(await f.db.query('SELECT writing_hold_cohort FROM assessment.term_k67_cbt_journey WHERE session_id=$1',
        [token])).rows[0].writing_hold_cohort;
      assert.equal(await cohort(scope.examSessionToken),true,'file admitted the first session');
      await writeFile(holdScopeFile,'{"classes":[]}');
      const resumed=await api.post(slug+'/cbt-journey/prepare').send({...identity,...scope});
      assert.ok(resumed.ok,resumed.text);
      assert.equal(await cohort(scope.examSessionToken),true,'the enrolled session still drains');
      const nextIdentity={...identity,studentRef:'44444444-4444-4444-8444-444444444444'};
      const preparedNext=await api.post(slug+'/session/prepare').send({...nextIdentity,examMode:mode,examDelivery:'cbt',orderClientVersion:1});
      assert.ok(preparedNext.ok,preparedNext.text);
      const next=await api.post(slug+'/cbt-journey/prepare').send({...nextIdentity,examSessionToken:preparedNext.body.examSessionToken,
        generation:0,deviceProof:'c'.repeat(64)});
      assert.ok(next.ok,next.text);
      assert.equal(await cohort(preparedNext.body.examSessionToken),false,'the closed scope excludes new sessions');
    }
    const post=(route,body)=>api.post(slug+'/cbt-journey/'+route).set('x-term2-permit',offer.body.permit).send({...scope,...body});
    const withFixtureClock=async (now,run)=>{
      const connect=f.pool.connect;
      f.pool.connect=async()=>{
        const db=await connect.call(f.pool);
        return {release:()=>db.release(),query:(sql,params)=>sql==='SELECT clock_timestamp() AS now'
          ? Promise.resolve({rows:[{now:new Date(now)}]}) : db.query(sql,params)};
      };
      try{return await run();}finally{f.pool.connect=connect;}
    };
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
        capturedAt:nextAt+(listening?8_000:60_000),revision:1,automatic:true,eofAt:listening?nextAt+6_000:null,
        heardSeconds:listening?6:0,answers:listening?{11:'A'}:{14:'A'}};
      if(listening){
        const noEof=await post('seal',{...operation,operationId:randomUUID(),eofAt:null});
        assert.equal(noEof.body.reasonCode,'AUDIO_END_NOT_CONFIRMED');
        assert.ok(noEof.body.held?.payloadHash);
        const noReview=await post('seal',{...operation,operationId:randomUUID(),capturedAt:operation.eofAt+100});
        assert.equal(noReview.body.reasonCode,'AUTO_CAPTURE_BEFORE_DEADLINE');
      }else{
        const reviewOnly={...operation,operationId:randomUUID(),capturedAt:operation.capturedAt+1};
        const retained=await post('reading-review',reviewOnly);
        assert.equal(retained.status,409);
        assert.equal(retained.body.reasonCode,'READING_DRAFT_NOT_VERIFIED');
        assert.ok(retained.body.held?.payloadHash);
        assert.deepEqual((await post('status',{section,operationId:reviewOnly.operationId})).body,
          {ok:true,persisted:false,receipt:null,held:retained.body.held});
        const replay=await post('seal',reviewOnly);
        assert.equal(replay.body.reasonCode,'READING_DRAFT_NOT_VERIFIED');
        const {rows:[held]}=await f.db.query(`SELECT payload,review_only FROM assessment.term_k67_lr_submission_hold
          WHERE session_id=$1 AND section=$2 AND operation_id=$3`,[scope.examSessionToken,section,reviewOnly.operationId]);
        assert.equal(held.review_only,true);
        assert.deepEqual(held.payload.answers,reviewOnly.answers);
        const wrongPrevious=await post('seal',{...operation,operationId:randomUUID(),previousOperationId:randomUUID()});
        assert.equal(wrongPrevious.body.reasonCode,'PREVIOUS_OPERATION_MISMATCH');
        assert.ok(wrongPrevious.body.held?.payloadHash);
        const invalid={...operation,operationId:randomUUID(),answers:{99:'invalid'}};
        assert.equal((await post('seal',invalid)).status,400);
        const invalidStatus=await post('status',{section,operationId:invalid.operationId});
        assert.deepEqual(invalidStatus.body,{ok:true,persisted:false,receipt:null});
      }
      await withFixtureClock(operation.capturedAt-500,async()=>{
        const early=await post('seal',operation);
        assert.equal(early.status,409);
        assert.equal(early.body.reasonCode,'SERVER_BEFORE_DEADLINE');
        assert.equal(early.body.retryAfterMs,500);
        const status=await post('status',{section,operationId:operation.operationId});
        assert.equal(status.body.persisted,false);
        assert.deepEqual(status.body.held,early.body.held);
        const {rows:[held]}=await f.db.query(`SELECT payload FROM assessment.term_k67_lr_submission_hold
          WHERE session_id=$1 AND section=$2 AND operation_id=$3`,[scope.examSessionToken,section,operation.operationId]);
        assert.deepEqual(held.payload.answers,operation.answers);
        assert.equal(held.payload.deviceProof,undefined);
        assert.equal((await post('status',{section,operationId:operation.operationId,deviceProof:'b'.repeat(64)})).status,403);
      });
      if(mode==='read_first'&&!previousOperationId){
        await f.db.query(`UPDATE assessment.term_k67_lr_submission_hold
          SET held_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
          WHERE session_id=$1 AND operation_id=$2`,[scope.examSessionToken,operation.operationId]);
        const changed=await post('seal',{...operation,answers:{14:'B'}});
        assert.equal(changed.body.error,'OFFLINE_CONFLICT');
      }
      const accepted=await post('seal',operation);
      assert.ok(accepted.ok,accepted.text);
      assert.equal(accepted.body.receipt.completed,false);
      assert.equal(accepted.body.receipt.nextSection,previousOperationId?'writing':order[1]);
      assert.deepEqual((await post('status',{section,operationId:operation.operationId})).body.receipt,accepted.body.receipt);
      const second={...operation,operationId:randomUUID(),answers:listening?{11:'B'}:{14:'B'}};
      assert.deepEqual((await post('status',{section,operationId:second.operationId})).body,
        {ok:true,persisted:false,receipt:null,conflict:true});
      const conflict=await post('seal',second);
      assert.equal(conflict.body.reasonCode,'OFFLINE_CONFLICT');
      assert.ok(conflict.body.held?.payloadHash);
      assert.deepEqual((await post('status',{section,operationId:second.operationId})).body.held,conflict.body.held);
      const original=await post('seal',operation);
      assert.deepEqual(original.body.receipt,accepted.body.receipt);
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
    if(mode==='lis_first')await f.db.query(`WITH other_session AS (
      INSERT INTO assessment.term_test_exam_session
        (test_slug,definition_version,erp_course_class_id,class_name_snapshot,erp_student_contact_id,student_name_snapshot)
      VALUES('term-test-1',1,1294,'IC2305',900003,'Other fixture learner') RETURNING id
    ) INSERT INTO assessment.term_k67_writing_submission_hold
      (session_id,generation,operation_id,payload_hash,payload,held_at,expires_at)
    SELECT id,0,$1,$2,'{}'::jsonb,now(),now()+interval '2 hours' FROM other_session`,[randomUUID(),'a'.repeat(64)]);
    const review=await post('seal',wrongCapture);
    assert.equal(review.body.error,'OFFLINE_REVIEW_REQUIRED');
    assert.equal(review.body.reasonCode,'AUTO_CAPTURE_NOT_AT_DEADLINE');
    assert.ok(review.body.held?.payloadHash);
    assert.equal((await post('seal',invalidTask)).status,400);
    const writingStatus=()=>post('status',{section:'writing',operationId:writing.operationId});
    await withFixtureClock(writing.capturedAt-500,async()=>{
      const early=await post('seal',writing);
      assert.equal(early.status,409);
      assert.equal(early.body.reasonCode,'SERVER_BEFORE_DEADLINE');
      assert.equal(early.body.retryAfterMs,500);
      const status=await writingStatus();
      assert.equal(status.body.persisted,false);
      assert.deepEqual(status.body.held,early.body.held);
      const held=await f.db.query(`SELECT operation_id,payload FROM assessment.term_k67_writing_submission_hold
        WHERE session_id=$1 AND operation_id IN ($2,$3)`,[scope.examSessionToken,writing.operationId,invalidTask.operationId]);
      assert.equal(held.rows.length,mode==='lis_first'?0:1);
      if(mode==='read_first')assert.deepEqual(held.rows[0].payload.answers,writing.answers);
      assert.equal(gradingCalls.length,0);
    });
    if(mode==='read_first')await f.db.query(`UPDATE assessment.term_k67_writing_submission_hold
      SET held_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
      WHERE session_id=$1 AND operation_id=$2`,[scope.examSessionToken,writing.operationId]);
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
