import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const endpoint = '/api/term-tests/term-test-1';
const identity = { classCode: 'IC2304', studentRef: '11111111-1111-4111-8111-111111111111' };

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
    assets: {
      supports: slug => slug === 'term-test-1',
      getTiming: () => ({ listeningDurationSeconds: 120, listeningTotalSeconds: 240, readingDurationMinutes: 20 }),
      getContent: () => ({}),
      getSessionAudioKey: () => Buffer.alloc(32),
    },
  });

  try {
    await fixture.db.query(`INSERT INTO assessment.test_definition
      (slug, title, version, listening_definition, reading_definition, is_active)
      SELECT 'term-test-1', 'Fixture Term 1', 1, listening_definition, reading_definition, true
      FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);

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
    assert.notEqual(continued.body.examSessionToken, owner.examSessionToken);
    assert.notEqual(continued.body.examSessionToken, reading.body.examSessionToken);
    assert.equal(continued.body.attemptToken, null);
    assert.deepEqual(continued.body.listeningDraft, {});

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
    const continuedOwner = await startContinuation(profileA,continued.body);
    const competingOwner = await startContinuation(later,competing.body);
    const saved = await profileA.post(`${endpoint}/listening/draft`).send({
      ...continuedOwner,answers:{11:'C'},revision:1,
    });
    assert.ok(saved.ok,saved.body.error);
    const reopened = await prepare(profileA,'read_first',continued.body.examSessionToken,1);
    assert.equal(reopened.body.examSessionToken,continued.body.examSessionToken);
    assert.deepEqual(reopened.body.listeningDraft,{11:'C'});
    const privateDraft = await prepare(later,'read_first',competing.body.examSessionToken,1);
    assert.deepEqual(privateDraft.body.listeningDraft,{});

    const submission = {...identity,...continuedOwner,answers:{11:'C'},draftRevision:1,clientSubmissionId:randomUUID()};
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
    const receipts = await fixture.db.query(`SELECT receipt FROM assessment.term1_listening_continuation WHERE receipt IS NOT NULL`);
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
