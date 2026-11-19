import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const prefix = '/api/term-tests/mini-test-lesson-5/offline/';
const identity = { classCode: 'IC2304', studentRef: '11111111-1111-4111-8111-111111111111', identityConfirmed: true };
const mode = section => section === 'listening' ? 'lis_first' : 'read_first';
const number = section => section === 'listening' ? '11' : '14';
const auth = prepared => ({
  attemptToken: prepared.attemptToken, examSessionToken: prepared.examSessionToken,
  generation: prepared.generation, ownerId: prepared.offline.ownerId,
});

for (const [first, legacyProfile] of [['listening', false], ['reading', false], ['listening', true]]) {
  test(`Mini paper keeps two drafts and one official attempt when ${first} wins${legacyProfile ? ' with a pre-existing paper profile' : ''}`, async () => {
    const fixture = await createMiniFixture({
      examOrder: true, completeSchema: true, miniPaperOffline: 'on', miniPaperParallelEntryMode: 'on',
      miniCbtJourneyMode: 'on', pretestCbtJourneyMode: 'on', term2ParallelEntryMode: 'on',
      assets: { getTiming: () => ({ readingDurationMinutes: 20 }) },
    });
    try {
      for (const name of ['047-pretest-cbt-parallel-entry.sql', '048-mini-k67-cbt-parallel-entry.sql', '050-mini-k67-paper-parallel-entry.sql']) {
        await fixture.db.exec(await readFile(new URL('../db/' + name, import.meta.url), 'utf8'));
      }
      const api = request(fixture.app);
      const drain = request(fixture.appForMiniPaperParallelMode('drain'));
      const legacy = request(fixture.appForMiniPaperParallelMode('off'));
      const prepare = (section, ownerId, target = api) => target.post(prefix + 'parallel-prepare').send({
        ...identity, mode: mode(section), ownerId,
      });
      const other = first === 'listening' ? 'reading' : 'listening';
      const owners = [randomUUID(), randomUUID(), randomUUID()];
      let legacyRun;
      if (legacyProfile) {
        const limited = request(fixture.appForMiniPaperParallelMode('on', new Set(['IC9999'])));
        const blocked = await prepare(other, owners[1], limited).expect(404);
        assert.equal(blocked.body.error, 'OFFLINE_PARALLEL_NOT_OFFERED');
        const { body: opened } = await legacy.post('/api/term-tests/mini-test-lesson-5/answer-sheet/open')
          .send({ ...identity, examMode: mode(other), examDelivery: 'answer_sheet', orderClientVersion: 1 }).expect(200);
        const { body } = await legacy.post(prefix + 'prepare').send({
          ...identity, mode: mode(other), attemptMode: 'answer_sheet', ownerId: owners[1],
          attemptToken: opened.examSessionToken, examSessionToken: opened.examSessionToken, generation: opened.generation,
        }).expect(200);
        legacyRun = body;
      }
      const [a, fresh, c] = (await Promise.all([
        prepare(first, owners[0]).expect(200), legacyProfile ? null : prepare(other, owners[1]).expect(200),
        prepare(first, owners[2]).expect(200),
      ])).map(r => r?.body);
      const b = legacyRun || fresh;
      assert.equal(a.miniPaperParallelEntry, true);
      assert.equal(Boolean(b.miniPaperParallelEntry), !legacyProfile);
      assert.notEqual(a.examSessionToken, b.examSessionToken);
      assert.notEqual(a.offline.permit, b.offline.permit);
      await prepare(other, randomUUID(), drain).expect(503);
      const send = (prepared, op, target = api) => target.post(prefix + 'operation')
        .set('x-term2-permit', prepared.offline.permit).send(op);
      const startedAt = new Date().toISOString();
      const operation = (prepared, section, kind, answer) => ({
        ...auth(prepared), operationId: randomUUID(), section, kind, dependency: null,
        revision: kind === 'start' ? 0 : 1, occurredAt: startedAt,
        payload: { startedAt, deadlineAt: null, timeValid: true, answers: answer ? { [number(section)]: answer } : {},
          ...(kind === 'seal' ? { reason: 'manual' } : {}) },
      });
      for (const [prepared, section, answer] of [[a, first, 'A'], [b, other, 'B'], [c, first, 'C']]) {
        await send(prepared, operation(prepared, section, 'start')).expect(200);
        await send(prepared, operation(prepared, section, 'draft', answer)).expect(200);
      }
      const competing = [
        { prepared: a, answer: 'A', owner: owners[0] },
        { prepared: c, answer: 'C', owner: owners[2] },
      ];
      const outcomes = await Promise.all(competing.map(({ prepared, answer }) => send(prepared, operation(prepared, first, 'seal', answer))));
      assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
      assert.equal(outcomes.find(r => r.status === 409).body.error, 'EXAM_FIRST_SUBMISSION_ACCEPTED');
      const winnerIndex = outcomes.findIndex(r => r.ok);
      const winner = competing[winnerIndex];
      assert.equal(outcomes[winnerIndex].body.receipt.examSessionToken, winner.prepared.examSessionToken);
      const { body: firstAccepted } = await prepare(first, winner.owner, drain).expect(200);
      assert.equal(firstAccepted.examSessionToken, winner.prepared.examSessionToken);
      assert.match(firstAccepted.nativeAttemptToken, /^[a-f0-9-]{36}$/);
      const second = operation(b, other, 'seal', 'B');
      const denied = await send(b, second).expect(409);
      assert.equal(denied.body.error, 'EXAM_FIRST_SUBMISSION_ACCEPTED');
      const resumed = (await prepare(other, owners[1], drain).expect(200)).body;
      assert.equal(resumed.examSessionToken, b.examSessionToken);
      assert.equal(resumed.offline.permit, b.offline.permit);
      assert.equal(resumed.continuationSection, other);
      assert.equal(resumed.nativeAttemptToken, firstAccepted.nativeAttemptToken);
      assert.equal(resumed.nextSection, other);
      assert.equal(resumed[other + 'Draft'][number(other)], 'B');
      assert.equal(resumed[other + 'DraftRevision'], 1);
      await send({ ...resumed, offline: firstAccepted.offline }, second, drain).expect(403);
      const { body: { receipt } } = await send(resumed, second, drain).expect(200);
      assert.equal(receipt.examSessionToken, b.examSessionToken);
      assert.equal(receipt.officialAttemptToken, firstAccepted.nativeAttemptToken);
      assert.deepEqual((await send(resumed, second).expect(200)).body.receipt, receipt);
      const status = await api.post(prefix + 'status').set('x-term2-permit', b.offline.permit)
        .send({ ...auth(b), operationId: second.operationId }).expect(200);
      assert.deepEqual(status.body.receipt, receipt);
      const result = await api.post(prefix + 'result').set('x-term2-permit', b.offline.permit).send(auth(b)).expect(200);
      assert.equal(result.body.completed, true);
      assert.equal(result.body.nativeAttemptToken, firstAccepted.nativeAttemptToken);
      const readOnly = (await prepare(other, randomUUID(), drain).expect(200)).body;
      assert.equal(readOnly.officialResultReady, true);
      assert.equal(readOnly.studentRef, b.studentRef);
      assert.equal(readOnly.examSessionToken, undefined);
      assert.equal(readOnly.offline, undefined);
      assert.deepEqual(readOnly.result, result.body.result);
      const { rows } = await fixture.db.query(`SELECT id,exam_session_id,listening_answers,reading_answers,mini_k67_first_submission_guard
        FROM assessment.term_test_attempt WHERE listening_submitted_at IS NOT NULL OR reading_submitted_at IS NOT NULL`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, firstAccepted.nativeAttemptToken);
      assert.equal(rows[0].exam_session_id, winner.prepared.examSessionToken);
      assert.equal(rows[0].mini_k67_first_submission_guard, true);
      assert.equal(rows[0][first + '_answers'][number(first)], winner.answer);
      assert.equal(rows[0][other + '_answers'][number(other)], 'B');
      const joined = await fixture.db.query('SELECT receipt FROM assessment.mini_k67_section_continuation WHERE exam_session_id=$1',
        [b.examSessionToken]);
      assert.equal(joined.rows[0].receipt.receiptId, receipt.receiptId);
    } finally {
      await fixture.db.close();
    }
  });
}
