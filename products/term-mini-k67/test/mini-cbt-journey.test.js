import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
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

for(const scenario of ['lis_first','read_first','concurrent','interruption'])
test(`Mini CBT keeps the first receipt and opens the other skill on a second profile · ${scenario}`,async()=>{
  const interrupted=scenario==='interruption';
  const first=scenario==='read_first'||interrupted?'read_first':'lis_first';
  const f=await createMiniFixture({examOrder:true,assets,completeSchema:true,miniCbtJourneyMode:'on',
    term2ParallelEntryMode:'on',pretestCbtJourneyMode:'on',writingHold:{miniCbtParallelEntryMode:'on'}});
  try{
    await f.db.exec(await readFile(new URL('../db/047-pretest-cbt-parallel-entry.sql',import.meta.url),'utf8'));
    await f.db.exec(await readFile(new URL('../db/048-mini-k67-cbt-parallel-entry.sql',import.meta.url),'utf8'));
    const other=first==='lis_first'?'read_first':'lis_first';
    let firstSkill=first==='lis_first'?'listening':'reading';
    let secondSkill=firstSkill==='listening'?'reading':'listening';
    function profile(character,examMode){
      const api=request.agent(f.app);
      const proof=character.repeat(64);
      const prepare=token=>api.post(slug+'/session/prepare').send({...identity,examMode,examDelivery:'cbt',
        orderClientVersion:1,miniContinuationVersion:1,...(token?{examSessionToken:token}:{})});
      const offer=scope=>api.post(slug+'/cbt-journey/prepare').send({...identity,...scope});
      const call=(scope,permit,path,body)=>api.post(slug+'/cbt-journey/'+path)
        .set('x-term2-permit',permit).send({...scope,...body});
      return {api,proof,prepare,offer,call};
    }
    async function enter(client){
      const opened=await client.prepare();
      assert.equal(opened.status,200,opened.text);
      const scope={examSessionToken:opened.body.examSessionToken,generation:opened.body.generation,deviceProof:client.proof};
      const offer=await client.offer(scope);
      assert.equal(offer.status,200,offer.text);
      const permit=offer.body.permit;
      const start=await client.call(scope,permit,'begin',{});
      assert.equal(start.status,200,start.text);
      const shifted=await f.db.query(`UPDATE assessment.mini_k67_cbt_journey
        SET activated_at=clock_timestamp()-interval '30 seconds' WHERE session_id=$1 RETURNING activated_at`,[scope.examSessionToken]);
      return {scope,permit,at:new Date(shifted.rows[0].activated_at).getTime()};
    }
    function sealBody(section,startedAt,answer){
      const listening=section==='listening';
      return {section,operationId:randomUUID(),previousOperationId:null,startedAt,capturedAt:startedAt+(listening?8000:2000),
        revision:1,automatic:listening,eofAt:listening?startedAt+6000:null,heardSeconds:listening?6:0,
        answers:listening?{11:answer}:{14:answer}};
    }
    let a=profile('a',first);
    let b=profile('b',other);
    let scopeA=await enter(a);
    let scopeB=await enter(b);
    assert.notEqual(scopeA.scope.examSessionToken,scopeB.scope.examSessionToken);
    const lookup=await b.api.post(slug+'/attempt/active').send({...identity,orderClientVersion:1});
    assert.equal(lookup.status,200,lookup.text);
    assert.equal(lookup.body.active,false);
    assert.equal(lookup.body.attemptToken,undefined);
    let winning=sealBody(firstSkill,scopeA.at,'B');
    let competing=sealBody(secondSkill,scopeB.at,'C');
    const sendA=()=>a.call(scopeA.scope,scopeA.permit,'seal',winning);
    const sendB=()=>b.call(scopeB.scope,scopeB.permit,'seal',competing);
    let [win,loser]=scenario==='concurrent'?await Promise.all([sendA(),sendB()]):[await sendA(),await sendB()];
    if(scenario==='concurrent'&&loser.status===200) {
      [win,loser]=[loser,win];
      [a,b]=[b,a];
      [scopeA,scopeB]=[scopeB,scopeA];
      [winning,competing]=[competing,winning];
      [firstSkill,secondSkill]=[secondSkill,firstSkill];
    }
    assert.equal(win.status,200,win.text);
    assert.ok(win.body.receipt.receiptId);
    assert.equal(win.body.receipt.completed,false);
    assert.equal(loser.status,409,loser.text);
    assert.equal(loser.body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
    const preAdoption=await b.call(scopeB.scope,scopeB.permit,'status',{section:secondSkill,operationId:competing.operationId});
    assert.equal(preAdoption.status,200,preAdoption.text);
    assert.equal(preAdoption.body.persisted,false);
    const stored=await a.call(scopeA.scope,scopeA.permit,'status',{section:firstSkill,operationId:winning.operationId});
    assert.equal(stored.status,200,stored.text);
    assert.deepEqual(stored.body.receipt,win.body.receipt);
    assert.deepEqual((await a.call(scopeA.scope,scopeA.permit,'seal',winning)).body.receipt,win.body.receipt);
    const progress=await b.prepare(scopeB.scope.examSessionToken);
    assert.equal(progress.status,200,progress.text);
    assert.equal(progress.body.continuationSection,secondSkill);
    assert.equal(progress.body.examSessionToken,scopeB.scope.examSessionToken);
    assert.equal(progress.body[firstSkill+'Submitted'],true);
    assert.equal(progress.body[secondSkill+'Submitted'],false);
    assert.deepEqual(progress.body[firstSkill+'Draft'],{});
    const afterOffer=await b.offer(scopeB.scope);
    assert.equal(afterOffer.status,200,afterOffer.text);
    assert.equal(afterOffer.body.continuationSection,secondSkill);
    assert.equal(afterOffer.body.permit,scopeB.permit);
    assert.equal(afterOffer.body.activatedAt,scopeB.at);
    const notAdopted=await b.call(scopeB.scope,scopeA.permit,'begin',{});
    assert.equal(notAdopted.status,403);
    const actual=interrupted?{section:'listening',operationId:randomUUID(),previousOperationId:null,startedAt:scopeB.at,
      capturedAt:scopeB.at+1000,revision:1,automatic:false,eofAt:null,heardSeconds:0,answers:{}}:sealBody(secondSkill,scopeB.at,'A');
    const path=interrupted?'interrupt':'seal';
    const completed=await b.call(scopeB.scope,scopeB.permit,path,actual);
    assert.equal(completed.status,200,completed.text);
    assert.equal(completed.body.receipt.completed,true);
    assert.equal(completed.body.receipt.nextSection,'result');
    assert.notEqual(completed.body.receipt.receiptId,win.body.receipt.receiptId);
    const recovered=await b.call(scopeB.scope,scopeB.permit,'status',{section:secondSkill,operationId:actual.operationId});
    assert.deepEqual(recovered.body.receipt,completed.body.receipt);
    assert.deepEqual((await b.call(scopeB.scope,scopeB.permit,path,actual)).body.receipt,completed.body.receipt);
    const rows=(await f.db.query(`SELECT id,reading_answers,listening_answers,combined_result
      FROM assessment.term_test_attempt WHERE test_slug='mini-test-lesson-5'
        AND (reading_submitted_at IS NOT NULL OR listening_submitted_at IS NOT NULL) AND superseded_at IS NULL`)).rows;
    assert.equal(rows.length,1);
    assert.equal(rows[0].id,win.body.receipt.attemptToken);
    assert.deepEqual(rows[0][firstSkill+'_answers'],winning.answers);
    assert.deepEqual(rows[0][secondSkill+'_answers'],interrupted?null:actual.answers);
    const result=await b.api.post('/api/term-tests/result').send({officialMini:identity});
    assert.equal(result.status,200,result.text);
    assert.deepEqual(result.body.result,rows[0].combined_result);
    assert.equal(result.body.result[firstSkill].correct,0);
    if(interrupted){
      assert.equal(completed.body.receipt.outcome,'interrupted');
      assert.equal(result.body.result.listeningStatus,'interrupted');
      assert.equal(result.body.result.listening,null);
      assert.equal(result.body.result.summary.totalCorrect,0);
    }else{
      assert.equal(result.body.result[secondSkill].correct,1);
      assert.equal(result.body.result.summary.totalCorrect,1);
    }
    assert.equal(result.body.officialMini,true);
    assert.equal(result.body.portalSyncStatus,'not_applicable');
    assert.equal(result.body.attemptToken,undefined);
  }finally{await f.db.close();}
});

test('Mini CBT keeps an existing answer-sheet result on the paper route after migration',async()=>{
  const f=await createMiniFixture({examOrder:true,assets,completeSchema:true,miniCbtJourneyMode:'on',
    term2ParallelEntryMode:'on',pretestCbtJourneyMode:'on',writingHold:{miniCbtParallelEntryMode:'on'}});
  try{
    await f.db.exec(await readFile(new URL('../db/047-pretest-cbt-parallel-entry.sql',import.meta.url),'utf8'));
    const api=request(f.app);
    const paper=slug+'/answer-sheet';
    const opened=await api.post(paper+'/open').send({...identity,identityConfirmed:true,examMode:'lis_first'});
    assert.equal(opened.status,200,opened.text);
    const submitted=await api.post(paper+'/listening').send({examSessionToken:opened.body.examSessionToken,generation:0,
      clientSubmissionId:randomUUID(),answers:{11:'A'}});
    assert.equal(submitted.status,201,submitted.text);
    const scope={attemptToken:submitted.body.attemptToken,generation:0};
    const started=await api.post(paper+'/reading/start').send(scope);
    assert.equal(started.status,200,started.text);
    const before=await api.post(paper+'/reading').send({...scope,answers:{14:'A'}});
    assert.equal(before.status,200,before.text);
    await f.db.exec(await readFile(new URL('../db/048-mini-k67-cbt-parallel-entry.sql',import.meta.url),'utf8'));
    const rejected=await api.post(slug+'/session/prepare').send({...identity,examMode:'lis_first',examDelivery:'cbt',
      orderClientVersion:1,miniContinuationVersion:1});
    assert.equal(rejected.status,409,rejected.text);
    assert.equal(rejected.body.error,'MODE_CONFLICT');
    const hidden=await api.post('/api/term-tests/result').send({officialMini:identity});
    assert.equal(hidden.status,404,hidden.text);
    const readback=await api.post(paper+'/result').send(scope);
    assert.equal(readback.status,200,readback.text);
    assert.deepEqual(readback.body.result,before.body.result);
    assert.equal(readback.body.result.reading.correct,1);
    assert.equal(readback.body.result.listening.correct,1);
  }finally{await f.db.close();}
});
