import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const prefix = '/api/term-tests/mini-test-lesson-5';
const studentRef = '11111111-1111-4111-8111-111111111111';
const otherStudent = '44444444-4444-4444-8444-444444444444';
const baseIdentity = { classCode: 'IC2304', studentRef, identityConfirmed: true };
const assets = { getTiming: () => ({ readingDurationMinutes: 20 }) };

for (const mode of ['lis_first', 'read_first']) test('Mini K67 paper offline ' + mode, async () => {
  let portalCalls = 0;
  const fixture = await createMiniFixture({
    examOrder: true, assets, miniPaperOffline: 'on',
    syncErpGrades: async () => { portalCalls++; }
  });
  try {
    const api = request(fixture.app);
    const opened = await api.post(prefix + '/answer-sheet/open').send({
      ...baseIdentity, examMode: mode, examDelivery: 'answer_sheet', orderClientVersion: 1
    }).expect(200);
    assert.equal(opened.body.offlinePaper, true);
    const token = opened.body.examSessionToken;
    const scope = { attemptToken: token, examSessionToken: token, generation: opened.body.generation, ownerId: randomUUID() };
    const claim = { ...baseIdentity, ...scope, mode, attemptMode: 'answer_sheet' };
    await api.post(prefix + '/offline/prepare').send({ ...claim, studentRef: otherStudent }).expect(403);
    const prep = await api.post(prefix + '/offline/prepare').send(claim).expect(200);
    assert.equal(prep.body.examMode, mode);
    assert.equal(prep.body.policy.timed, false);
    const grant = prep.body.offline.permit;
    await api.post(prefix + '/offline/prepare').send({ ...claim, ownerId: randomUUID() }).expect(409);
    const legacyDraft = await api.post(prefix + '/answer-sheet/listening/draft')
      .send({ examSessionToken: token, attemptToken: opened.body.attemptToken || undefined,
        generation: scope.generation, orderClientVersion: 1, revision: 1, answers: { 11: 'A' } }).expect(409);
    assert.equal(legacyDraft.body.error, 'OFFLINE_CLIENT_REQUIRED');

    const [first, second] = mode === 'read_first' ? ['reading','listening'] : ['listening','reading'];
    const startedAt = new Date().toISOString();
    function op(section, kind, dependency, answers = {}, revision = 0) {
      return {
        ...scope, operationId: randomUUID(), section, kind, dependency, revision, occurredAt: startedAt,
        payload: { startedAt, deadlineAt: null, timeValid: true, answers, ...(kind === 'seal' ? { reason: 'manual' } : {}) }
      };
    }
    function send(body, permit = grant) {
      return api.post(prefix + '/offline/operation').set('x-term2-permit', permit).send(body);
    }
    const begin = op(first, 'start', null);
    await send(begin, '0'.repeat(64)).expect(403);
    await send(op(second, 'start', null)).expect(409);
    await send(begin).expect(200);
    const draft = op(first, 'draft', null, first === 'listening' ? { 11: 'A' } : { 24: 'A' }, 1);
    await send(draft).expect(200);
    const seal = op(first, 'seal', null, draft.payload.answers, 1);
    const sealed = await send(seal).expect(200);
    const retry = await send(seal).expect(200);
    assert.deepEqual(retry.body.receipt, sealed.body.receipt);
    const status = await api.post(prefix + '/offline/status').set('x-term2-permit', grant)
      .send({ ...scope, operationId: seal.operationId }).expect(200);
    assert.deepEqual(status.body.receipt, sealed.body.receipt);
    await send({ ...seal, payload: { ...seal.payload, answers: {} } }).expect(409);
    await api.post(prefix + '/offline/result').set('x-term2-permit', grant).send(scope).expect(409);
    await send(op(second, 'start', seal.operationId)).expect(200);
    const last = op(second, 'seal', seal.operationId, second === 'listening' ? { 11: 'A' } : { 24: 'A' }, 1);
    await send(last).expect(200);
    const result = await api.post(prefix + '/offline/result').set('x-term2-permit', grant).send(scope).expect(200);
    assert.equal(result.body.completed, true);
    const attempts = (await fixture.db.query('SELECT * FROM assessment.term_test_attempt')).rows;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].reading_result.correct, 1);
    assert.equal(attempts[0].listening_result.correct, 1);
    assert.equal(attempts[0].writing_scope, 'lr_only');
    assert.equal(attempts[0].reading_deadline_at, null);
    assert.equal(portalCalls, 0);
  } finally {
    await fixture.db.close();
  }
});
