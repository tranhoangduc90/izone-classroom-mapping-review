import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';
import { createTermTestWritingGradingService } from '../src/term-test-writing-grading.js';

const endpoint = '/api/term-tests/term-test-1';
const identity = { classCode: 'IC2304', studentRef: '11111111-1111-4111-8111-111111111111' };
const testAssets = {
  supports: slug => slug === 'term-test-1',
  getTiming: () => ({ listeningDurationSeconds: 120, listeningTotalSeconds: 240, listeningReviewSeconds:120,
    readingDurationMinutes: 20,writingDurationMinutes:1 }),
  getContent: () => ({writing:{tasks:[{id:'task2',prompt:'Synthetic Writing prompt'}]}}),
  getSessionAudioKey: () => Buffer.alloc(32),
};

async function seedTerm1(db) {
  await db.query(`INSERT INTO assessment.test_definition
    (slug, title, version, listening_definition, reading_definition, is_active)
    SELECT 'term-test-1', 'Fixture Term 1', 1, listening_definition, reading_definition, true
    FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
}

test('Term 1 keeps the first official submission while another profile completes Listening', async () => {
  const deliveries = [];
  const continuationEvents = [];
  const fixture = await createMiniFixture({
    examOrder: true,
    completeSchema: true,
    audioProtection: true,
    audioCache: true,
    audioOwner: true,
    term1CbtJourneyMode: 'on',
    term1ParallelEntryEnabled: true,
    syncErpGrades: async payload => { deliveries.push(payload); return { status: 'synced' }; },
    mountJournal: () => ({business(event, slug, scope, details) {
      if (details.reason==='TERM1_LISTENING_CONTINUATION') continuationEvents.push({event,slug,scope,details});
    }}),
    assets: testAssets,
  });

  try {
    await seedTerm1(fixture.db);

    const profileA = request.agent(fixture.app);
    const profileB = request.agent(fixture.app);
    const prepare = (profile, examMode, examSessionToken, term1ContinuationVersion) => profile.post(`${endpoint}/session/prepare`).send({
      ...identity, examMode, examDelivery: 'cbt', orderClientVersion: 1, examSessionToken,
      term1ContinuationVersion,
    });

    const listening = await prepare(profileA, 'lis_first');
    assert.ok(listening.ok, listening.body.error);
    const owner = {
      examSessionToken: listening.body.examSessionToken, generation: listening.body.generation,
      ownerId: randomUUID(), ownerProof: 'a'.repeat(64), ownerEpoch: 0, pageId: randomUUID(),
    };
    const started = await profileA.post(`${endpoint}/session/start`).send({
      ...owner, ownerStartVersion: 2, audioProtocolVersion: 1, audioEventId: randomUUID(),
    });
    assert.ok(started.ok, started.body.error);
    const draft = await profileA.post(`${endpoint}/listening/draft`).send({
      ...owner, ownerEpoch: started.body.audioOwner.ownerEpoch, answers: { 11: 'A' }, revision: 1,
    });
    assert.ok(draft.ok, draft.body.error);

    const reading = await prepare(profileB, 'read_first');
    assert.ok(reading.ok, `Profile B received ${reading.status} ${reading.body.error}`);
    assert.equal(reading.body.examMode, 'read_first');
    assert.notEqual(reading.body.examSessionToken, listening.body.examSessionToken);
    assert.equal(reading.body.listeningSubmitted, false);
    assert.deepEqual(reading.body.readingDraft || {}, {});
    assert.deepEqual(reading.body.listeningDraft, {});
    const resumed = await prepare(profileA, 'lis_first', owner.examSessionToken);
    assert.ok(resumed.ok, resumed.body.error);
    assert.equal(resumed.body.examSessionToken, owner.examSessionToken);
    assert.equal(resumed.body.listeningStartedAt, started.body.listeningStartedAt);
    assert.equal(resumed.body.listeningDeadlineAt, started.body.listeningDeadlineAt);
    assert.deepEqual(resumed.body.listeningDraft, { 11: 'A' });

    const readingScope = { examSessionToken: reading.body.examSessionToken, attemptToken: reading.body.attemptToken,
      generation: reading.body.generation, orderClientVersion: 1 };
    const readingStarted = await profileB.post(`${endpoint}/reading/start`).send(readingScope);
    assert.ok(readingStarted.ok, readingStarted.body.error);
    const readingDraft = await profileB.post(`${endpoint}/reading/draft`).send({ ...readingScope, answers: { 14: 'B' }, revision: 1 });
    assert.ok(readingDraft.ok, readingDraft.body.error);
    const anotherReading = await prepare(request.agent(fixture.app), 'read_first');
    assert.ok(anotherReading.ok, anotherReading.body.error);
    assert.notEqual(anotherReading.body.attemptToken, reading.body.attemptToken);
    assert.notEqual(anotherReading.body.examSessionToken, reading.body.examSessionToken);
    assert.deepEqual(anotherReading.body.readingDraft, {});

    const activeBefore = await profileA.post(`${endpoint}/attempt/active`).send({ ...identity, orderClientVersion: 1 });
    assert.deepEqual(activeBefore.body, { ok: true, active: false });
    const readingAccepted = await profileB.post(`${endpoint}/reading`).send({ ...readingScope, answers: { 14: 'B' }, draftRevision: 1 });
    assert.ok(readingAccepted.ok, readingAccepted.body.error);
    assert.equal(readingAccepted.body.readingSubmitted, true);
    assert.equal(readingAccepted.body.nextSection, 'listening');

    const lateListening = await profileA.post(`${endpoint}/listening`).send({
      ...identity, ...owner, ownerEpoch: started.body.audioOwner.ownerEpoch,
      clientSubmissionId: randomUUID(), answers: { 11: 'A' }, draftRevision: 1,
    });
    assert.equal(lateListening.status, 409, lateListening.body.error);
    assert.equal(lateListening.body.error, 'EXAM_FIRST_SUBMISSION_ACCEPTED');

    const official = await prepare(profileA, 'lis_first', owner.examSessionToken);
    assert.ok(official.ok, official.body.error);
    assert.equal(official.body.examMode, 'read_first');
    assert.equal(official.body.listeningSubmitted, false);
    assert.equal(official.body.readingSubmitted, true);
    assert.equal(official.body.nextSection, 'listening');
    assert.equal(official.body.attemptToken, null);
    assert.equal(official.body.examSessionToken, null);
    assert.deepEqual(official.body.readingDraft, {});

    const accepted = await fixture.db.query(`SELECT id, reading_answers, listening_answers, term1_first_submission_guard
      FROM assessment.term_test_attempt
      WHERE test_slug='term-test-1' AND erp_student_contact_id=900001
        AND superseded_at IS NULL AND (listening_submitted_at IS NOT NULL OR reading_submitted_at IS NOT NULL)`);
    assert.deepEqual(accepted.rows, [{ id: reading.body.attemptToken,
      reading_answers: { 14: 'B' }, listening_answers: null, term1_first_submission_guard: true }]);

    const originalListening = {...readingScope,ownerId:randomUUID(),ownerProof:'d'.repeat(64),ownerEpoch:0,pageId:randomUUID()};
    const originalPlaying = await profileB.post(`${endpoint}/session/start`).send({
      ...originalListening,ownerStartVersion:2,audioProtocolVersion:1,audioEventId:randomUUID(),
    });
    assert.ok(originalPlaying.ok,originalPlaying.body.error);
    const originalDraft = await profileB.post(`${endpoint}/listening/draft`).send({
      ...originalListening,ownerEpoch:originalPlaying.body.audioOwner.ownerEpoch,answers:{11:'B'},revision:1,
    });
    assert.ok(originalDraft.ok,originalDraft.body.error);

    const continued = await prepare(profileA, 'lis_first', owner.examSessionToken, 1);
    assert.ok(continued.ok, continued.body.error);
    assert.equal(continued.body.continuationSection, 'listening');
    assert.equal(continued.body.readingSubmitted, true);
    assert.equal(continued.body.examSessionToken, owner.examSessionToken);
    assert.notEqual(continued.body.examSessionToken, reading.body.examSessionToken);
    assert.equal(continued.body.attemptToken, null);
    assert.deepEqual(continued.body.listeningDraft, {11:'A'});
    assert.equal(continued.body.listeningStartedAt,started.body.listeningStartedAt);
    assert.equal(continued.body.listeningDeadlineAt,started.body.listeningDeadlineAt);

    const startContinuation = async (profile, scope) => {
      const session = {examSessionToken:scope.examSessionToken,generation:scope.generation,
        ownerId:randomUUID(),ownerProof:'c'.repeat(64),ownerEpoch:0,pageId:randomUUID()};
      const playing = await profile.post(`${endpoint}/session/start`).send({
        ...session,ownerStartVersion:2,audioProtocolVersion:1,audioEventId:randomUUID(),
      });
      assert.ok(playing.ok,playing.body.error);
      return {...session,ownerEpoch:playing.body.audioOwner.ownerEpoch};
    };
    const later = request.agent(fixture.app);
    const competing = await prepare(later,'read_first',undefined,1);
    assert.notEqual(competing.body.examSessionToken,continued.body.examSessionToken);
    const continuedOwner = {...owner,ownerEpoch:started.body.audioOwner.ownerEpoch};
    const competingOwner = await startContinuation(later,competing.body);
    const saved = await profileA.post(`${endpoint}/listening/draft`).send({
      ...continuedOwner,answers:{11:'C'},revision:2,
    });
    assert.ok(saved.ok,saved.body.error);
    const reopened = await prepare(profileA,'read_first',continued.body.examSessionToken,1);
    assert.equal(reopened.body.examSessionToken,continued.body.examSessionToken);
    assert.deepEqual(reopened.body.listeningDraft,{11:'C'});
    const privateDraft = await prepare(later,'read_first',competing.body.examSessionToken,1);
    assert.deepEqual(privateDraft.body.listeningDraft,{});

    const submission = {...identity,...continuedOwner,answers:{11:'C'},draftRevision:2,clientSubmissionId:randomUUID()};
    const acceptedListening = await profileA.post(`${endpoint}/listening`).send(submission);
    assert.ok(acceptedListening.ok,acceptedListening.body.error);
    assert.equal(acceptedListening.body.receipt.section,'listening');
    assert.equal(acceptedListening.body.receipt.nextSection,'writing');
    const retry = await profileA.post(`${endpoint}/listening`).send(submission);
    assert.deepEqual(retry.body,acceptedListening.body);
    const changed = await profileA.post(`${endpoint}/listening`).send({...submission,answers:{11:'A'}});
    assert.equal(changed.status,409);
    const lost = await later.post(`${endpoint}/listening`).send({
      ...identity,...competingOwner,answers:{11:'A'},draftRevision:1,clientSubmissionId:randomUUID(),
    });
    assert.equal(lost.status,409);
    assert.equal(lost.body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');

    const persisted = await fixture.db.query(`SELECT id,reading_answers,listening_answers,completed_at
      FROM assessment.term_test_attempt WHERE test_slug='term-test-1' AND completed_at IS NOT NULL`);
    assert.equal(persisted.rows.length,1);
    assert.equal(persisted.rows[0].id,reading.body.attemptToken);
    assert.deepEqual(persisted.rows[0].reading_answers,{14:'B'});
    assert.deepEqual(persisted.rows[0].listening_answers,{11:'C'});
    const retained = await fixture.db.query(`SELECT listening_draft,audio_owner_id FROM assessment.term_test_exam_session
      WHERE id=$1`,[readingScope.examSessionToken]);
    assert.deepEqual(retained.rows,[{listening_draft:{11:'B'},audio_owner_id:originalListening.ownerId}]);
    const receipts = await fixture.db.query(`SELECT receipt FROM assessment.term1_section_continuation WHERE receipt IS NOT NULL`);
    assert.deepEqual(receipts.rows,[{receipt:acceptedListening.body.receipt}]);
    assert.equal(deliveries.length,1);
    assert.equal(deliveries[0].attemptToken,reading.body.attemptToken);
    assert.equal(deliveries[0].studentId,'900001');
    assert.equal(continuationEvents.length,1);
    const [logged] = continuationEvents;
    assert.equal(logged.event,'submission_completed');
    assert.equal(logged.slug,'term-test-1');
    assert.equal(logged.scope,continued.body.examSessionToken);
    assert.equal(logged.details.receiptId,acceptedListening.body.receipt.receiptId);
  } finally {
    await fixture.db.close();
  }
});

test('Term 1 keeps the accepted Listening and another profile completes Reading', async () => {
  const deliveries = [];
  const fixture = await createMiniFixture({examOrder:true,completeSchema:true,audioProtection:true,audioCache:true,
    audioOwner:true,term1CbtJourneyMode:'on',term1ParallelEntryEnabled:true,assets:testAssets,
    syncErpGrades:async payload=>{deliveries.push(payload);return {status:'synced'};}});
  try {
    await seedTerm1(fixture.db);
    const a = request.agent(fixture.app);
    const b = request.agent(fixture.app);
    const c = request.agent(fixture.app);
    const prepare = (profile, token) => profile.post(`${endpoint}/session/prepare`).send({
      ...identity,examMode:'lis_first',examDelivery:'cbt',orderClientVersion:1,term1ContinuationVersion:1,examSessionToken:token,
    });
    const first = await prepare(a);
    assert.ok(first.ok,first.body.error);
    const owner = {examSessionToken:first.body.examSessionToken,generation:first.body.generation,ownerId:randomUUID(),
      ownerProof:'e'.repeat(64),ownerEpoch:0,pageId:randomUUID()};
    const started = await a.post(`${endpoint}/session/start`).send({...owner,ownerStartVersion:2,audioProtocolVersion:1,audioEventId:randomUUID()});
    assert.ok(started.ok,started.body.error);
    const accepted = await a.post(`${endpoint}/listening`).send({...identity,...owner,
      ownerEpoch:started.body.audioOwner.ownerEpoch,answers:{11:'B'},draftRevision:1,clientSubmissionId:randomUUID()});
    assert.ok(accepted.ok,accepted.body.error);
    const firstAttempt = accepted.body.attemptToken;
    const savedBefore = (await fixture.db.query(`SELECT listening_answers,listening_result,listening_submitted_at
      FROM assessment.term_test_attempt WHERE id=$1`,[firstAttempt])).rows[0];

    const originalStart = await a.post(`${endpoint}/reading/start`).send({attemptToken:firstAttempt});
    assert.ok(originalStart.ok,originalStart.body.error);
    const originalDraft = await a.post(`${endpoint}/reading/draft`).send({attemptToken:firstAttempt,answers:{14:'A'},revision:1});
    assert.ok(originalDraft.ok,originalDraft.body.error);

    const profileB = await prepare(b);
    const profileC = await prepare(c);
    assert.ok(profileB.ok,profileB.body.error);
    assert.ok(profileC.ok,profileC.body.error);
    assert.equal(profileB.body.continuationSection,'reading');
    assert.equal(profileB.body.listeningSubmitted,true);
    assert.notEqual(profileB.body.attemptToken,firstAttempt);
    assert.notEqual(profileB.body.attemptToken,profileC.body.attemptToken);
    assert.deepEqual(profileB.body.readingDraft,{});
    const scope = ({examSessionToken,attemptToken,generation})=>({examSessionToken,attemptToken,generation,orderClientVersion:1});
    const bStart = await b.post(`${endpoint}/reading/start`).send(scope(profileB.body));
    const cStart = await c.post(`${endpoint}/reading/start`).send(scope(profileC.body));
    assert.ok(bStart.ok,bStart.body.error);
    assert.ok(cStart.ok,cStart.body.error);
    const draft = await b.post(`${endpoint}/reading/draft`).send({...scope(profileB.body),answers:{14:'C'},revision:1});
    assert.ok(draft.ok,draft.body.error);
    const reopened = await prepare(b,profileB.body.examSessionToken);
    assert.equal(reopened.body.readingDeadlineAt,bStart.body.readingDeadlineAt);
    assert.deepEqual(reopened.body.readingDraft,{14:'C'});
    assert.deepEqual((await prepare(c,profileC.body.examSessionToken)).body.readingDraft,{});

    const submit = {...scope(profileB.body),answers:{14:'C'},draftRevision:1,clientSubmissionId:randomUUID()};
    const receipt = await b.post(`${endpoint}/reading`).send(submit);
    assert.ok(receipt.ok,receipt.body.error);
    assert.equal(receipt.body.receipt.nextSection,'writing');
    assert.deepEqual((await b.post(`${endpoint}/reading`).send(submit)).body,receipt.body);
    assert.equal((await b.post(`${endpoint}/reading/draft`).send({...scope(profileB.body),answers:{14:'D'},revision:2})).status,409);
    const late = await c.post(`${endpoint}/reading`).send({...scope(profileC.body),answers:{14:'D'},draftRevision:1,clientSubmissionId:randomUUID()});
    assert.equal(late.status,409);
    assert.equal(late.body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
    const rows = (await fixture.db.query(`SELECT id,listening_answers,listening_result,listening_submitted_at,reading_answers,reading_draft
      FROM assessment.term_test_attempt WHERE test_slug='term-test-1' AND completed_at IS NOT NULL`)).rows;
    assert.deepEqual(rows,[{...savedBefore,id:firstAttempt,reading_answers:{14:'C'},reading_draft:{14:'A'}}]);
    assert.deepEqual(deliveries.map(delivery=>delivery.attemptToken),[firstAttempt,firstAttempt]);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM assessment.term1_section_continuation WHERE receipt IS NOT NULL')).rows[0].n,1);
  } finally {
    await fixture.db.close();
  }
});

for (const [examMode,first,second] of [['lis_first','listening','reading'],['read_first','reading','listening']]) {
  test(`Term 1 ${examMode}: independent offline profiles finish L/R/W and replay the original receipts`, async () => {
    let grading;
    let failQueue = true;
    const deliveries = [];
    const fixture = await createMiniFixture({examOrder:true,completeSchema:true,term1CbtJourneyMode:'on',
      term1ParallelEntryEnabled:true,assets:testAssets,termTestWritingGradingService:{
        ensureSubmissionInTransaction(db,input) {
          if(failQueue){
            failQueue=false;
            throw Object.assign(new Error('Fixture queue temporarily unavailable'),{status:503,code:'WRITING_QUEUE_UNAVAILABLE'});
          }
          return grading.ensureSubmissionInTransaction(db,input);
        },
        getStatus: attemptToken => grading.getStatus(attemptToken)
      }});
    try {
      grading=createTermTestWritingGradingService({pool:fixture.pool,syncErpGrades:async payload=>{
        deliveries.push(payload);return {status:'synced'};
      }});
      await seedTerm1(fixture.db);
      const a=request.agent(fixture.app);
      const b=request.agent(fixture.app);
      const prepare=(profile, overrides={})=>profile.post(`${endpoint}/session/prepare`).send({
        ...identity,examMode,examDelivery:'cbt',orderClientVersion:1,term1ContinuationVersion:1,...overrides
      });
      const offline = async (profile, lobby, proof) => {
        assert.ok(lobby.ok,lobby.body.error);
        const scope={examSessionToken:lobby.body.examSessionToken,generation:lobby.body.generation,deviceProof:proof.repeat(64)};
        const path=`${endpoint}/cbt-journey`;
        const bundle=await profile.post(`${path}/prepare`).send({...identity,...scope});
        assert.ok(bundle.ok,bundle.body.error);
        const post=(suffix,payload={})=>profile.post(`${path}/${suffix}`).set('x-term2-permit',bundle.body.permit).send({...scope,...payload});
        const begin=await post('begin');
        assert.ok(begin.ok,begin.body.error);
        return {post,startedAt:begin.body.activatedAt,bundle:bundle.body};
      };
      const operation=(section,startedAt,answer)=>({operationId:randomUUID(),section,previousOperationId:null,
        startedAt,capturedAt:startedAt,revision:1,automatic:false,eofAt:null,heardSeconds:0,
        answers:section==='listening'?{11:answer}:{14:answer}});

      const original=await offline(a,await prepare(a),'a');
      const competing=await offline(b,await prepare(b,{examMode:examMode==='lis_first'?'read_first':'lis_first'}),'b');
      const firstOperation=operation(first,original.startedAt,'B');
      const accepted=await original.post('seal',firstOperation);
      assert.ok(accepted.ok,accepted.body.error);
      const attempted=operation(second,competing.startedAt,'E');
      const early=await competing.post('seal',attempted);
      assert.equal(early.status,409);
      assert.equal(early.body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
      assert.equal((await competing.post('status',{section:second,operationId:attempted.operationId})).body.persisted,false);
      const resumed=await offline(b,await prepare(b,{examSessionToken:competing.bundle.examSessionToken}),'b');
      assert.equal(resumed.bundle.continuationSection,second);
      assert.equal(resumed.bundle.examMode,examMode);
      assert.notEqual(resumed.bundle.examSessionToken,original.bundle.examSessionToken);
      assert.equal(resumed.bundle.examSessionToken,competing.bundle.examSessionToken);
      assert.equal(resumed.startedAt,competing.startedAt);
      const wrongSection=await resumed.post('seal',operation(first,resumed.startedAt,'D'));
      assert.equal(wrongSection.status,403);
      const secondOperation=operation(second,resumed.startedAt,'C');
      const sealed=await resumed.post('seal',secondOperation);
      assert.ok(sealed.ok,sealed.body.error);
      assert.equal(sealed.body.receipt.nextSection,'writing');
      assert.deepEqual((await resumed.post('seal',secondOperation)).body,sealed.body);
      assert.deepEqual((await resumed.post('status',{section:second,operationId:secondOperation.operationId})).body.receipt,sealed.body.receipt);
      assert.equal((await resumed.post('seal',{...secondOperation,answers:operation(second,resumed.startedAt,'D').answers})).status,409);
      assert.deepEqual((await original.post('status',{section:first,operationId:firstOperation.operationId})).body.receipt,accepted.body.receipt);

      const rows=(await fixture.db.query(`SELECT id,listening_answers,reading_answers FROM assessment.term_test_attempt
        WHERE test_slug='term-test-1' AND (listening_submitted_at IS NOT NULL OR reading_submitted_at IS NOT NULL)`)).rows;
      assert.deepEqual(rows,[{id:accepted.body.receipt.attemptToken,
        listening_answers:{11:first==='listening'?'B':'C'},reading_answers:{14:first==='reading'?'B':'C'}}]);
      const {rows:[stored]}=await fixture.db.query('SELECT receipt FROM assessment.term1_section_continuation WHERE receipt IS NOT NULL');
      assert.equal(stored.receipt.receiptId,sealed.body.receipt.receiptId);

      const c=request.agent(fixture.app);
      const readResult = (profile, options = {}) => profile.post('/api/term-tests/result').send({officialTerm1:identity, ...options});
      assert.equal((await readResult(c)).status,404);
      const writingLobby=await prepare(c);
      assert.equal(writingLobby.body.result,null);
      const writing=await offline(c,writingLobby,'c');
      assert.equal(writing.bundle.continuationSection,'writing');
      assert.equal(writing.bundle.examMode,examMode);
      assert.notEqual(writing.bundle.examSessionToken,original.bundle.examSessionToken);
      const essay=examMode==='lis_first'?'':'Synthetic writing answer';
      const writingOperation={...operation('writing',writing.startedAt,''),answers:{task1:'',task2:essay}};
      const queueUnavailable=await writing.post('seal',writingOperation);
      assert.equal(queueUnavailable.status,503);
      assert.equal(queueUnavailable.body.error,'WRITING_QUEUE_UNAVAILABLE');
      assert.equal((await writing.post('status',{section:'writing',operationId:writingOperation.operationId})).body.persisted,false);
      assert.equal((await readResult(c)).status,404);
      assert.equal((await fixture.db.query('SELECT writing_submitted_at FROM assessment.term_test_attempt WHERE id=$1',[rows[0].id])).rows[0].writing_submitted_at,null);

      const writingSealed=await writing.post('seal',writingOperation);
      assert.ok(writingSealed.ok,writingSealed.body.error);
      assert.equal(writingSealed.body.receipt.nextSection,'result');
      assert.equal(writingSealed.body.receipt.completed,true);
      assert.equal(writingSealed.body.receipt.officialAttemptToken,undefined);
      assert.deepEqual((await writing.post('seal',writingOperation)).body,writingSealed.body);
      assert.deepEqual((await writing.post('status',{section:'writing',operationId:writingOperation.operationId})).body.receipt,writingSealed.body.receipt);
      assert.equal((await writing.post('seal',{...writingOperation,answers:{task1:'',task2:'Different writing answer'}})).status,409);
      const result=await prepare(request.agent(fixture.app));
      assert.equal(result.body.nextSection,'result');
      assert.equal(result.body.officialResultReady,true);
      assert.deepEqual(result.body.writingGrading,essay?{status:'waiting',score:null}:{status:'ready',score:0});
      const saved=(await fixture.db.query('SELECT writing_task_2,writing_submitted_at FROM assessment.term_test_attempt WHERE id=$1',[rows[0].id])).rows[0];
      assert.equal(saved.writing_task_2,essay);
      assert.ok(saved.writing_submitted_at);
      const jobs=(await fixture.db.query(`
        SELECT run.attempt_id
        FROM assessment.term_test_writing_grading_job AS job
        JOIN assessment.term_test_writing_grading_run AS run ON run.id=job.run_id
        WHERE job.job_type='dispatch'
      `)).rows;
      assert.deepEqual(jobs,essay?[{attempt_id:rows[0].id}]:[]);
      const official = await readResult(a, {includeContent:true});
      assert.ok(official.ok,official.body.error);
      assert.equal(official.body.studentRef,identity.studentRef);
      assert.equal(official.body.examMode,examMode);
      assert.equal(official.body.content.writing.tasks[0].id,'task2');
      assert.equal(official.body.writing.task2,essay);
      assert.equal(official.body.writing.submitted,true);
      assert.equal(official.body.writing.grading.ready,!essay);
      assert.equal(official.body.writing.grading.writingScore,essay?null:0);
      assert.ok(!JSON.stringify(official.body).includes(rows[0].id));
      assert.ok(!JSON.stringify(official.body).includes(original.bundle.examSessionToken));
      assert.equal((await readResult(b,{officialTerm1:{...identity,classCode:'OUTSIDE'}})).status,404);
      assert.equal((await readResult(b,{officialTerm1:{...identity,studentRef:randomUUID()}})).status,404);
      assert.equal((await readResult(b,{attemptToken:rows[0].id})).status,400);
      const review = await b.post('/api/term-tests/result/review').send({officialTerm1:identity});
      assert.ok(review.ok,review.body.error);
      assert.deepEqual(review.body.review.answers,{
        listening:rows[0].listening_answers,reading:rows[0].reading_answers,writing:{task1:'',task2:essay}
      });
      assert.equal(deliveries.length,0);
      if (essay) {
        const workerId='term1-fixture-grader';
        const [dispatch]=await grading.claimJobs({workerId});
        assert.equal(dispatch.essay,essay);
        await grading.completeDispatch({workerId,jobId:dispatch.jobId});
        await fixture.db.query("UPDATE assessment.term_test_writing_grading_job SET next_attempt_at=now() WHERE job_type='collect'");
        const [collect]=await grading.claimJobs({workerId});
        const criteria=['TR','CC','LR','GRA'].map(code=>({code,bandScore:6,feedback:'Nhận xét giả'}));
        await grading.completeResult({workerId,jobId:collect.jobId,runKey:collect.runKey,result:{taskScore:6,criteria}});
        assert.equal((await readResult(c)).body.writing.grading.writingScore,6);
        assert.equal((await readResult(a)).body.writing.grading.writingScore,6);
        assert.deepEqual(deliveries.map(({attemptToken,grades})=>[attemptToken,grades.writing]),[[rows[0].id,6]]);
      }
    } finally {
      await fixture.db.close();
    }
  });
}

test('Term 1 simultaneous Listening submissions keep one official receipt and open Reading for the other profile', async () => {
  const fixture=await createMiniFixture({examOrder:true,completeSchema:true,term1CbtJourneyMode:'on',
    term1ParallelEntryEnabled:true,assets:testAssets});
  try {
    await seedTerm1(fixture.db);
    async function profile(answer, proof) {
      const api=request.agent(fixture.app);
      const prepare=examSessionToken=>api.post(`${endpoint}/session/prepare`).send({
        ...identity,examMode:'lis_first',examDelivery:'cbt',orderClientVersion:1,term1ContinuationVersion:1,examSessionToken
      });
      const opened=await prepare();
      assert.ok(opened.ok,opened.body.error);
      const scope={examSessionToken:opened.body.examSessionToken,generation:opened.body.generation,deviceProof:proof.repeat(64)};
      const path=`${endpoint}/cbt-journey`;
      const bundle=await api.post(`${path}/prepare`).send({...identity,...scope});
      assert.ok(bundle.ok,bundle.body.error);
      const send=(route,payload={})=>api.post(`${path}/${route}`).set('x-term2-permit',bundle.body.permit).send({...scope,...payload});
      const begin=await send('begin');
      assert.ok(begin.ok,begin.body.error);
      const op={operationId:randomUUID(),section:'listening',previousOperationId:null,
        startedAt:begin.body.activatedAt,capturedAt:begin.body.activatedAt,revision:1,
        automatic:false,eofAt:null,heardSeconds:0,answers:{11:answer}};
      return { scope, op, send, prepare };
    }
    const profiles=[await profile('A','a'),await profile('B','b')];
    const receipts=await Promise.all(profiles.map(({send,op})=>send('seal',op)));
    assert.deepEqual(receipts.map(receipt=>receipt.status).sort(),[200,409]);
    const index=receipts.findIndex(receipt=>receipt.ok);
    const winner=profiles[index], other=profiles[1-index];
    const confirmed=receipts[index].body.receipt;
    assert.equal(confirmed.operationId,winner.op.operationId);
    assert.deepEqual((await winner.send('seal',winner.op)).body.receipt,confirmed);
    assert.equal(receipts[1-index].body.error,'EXAM_FIRST_SUBMISSION_ACCEPTED');
    const otherStatus=await other.send('status',{section:'listening',operationId:other.op.operationId});
    assert.equal(otherStatus.body.persisted,false);
    const reopened=await other.prepare(other.scope.examSessionToken);
    assert.ok(reopened.ok,reopened.body.error);
    assert.equal(reopened.body.continuationSection,'reading');
    assert.equal(reopened.body.listeningSubmitted,true);
    assert.notEqual(reopened.body.examSessionToken,other.scope.examSessionToken);
    assert.notEqual(reopened.body.attemptToken,confirmed.attemptToken);
    assert.deepEqual((await fixture.db.query(`SELECT id,listening_answers FROM assessment.term_test_attempt
      WHERE test_slug='term-test-1' AND listening_submitted_at IS NOT NULL`)).rows,
    [{id:confirmed.attemptToken,listening_answers:winner.op.answers}]);
  } finally {
    await fixture.db.close();
  }
});
