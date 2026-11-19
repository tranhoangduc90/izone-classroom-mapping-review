import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const root = '/api/term-tests/term-test-2';
const identity = { classCode: 'IC2304', studentRef: '11111111-1111-4111-8111-111111111111', identityConfirmed: true };
const proofA = 'a'.repeat(64);
const proofB = 'b'.repeat(64);
const proofC = 'c'.repeat(64);
const unopenedProof = 'd'.repeat(64);
const mode = section => section === 'reading' ? 'read_first' : 'lis_first';
const assets = { supports: () => true, getTiming: () => ({ readingDurationMinutes: 60 }) };

for (const first of ['listening', 'reading']) {
  test('Term 2 paper keeps the first official ' + first + ' and lets an existing second profile finish', async t => {
    const f = await createMiniFixture({ examOrder: true, completeSchema: true, assets,
      term2ParallelEntryMode: 'on', term2PaperJourneyMode: 'on' });
    t.after(() => f.db.close());
    await f.db.query(`INSERT INTO assessment.test_definition
      (slug,title,version,listening_definition,reading_definition,is_active)
      SELECT 'term-test-2','Đề giả',1,listening_definition,reading_definition,true
      FROM assessment.test_definition WHERE slug='mini-test-lesson-5'`);
    const api = request(f.app);
    const last = first === 'listening' ? 'reading' : 'listening';
    const prepare = (proof, section, server = api, extra = {}) => server.post(root + '/paper-journey/prepare')
      .send({ ...identity, deviceProof: proof, examMode: mode(section), term2PaperParallelVersion: 1, ...extra });
    const post = (bundle, proof, route, body, server = api) => server.post(root + '/paper-journey/' + route)
      .set('x-term2-permit', bundle.permit)
      .send({ examSessionToken: bundle.examSessionToken, generation: bundle.generation, deviceProof: proof, ...body });
    const payload = (bundle, section, answer) => ({ section, operationId: randomUUID(), previousOperationId: null,
      startedAt: bundle.activatedAt + 30, capturedAt: bundle.activatedAt + 30, revision: 1, automatic: false,
      eofAt: null, heardSeconds: 0, answers: { [section === 'listening' ? 11 : 14]: answer } });

    const a = await prepare(proofA, first);
    const b = await prepare(proofB, last);
    assert.equal(a.status, 200, a.body.error);
    assert.equal(b.status, 200, b.body.error);
    const c = await prepare(proofC, first);
    assert.equal(c.status, 200, c.body.error);
    assert.notEqual(a.body.examSessionToken, b.body.examSessionToken);
    assert.equal(b.body.term2ParallelEntry, true);
    assert.equal(b.body.examDelivery, 'answer_sheet');
    assert.equal((await api.get(root + '/paper-journey/availability')).body.parallelEntryAvailable, true);
    assert.equal((await prepare(proofA, last)).body.examSessionToken, a.body.examSessionToken);
    assert.equal((await post(a.body, proofB, 'seal', payload(a.body, first, 'Wrong proof'))).status, 403);
    const startCbt = () => api.post(root + '/session/prepare').send({ ...identity, examMode: mode(first),
      examSessionToken: a.body.examSessionToken, orderClientVersion: 1, term2ContinuationVersion: 1, examDelivery: 'cbt' });
    const cbt = await startCbt();
    assert.equal(cbt.status, 200, cbt.body.error);
    assert.notEqual(cbt.body.examSessionToken, a.body.examSessionToken);

    const contenders = [{ bundle: a.body, proof: proofA }, { bundle: c.body, proof: proofC }].map((entry, index) => {
      const answer = 'First answer ' + index;
      return { ...entry, answer, op: payload(entry.bundle, first, answer) };
    });
    const outcomes = await Promise.all(contenders.map(entry => post(entry.bundle, entry.proof, 'seal', entry.op)));
    assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
    const winnerIndex = outcomes.findIndex(response => response.ok);
    const accepted = outcomes[winnerIndex];
    const winner = contenders[winnerIndex];
    assert.equal(outcomes[1 - winnerIndex].body.error, 'EXAM_FIRST_SUBMISSION_ACCEPTED');
    const wrongDelivery = await startCbt();
    assert.equal(wrongDelivery.status, 409);
    assert.equal(wrongDelivery.body.error, 'MODE_CONFLICT');
    const stale = await post(b.body, proofB, 'seal', payload(b.body, last, 'Stale answer'));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'EXAM_FIRST_SUBMISSION_ACCEPTED');

    const drain = request(f.appForTerm2PaperMode('drain'));
    assert.equal((await drain.get(root + '/paper-journey/availability')).body.enabled, false);
    const unopened = await prepare(unopenedProof, last, drain);
    assert.equal(unopened.status, 409);
    assert.equal(unopened.body.error, 'OFFLINE_NEW_DISABLED');
    const resumed = await prepare(proofB, last, drain);
    assert.equal(resumed.status, 200, resumed.body.error);
    assert.equal(resumed.body.continuationSection, last);
    assert.equal(resumed.body.examSessionToken, b.body.examSessionToken);
    assert.equal(resumed.body.activatedAt, b.body.activatedAt);
    assert.equal(resumed.body.examMode, mode(first));
    assert.equal((await post(resumed.body, proofB, 'seal', payload(resumed.body, first, 'Wrong part'), drain)).status, 403);
    const lastOp = payload(resumed.body, last, 'Second answer');
    const done = await post(resumed.body, proofB, 'seal', lastOp, drain);
    assert.equal(done.status, 200, done.body.error);
    const { receipt } = done.body;
    assert.equal(receipt.nextSection, 'result');
    assert.equal(receipt.attemptToken, accepted.body.receipt.attemptToken);
    assert.equal(receipt.examSessionToken, b.body.examSessionToken);
    assert.ok(receipt.receiptId);
    assert.deepEqual((await post(resumed.body, proofB, 'status', lastOp, drain)).body.receipt, receipt);
    assert.deepEqual((await post(resumed.body, proofB, 'seal', lastOp, drain)).body.receipt, receipt);
    assert.deepEqual((await post(winner.bundle, winner.proof, 'status', winner.op, drain)).body.receipt, accepted.body.receipt);

    const { rows } = await f.db.query(`SELECT id,exam_delivery,writing_scope,listening_answers,reading_answers
      FROM assessment.term_test_attempt WHERE test_slug='term-test-2'
      AND (listening_submitted_at IS NOT NULL OR reading_submitted_at IS NOT NULL)`);
    assert.deepEqual(rows, [{ id: receipt.attemptToken, exam_delivery: 'answer_sheet', writing_scope: 'lr_only',
      listening_answers: { 11: first === 'listening' ? winner.answer : 'Second answer' },
      reading_answers: { 14: first === 'reading' ? winner.answer : 'Second answer' } }]);
  });
}
