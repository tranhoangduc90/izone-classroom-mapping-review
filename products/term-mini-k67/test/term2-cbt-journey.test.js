import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';
import {createTermTestWritingGradingService} from '../src/term-test-writing-grading.js';
import {publicAudioCatalog} from '../src/public-audio-catalog.js';
import {pruneExpiredWritingHolds} from '../src/mini-cbt-journey.js';

const slug='/api/term-tests/term-test-2';
const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111'};
const definitions=[{id:'task1',prompt:'Đề giả Task 1'},{id:'task2',prompt:'Đề giả Task 2'}];
const nativeDurationSeconds=1843.2;
const reviewSeconds=120;
const assets={supports:()=>true,getContent:()=>({title:'Fixture',writing:{tasks:definitions}}),
  getTiming:()=>({readingDurationMinutes:1,listeningDurationSeconds:1844,listeningTotalSeconds:1964,
    listeningReviewSeconds:reviewSeconds,writingDurationMinutes:1}),getSessionAudioKey:()=>Buffer.alloc(32)};

for(const mode of ['lis_first','read_first'])test(`Term 2 offline L/R/W in order and one Writing receipt · ${mode}`,async t=>{
  let grading;
  const gradingCalls=[];
  const journal=[];
  const holdEnabled=mode==='read_first';
  const holdClasses=new Set([holdEnabled?identity.classCode:'FIXTURE-OTHER-CLASS']);
  let failQueue=holdEnabled;
  const directory=await mkdtemp(join(tmpdir(),'term2-r2-test-'));
  const term2R2ConfigFile=join(directory,'config.json');
  await writeFile(term2R2ConfigFile,JSON.stringify({enabled:true,accountId:'0'.repeat(32),bucket:'synthetic',
    accessKeyId:'synthetic',secretAccessKey:'synthetic',assets:[publicAudioCatalog['term-test-2'].sha256]}));
  t.after(async()=>{await unlink(term2R2ConfigFile);await rmdir(directory);});
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,term2CbtJourneyMode:'on',term2R2ConfigFile,
    writingHold:{term2WritingHoldHours:2,term2WritingHoldLimit:3,
      term2WritingHoldClasses:holdClasses},
    mountJournal:()=>({business(event,testSlug,_token,details){
      if (testSlug==='term-test-2' && details.submission) journal.push({event,...details});
      if (event==='submission_completed') throw new Error('Synthetic journal outage');
    }}),
    termTestWritingGradingService:{ensureSubmission:input=>{
      const job=grading.ensureSubmission(input);gradingCalls.push(job);return job;
    },ensureSubmissionInTransaction:async (db,input)=>{
      const result=await grading.ensureSubmissionInTransaction(db,input);
      if (failQueue) throw new Error('Synthetic failure after writing the jobs');
      gradingCalls.push(result);
      return result;
    }}});
  try{
    grading=createTermTestWritingGradingService({pool:f.pool});
    await f.db.exec(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
      SELECT 'term-test-2','Đề giả Term 2',1,listening_definition,reading_definition,true
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
    assert.equal(offer.body.version,'term2-k67-cbt-journey-v1');
    assert.equal((await f.db.query('SELECT writing_hold_cohort FROM assessment.term_k67_cbt_journey WHERE session_id=$1',
      [scope.examSessionToken])).rows[0].writing_hold_cohort,holdEnabled);
    // Rollout may stop enrolling new sessions. This native session keeps its original policy.
    holdClasses.clear();
    assert.equal(offer.body.audioManifest.sha256,publicAudioCatalog['term-test-2'].sha256);
    assert.equal(offer.body.audioDownload?.sha256,publicAudioCatalog['term-test-2'].sha256);
    assert.equal(offer.body.audioDownload?.validForSeconds,600);
    const post=(route,body)=>api.post(slug+'/cbt-journey/'+route).set('x-term2-permit',offer.body.permit).send({...scope,...body});
    assert.ok((await post('begin',{})).ok);
    assert.equal((await post('begin',{deviceProof:'b'.repeat(64)})).status,403);
    const wrongTest=await api.post('/api/term-tests/mini-test-lesson-5/cbt-journey/prepare').send({...identity,...scope});
    assert.equal(wrongTest.status,404);
    const before=await f.db.query(`UPDATE assessment.term_k67_cbt_journey SET activated_at=clock_timestamp()-interval '40 minutes'
      WHERE session_id=$1 RETURNING activated_at`,[scope.examSessionToken]);
    const firstAt=new Date(before.rows[0].activated_at).getTime();
    const writing={section:'writing',operationId:randomUUID(),previousOperationId:null,startedAt:firstAt,
      capturedAt:firstAt+60_000,revision:1,automatic:true,eofAt:null,heardSeconds:0,answers:{task1:'',task2:''}};
    const wrongPrevious={...writing,operationId:randomUUID()};
    assert.equal((await post('seal',wrongPrevious)).body.error,'OFFLINE_TIMELINE');
    let nextAt=firstAt,previousOperationId=null,attemptToken;
    const order=mode==='lis_first'?['listening','reading']:['reading','listening'];
    for(const section of order){
      const listening=section==='listening';
      const eofAt=listening?nextAt+nativeDurationSeconds*1000:null;
      const operation={section,operationId:randomUUID(),previousOperationId,startedAt:nextAt,
        capturedAt:listening?eofAt+reviewSeconds*1000:nextAt+2_000,revision:1,automatic:listening,eofAt,
        heardSeconds:listening?nativeDurationSeconds:0,answers:listening?{11:'A'}:{14:'A'}};
      let early;
      if(listening){
        assert.equal((await post('seal',{...operation,eofAt:null})).body.error,'AUDIO_END_NOT_CONFIRMED');
        assert.equal((await post('seal',{...operation,heardSeconds:nativeDurationSeconds-0.3})).body.error,'AUDIO_END_NOT_CONFIRMED');
        early=await post('seal',{...operation,capturedAt:operation.capturedAt-1});
      }
      const accepted=await post('seal',operation);
      assert.ok(accepted.ok,accepted.text);
      if(listening){
        assert.equal(early.body.error,'OFFLINE_REVIEW_REQUIRED');
        assert.equal(offer.body.timing.listeningDurationSeconds,nativeDurationSeconds);
      }
      assert.equal(accepted.body.receipt.completed,false);
      assert.equal(accepted.body.receipt.nextSection,previousOperationId?'writing':order[1]);
      assert.deepEqual((await post('status',{section,operationId:operation.operationId})).body.receipt,accepted.body.receipt);
      previousOperationId=operation.operationId;
      nextAt=operation.capturedAt+1_000;
      attemptToken=accepted.body.receipt.attemptToken;
    }
    const native=await api.post('/api/term-tests/writing').send({attemptToken,action:'start',task1:'',task2:''});
    assert.equal(native.body.error,'TERM_OFFLINE_JOURNEY_ACTIVE',native.text);
    const essay=mode==='lis_first'?'\u200b\u2060\u200d':'This is a synthetic Task 2 essay.';
    const task1=mode==='lis_first'?'This is a synthetic Task 1 report.':'\u200b\u2060\u200d';
    Object.assign(writing,{previousOperationId,startedAt:nextAt,capturedAt:nextAt+60_000,answers:{task1,task2:essay}});
    const wrongCapture={...writing,operationId:randomUUID(),capturedAt:writing.capturedAt-1};
    assert.equal((await post('seal',wrongCapture)).body.error,'OFFLINE_REVIEW_REQUIRED');
    const connect=f.pool.connect;
    let serverNow=writing.capturedAt-500;
    let loseCommit=false;
    f.pool.connect=async()=>{
      const client=await connect.call(f.pool);
      let updatedWriting=false;
      return {release:()=>client.release(),query:async (sql,args)=>{
        if(sql==='SELECT clock_timestamp() AS now') return {rows:[{now:new Date(serverNow)}]};
        const result=await client.query(sql,args);
        if(sql.includes('UPDATE assessment.term_test_attempt SET writing_task_1=')) updatedWriting=true;
        if(sql==='COMMIT'&&updatedWriting&&loseCommit){
          loseCommit=false;
          throw new Error('Synthetic lost acknowledgement after database commit');
        }
        return result;
      }};
    };
    const writingStatus=()=>post('status',{section:'writing',operationId:writing.operationId});
    let sealed;
    try {
      const early=await post('seal',writing);
      assert.equal(early.status,409);
      assert.equal(early.body.error,'OFFLINE_REVIEW_REQUIRED');
      const status=await writingStatus();
      assert.equal(status.body.persisted,false);
      if (holdEnabled) {
        assert.equal(early.body.reasonCode,'SERVER_BEFORE_DEADLINE');
        assert.equal(early.body.retryAfterMs,500);
        assert.deepEqual(status.body.held,early.body.held);
        const changed={...writing,answers:{task1:'',task2:'Unrelated text'}};
        assert.equal((await post('seal',changed)).body.error,'OFFLINE_CONFLICT');
        assert.equal((await post('seal',{...writing,operationId:randomUUID()})).body.error,'OFFLINE_HOLD_FULL');
        const held=(await f.db.query(`SELECT payload FROM assessment.term_k67_writing_submission_hold
          WHERE session_id=$1 AND operation_id=$2`,[scope.examSessionToken,writing.operationId])).rows[0].payload;
        assert.deepEqual(held.answers,writing.answers);
        assert.equal(held.deviceProof,undefined);
        assert.equal((await post('status',{section:'writing',operationId:writing.operationId,deviceProof:'f'.repeat(64)})).status,403);
      } else assert.equal(status.body.held,undefined);
      const beforeWriting=(await f.db.query(
        'SELECT writing_submitted_at, writing_task_1, writing_task_2 FROM assessment.term_test_attempt WHERE id=$1',
        [attemptToken]
      )).rows[0];
      assert.deepEqual(beforeWriting,{writing_submitted_at:null,writing_task_1:'',writing_task_2:''});
      assert.equal(gradingCalls.length,0);
      serverNow=writing.capturedAt;
      if (holdEnabled) {
        const failed=await post('seal',writing);
        assert.equal(failed.body.error,'OFFLINE_SUBMISSION_UNAVAILABLE');
        assert.equal(failed.body.held,undefined);
        const afterRollback=await writingStatus();
        assert.equal(afterRollback.body.persisted,false);
        assert.deepEqual(afterRollback.body.held,early.body.held);
        assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job')).rows[0].n,0);
        failQueue=false;
        loseCommit=true;
        const results=await Promise.all([post('seal',writing),post('seal',writing)]);
        const missing=results.find(response=>response.status===503);
        assert.equal(missing?.body.error,'OFFLINE_SUBMISSION_UNAVAILABLE');
        assert.equal(missing.body.held,undefined);
        sealed=results.find(response=>response.ok);
        assert.deepEqual((await writingStatus()).body.receipt,sealed?.body.receipt);
      }else{
        sealed=await post('seal',writing);
      }
    } finally {
      f.pool.connect=connect;
    }
    assert.ok(sealed.ok,sealed.text);
    assert.equal(sealed.body.receipt.completed,true);
    assert.equal(sealed.body.receipt.nextSection,'result');
    assert.deepEqual((await post('seal',writing)).body.receipt,sealed.body.receipt);
    assert.equal((await post('seal',{...writing,answers:{task1:'',task2:'Different'}})).body.error,'OFFLINE_CONFLICT');
    assert.deepEqual((await post('status',{section:'writing',operationId:writing.operationId})).body.receipt,sealed.body.receipt);
    assert.equal(journal.find(row=>row.submission.operationId===wrongPrevious.operationId).reason,'PREVIOUS_OPERATION_MISMATCH');
    assert.equal(journal.find(row=>row.submission.operationId===wrongCapture.operationId).reason,'AUTO_CAPTURE_NOT_AT_DEADLINE');
    const observations=journal.filter(row=>row.submission.operationId===writing.operationId);
    assert.deepEqual(observations.map(row=>row.reason).sort(),(holdEnabled?[
      'SERVER_BEFORE_DEADLINE','OFFLINE_CONFLICT','SUBMISSION_TRANSACTION_UNCONFIRMED',
      'SUBMISSION_TRANSACTION_UNCONFIRMED','RECEIPT_REPLAYED','RECEIPT_REPLAYED','OFFLINE_CONFLICT'
    ]:['SERVER_BEFORE_DEADLINE','RECEIPT_COMMITTED','RECEIPT_REPLAYED','OFFLINE_CONFLICT']).sort());
    assert.equal(observations[0].submission.serverAtMs,writing.capturedAt-500);
    assert.equal(observations[0].submission.deadlineAtMs,writing.capturedAt);
    const committed=observations.find(row=>row.event===(holdEnabled?'offline_submission_replayed':'submission_completed'));
    assert.equal(committed.submission.task1Length,task1.length);
    assert.equal(committed.submission.task2Length,essay.length);
    assert.doesNotMatch(JSON.stringify(observations), /synthetic Task|deviceProof|examSessionToken|permit/);
    const row=(await f.db.query('SELECT * FROM assessment.term_test_attempt WHERE id=$1',[attemptToken])).rows[0];
    assert.deepEqual(row.listening_answers,{11:'A'});
    assert.deepEqual(row.reading_answers,{14:'A'});
    assert.equal(row.writing_task_1,task1);
    assert.equal(row.writing_task_2,essay);
    assert.equal(new Date(row.writing_submitted_at).getTime(),writing.capturedAt);
    const gradingReads=holdEnabled?5:3;
    for(let n=0;n<40&&gradingCalls.length<gradingReads;n++)await delay(10);
    assert.equal(gradingCalls.length,gradingReads);
    const results=await Promise.all(gradingCalls);
    assert.equal(results[0].writingScore,null);
    const jobs=await f.db.query("SELECT count(*)::int AS n FROM assessment.term_test_writing_grading_job WHERE job_type='dispatch'");
    assert.equal(jobs.rows[0].n,1);
    if(holdEnabled){
      await f.db.query(`UPDATE assessment.term_k67_writing_submission_hold SET
        held_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
        WHERE operation_id=$1`,[wrongCapture.operationId]);
      await pruneExpiredWritingHolds(f.pool);
      const retained=(await f.db.query(`SELECT operation_id,payload IS NOT NULL AS has_payload
        FROM assessment.term_k67_writing_submission_hold`)).rows;
      assert.equal(retained.find(row=>row.operation_id===wrongCapture.operationId)?.has_payload,false);
      assert.equal(retained.find(row=>row.operation_id===wrongPrevious.operationId)?.has_payload,true);
      assert.deepEqual((await writingStatus()).body.receipt,sealed.body.receipt);
    }
  }finally{await f.db.close();}
});
