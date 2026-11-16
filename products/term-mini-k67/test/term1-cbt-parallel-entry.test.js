import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const endpoint = '/api/term-tests/term-test-1';
const identity = { classCode: 'IC2304', studentRef: '11111111-1111-4111-8111-111111111111' };

test('Term 1 isolates drafts before submission and reads the first accepted skill across profiles', async () => {
  const fixture = await createMiniFixture({
    examOrder: true,
    completeSchema: true,
    audioProtection: true,
    audioCache: true,
    audioOwner: true,
    term1CbtJourneyMode: 'on',
    term1ParallelEntryEnabled: true,
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
    const prepare = (profile, examMode, examSessionToken) => profile.post(`${endpoint}/session/prepare`).send({
      ...identity, examMode, examDelivery: 'cbt', orderClientVersion: 1, examSessionToken,
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
  } finally {
    await fixture.db.close();
  }
});
