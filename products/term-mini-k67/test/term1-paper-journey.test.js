import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import request from 'supertest';
import {createMiniFixture} from './helpers/mini-answer-sheet-fixture.js';

const identity={classCode:'IC2304',studentRef:'11111111-1111-4111-8111-111111111111',identityConfirmed:true};
const deviceProof='a'.repeat(64);
const assets={supports:()=>true,getTiming:()=>({readingDurationMinutes:60}),getContent:()=>{
  throw new Error('Paper must not load CBT content');
}};

for(const first of ['listening','reading'])test(`Term 1 paper opens two profiles and continues from the official ${first} receipt`,async t=>{
  const portal=[];
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,term1PaperJourneyMode:'on',
    term1ParallelEntryEnabled:true,syncErpGrades:async payload=>portal.push(payload),
    writingHold:{termPaperLrHoldHours:2,termPaperLrHoldLimit:20,term1PaperLrHoldClasses:new Set([identity.classCode])}});
  t.after(()=>f.db.close());
  await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT 'term-test-1','Đề phiếu giả',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
  const root='/api/term-tests/term-test-1';
  const api=request(f.app);
  const proofs=['a','b','c'].map(char=>char.repeat(64));
  const mode=section=>section==='reading'?'read_first':'lis_first';
  const second=first==='listening'?'reading':'listening';
  const prepare=(proof,examMode,server=api,extra={})=>server.post(root+'/paper-journey/prepare').send({
    ...identity,deviceProof:proof,examMode,term1PaperParallelVersion:1,...extra
  });
  const post=(bundle,proof,route,payload,server=api)=>server.post(root+'/paper-journey/'+route)
    .set('x-term2-permit',bundle.permit)
    .send({examSessionToken:bundle.examSessionToken,generation:bundle.generation,deviceProof:proof,...payload});
  const op=(bundle,section,answer)=>({operationId:randomUUID(),section,previousOperationId:null,
    startedAt:bundle.activatedAt+30,capturedAt:bundle.activatedAt+30,revision:1,automatic:false,eofAt:null,heardSeconds:0,
    answers:{[section==='listening'?11:14]:answer}});

  assert.equal((await prepare(proofs[0],mode(first),api,{classCode:'WRONG'})).status,403);
  const legacy=()=>prepare('d'.repeat(64),mode(first),api,{term1PaperParallelVersion:undefined});
  const old=await legacy();
  assert.ok(old.ok,old.body.error);
  const a=await prepare(proofs[0],mode(first));
  const b=await prepare(proofs[1],mode(second));
  const other=await prepare(proofs[2],mode(first));
  for(const reply of [a,b,other])assert.ok(reply.ok,reply.body.error);
  assert.equal(new Set([a,b,other].map(reply=>reply.body.examSessionToken)).size,3);
  assert.equal((await legacy()).body.examSessionToken,old.body.examSessionToken);
  assert.equal(a.body.examDelivery,'answer_sheet');
  assert.equal(b.body.audioManifest,undefined);
  assert.equal((await prepare(proofs[0],mode(second))).body.examSessionToken,a.body.examSessionToken);
  const mismatched=await post(a.body,proofs[1],'seal',op(a.body,first,'Unexpected proof'));
  assert.equal(mismatched.status,403);
  const openCbt=token=>api.post(root+'/session/prepare').send({...identity,examSessionToken:token,
    examMode:mode(first),orderClientVersion:1,term1ContinuationVersion:1});
  const unrelatedCbt=await openCbt(a.body.examSessionToken);
  assert.ok(unrelatedCbt.ok,unrelatedCbt.body.error);
  assert.notEqual(unrelatedCbt.body.examSessionToken,a.body.examSessionToken);
  const contenders=[{bundle:a.body,proof:proofs[0],answer:'A'},{bundle:other.body,proof:proofs[2],answer:'B'}]
    .map(candidate=>({...candidate,operation:op(candidate.bundle,first,candidate.answer)}));
  const outcomes=await Promise.all(contenders.map(candidate=>
    post(candidate.bundle,candidate.proof,'seal',candidate.operation)));
  assert.deepEqual(outcomes.map(result=>result.status).sort(),[200,409]);
  const winner=outcomes.findIndex(result=>result.ok);
  const saved=outcomes[winner];
  const accepted=contenders[winner];
  const losing=contenders[1-winner];
  assert.equal(outcomes[1-winner].body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
  assert.equal(saved.body.receipt.completed,false);
  assert.equal(saved.body.receipt.attemptToken===accepted.bundle.attemptToken,first==='reading');
  const wrongDelivery=await openCbt(a.body.examSessionToken);
  assert.equal(wrongDelivery.status,409);
  assert.equal(wrongDelivery.body.error,'MODE_CONFLICT');
  assert.equal(wrongDelivery.body.examSessionToken,undefined);
  assert.equal((await post(losing.bundle,losing.proof,'status',losing.operation)).body.persisted,false);
  const stale=await post(b.body,proofs[1],'seal',op(b.body,second,'Unconfirmed scope'));
  assert.equal(stale.status,409);
  assert.equal(stale.body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
  const drain=request(f.appForTerm1PaperMode('drain'));
  const availability=await drain.get(root+'/paper-journey/availability');
  assert.equal(availability.body.enabled,false);
  const unopened=await prepare('e'.repeat(64),mode(second),drain);
  assert.equal(unopened.status,409);
  assert.equal(unopened.body.error,'OFFLINE_NEW_DISABLED');
  const resumed=await prepare(proofs[1],mode(second),drain);
  assert.ok(resumed.ok,resumed.body.error);
  assert.equal(resumed.body.continuationSection,second);
  assert.equal(resumed.body.examSessionToken,b.body.examSessionToken);
  assert.equal(resumed.body.activatedAt,b.body.activatedAt);
  assert.equal(resumed.body.examMode,mode(first));
  assert.equal(resumed.body.resultAttemptToken,undefined);
  const wrongSkill=await post(resumed.body,proofs[1],'seal',op(resumed.body,first,'Wrong skill'),drain);
  assert.equal(wrongSkill.status,403);
  const secondOp=op(resumed.body,second,'Second answer');
  const finished=await post(resumed.body,proofs[1],'seal',secondOp,drain);
  assert.ok(finished.ok,finished.body.error);
  assert.equal(finished.body.receipt.nextSection,'result');
  assert.equal(finished.body.receipt.attemptToken,saved.body.receipt.attemptToken);
  assert.deepEqual((await post(resumed.body,proofs[1],'status',{section:second,operationId:secondOp.operationId},drain)).body.receipt,finished.body.receipt);
  assert.deepEqual((await post(resumed.body,proofs[1],'seal',secondOp,drain)).body.receipt,finished.body.receipt);
  assert.deepEqual((await post(accepted.bundle,accepted.proof,'status',accepted.operation)).body.receipt,saved.body.receipt);
  const alreadyDone=await prepare(proofs[2],mode(first));
  assert.equal(alreadyDone.body.resultAttemptToken,finished.body.receipt.attemptToken);
  assert.equal(alreadyDone.body.permit,undefined);

  const {rows}=await f.db.query(`SELECT id,exam_delivery,writing_scope,listening_answers,reading_answers
    FROM assessment.term_test_attempt WHERE test_slug='term-test-1'
      AND (listening_submitted_at IS NOT NULL OR reading_submitted_at IS NOT NULL)`);
  assert.deepEqual(rows,[{id:finished.body.receipt.attemptToken,exam_delivery:'answer_sheet',writing_scope:'lr_only',
    listening_answers:{11:first==='listening'?accepted.answer:'Second answer'},
    reading_answers:{14:first==='reading'?accepted.answer:'Second answer'}}]);
  for(let n=0;n<30&&!portal.length;n++)await delay(10);
  assert.equal(portal.length,1);
  assert.equal(portal[0].attemptToken,rows[0].id);
  assert.equal(portal[0].grades.writing,undefined);
});

for(const slug of ['term-test-1','term-test-2'])test(`${slug} paper can open while CBT and EOF remain off`,async t=>{
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,
    [slug==='term-test-1'?'term1PaperJourneyMode':'term2PaperJourneyMode']:'on'});
  t.after(()=>f.db.close());
  await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,'Đề giả Term',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
  const api=request(f.app),root='/api/term-tests/'+slug;
  assert.equal((await api.get(root+'/paper-journey/availability')).body.enabled,true);
  assert.equal((await api.post(root+'/cbt-journey/prepare').send({})).status,404);
  const ready=await api.post(root+'/paper-journey/prepare').send({...identity,deviceProof,examMode:'lis_first'});
  assert.equal(ready.status,200,ready.text);
});

for(const slug of ['term-test-1','term-test-2'])for(const examMode of ['lis_first','read_first'])test(`${slug} paper preserves both section policies · ${examMode}`,async t=>{
  const root='/api/term-tests/'+slug;
  const otherRoot='/api/term-tests/'+(slug==='term-test-1'?'term-test-2':'term-test-1');
  const portal=[];
  const f=await createMiniFixture({examOrder:true,completeSchema:true,assets,term1PaperJourneyMode:'on',term1CbtJourneyMode:'on',
    term2PaperJourneyMode:'on',term2CbtJourneyMode:'on',
    writingHold:{termPaperLrHoldHours:2,termPaperLrHoldLimit:20,
      term1PaperLrHoldClasses:new Set([identity.classCode]),term2PaperLrHoldClasses:new Set([identity.classCode])},
    syncErpGrades:async payload=>portal.push(payload)});
  t.after(()=>f.db.close());
  await f.db.query(`INSERT INTO assessment.test_definition(slug,title,version,listening_definition,reading_definition,is_active)
    SELECT $1,'Đề giả Term',1,listening_definition,reading_definition,true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`,[slug]);
  const api=request(f.app);
  const prepare=body=>api.post(root+'/paper-journey/prepare').send({...identity,deviceProof,examMode,...body});
  assert.equal((await prepare({classCode:'WRONG'})).status,403);
  const ready=await prepare();
  assert.ok(ready.ok,ready.text);
  assert.deepEqual(ready.body.timing,{readingDurationMinutes:60});
  assert.equal(ready.body.audioManifest,undefined);
  assert.equal(ready.body.content,undefined);
  assert.equal(ready.body.examMode,examMode);
  assert.equal(ready.body.submissionRecoveryVersion,1);
  assert.equal((await prepare({deviceProof:'b'.repeat(64)})).status,403);
  const reopened=await prepare({examMode:examMode==='lis_first'?'read_first':'lis_first'});
  assert.equal(reopened.body.examSessionToken,ready.body.examSessionToken);
  assert.equal(reopened.body.examMode,examMode);
  const scope={examSessionToken:ready.body.examSessionToken,generation:ready.body.generation,deviceProof};
  const wrongMode=await api.post(root+'/cbt-journey/prepare').send({...identity,...scope});
  assert.equal(wrongMode.status,403);
  const wrongTest=await api.post(otherRoot+'/paper-journey/status').set('x-term2-permit',ready.body.permit)
    .send({...scope,section:'reading',operationId:randomUUID()});
  assert.equal(wrongTest.status,403);
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
    const rejected={...operation,operationId:randomUUID(),
      ...(listening?{automatic:true}:{capturedAt:operation.capturedAt-1})};
    const savedForReview=await post('seal',rejected);
    assert.equal(savedForReview.body.reasonCode,listening?'PAPER_MANUAL_ONLY':'AUTO_CAPTURE_BEFORE_DEADLINE');
    assert.ok(savedForReview.body.held?.payloadHash);
    assert.deepEqual((await post('status',{section,operationId:rejected.operationId})).body,
      {ok:true,persisted:false,receipt:null,held:savedForReview.body.held});
    const {rows:[held]}=await f.db.query(`SELECT payload,delivery FROM assessment.term_k67_lr_submission_hold
      WHERE session_id=$1 AND section=$2 AND operation_id=$3`,[scope.examSessionToken,section,rejected.operationId]);
    assert.deepEqual(held.payload.answers,operation.answers);
    assert.equal(held.delivery,'paper');
    assert.equal(portal.length,0);
    assert.equal((await post('status',{section,operationId:operation.operationId})).body.persisted,false);
    const saved=await post('seal',operation);
    assert.ok(saved.ok,saved.text);
    assert.equal(saved.body.receipt.completed,previousOperationId!==null);
    assert.deepEqual((await post('status',{section,operationId:operation.operationId})).body.receipt,saved.body.receipt);
    assert.deepEqual((await post('seal',operation)).body.receipt,saved.body.receipt);
    if(!saved.body.receipt.completed)assert.equal(portal.length,0,'Chưa gửi điểm khi mới nộp một phần.');
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
  assert.equal(portal.length,1);
  assert.equal(portal[0].testSlug,slug);
  assert.equal(portal[0].attemptToken,row.id);
  assert.equal(portal[0].classId,'1293');
  assert.equal(portal[0].studentId,'900001');
  assert.equal(typeof portal[0].grades.listening,'number');
  assert.equal(typeof portal[0].grades.reading,'number');
  assert.equal(portal[0].grades.writing,undefined);
});
