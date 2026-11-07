import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const root = '/api/term-tests/mini-test-lesson-5';
const fixtureRef = '11111111-1111-4111-8111-111111111111';
const assets = { supports: () => true, getTiming: () => ({ readingDurationMinutes: 20, listeningDurationSeconds: 10,
  listeningTotalSeconds: 130, listeningReviewSeconds: 120 }), getContent: () => ({}), getSessionAudioKey: () => Buffer.alloc(32) };

for (const mode of ['lis_first', 'read_first']) test('late sealed Mini CBT and lost ACK ' + mode, async () => {
  const f = await createMiniFixture({ examOrder: true, assets, miniListeningEofEnabled: true, miniCbtOfflineMode: 'on' });
  try {
    const api = request(f.app);
    const info = { classCode: 'IC2304', studentRef: fixtureRef };
    const post = (url, data) => api.post(root + url).send({ ...data, orderClientVersion: 1 });
    const opened = await post('/session/prepare', { ...info, examMode: mode, examDelivery: 'cbt' });
    assert.ok(opened.ok, opened.text);
    const section = mode === 'read_first' ? 'reading' : 'listening';
    const scope = { examSessionToken: opened.body.examSessionToken, ...(opened.body.attemptToken ? { attemptToken: opened.body.attemptToken } : {}),
      section, generation: 0 };
    assert.equal((await post('/cbt-offline/grant', { ...scope, ...info })).status, 409);
    const started = await post(section === 'reading' ? '/reading/start' : '/session/start', scope);
    assert.ok(started.ok, started.text);
    const wrong = await post('/cbt-offline/grant', { ...scope, ...info, studentRef: '44444444-4444-4444-8444-444444444444' });
    assert.equal(wrong.status, 403);
    const table = section === 'listening' ? 'term_test_exam_session' : 'term_test_attempt';
    const question = section === 'listening' ? '11' : '14';
    const token = section === 'listening' ? scope.examSessionToken : scope.attemptToken;
    await f.db.query(`UPDATE assessment.${table} SET ${section}_started_at=now()-interval '45 minutes',
      ${section}_deadline_at=now()+interval '5 minutes',${section}_draft=$2::jsonb,${section}_draft_revision=1
      WHERE id=$1`, [token, JSON.stringify({ [question]: 'A' })]);
    const grant = await post('/cbt-offline/grant', { ...scope, ...info });
    assert.ok(grant.ok, grant.text);
    const send = (path, data, permit = grant.body.permit) => api.post(root + '/cbt-offline/' + path).set('x-term2-permit', permit).send(data);
    const expired = await f.db.query(`UPDATE assessment.${table} SET ${section}_deadline_at=now()-interval '10 minutes'
      WHERE id=$1 RETURNING ${section}_deadline_at AS deadline`, [token]);
    assert.equal((await post('/cbt-offline/grant', { ...scope, ...info })).body.error, 'OFFLINE_NEW_DISABLED');
    const deadline = new Date(expired.rows[0].deadline).getTime();
    const op = { ...scope, operationId: randomUUID(), capturedAt: new Date(deadline - 10_000).toISOString(),
      revision: 2, automatic: false, answers: { [question]: 'B' } };
    assert.equal((await send('seal', op, 'a'.repeat(64))).status, 403);
    assert.equal((await send('seal', { ...op, capturedAt: new Date(deadline + 100_000).toISOString() })).body.error, 'OFFLINE_REVIEW_REQUIRED');
    if (section === 'listening') {
      const refused = await send('seal', { ...op, automatic: true, capturedAt: new Date(deadline).toISOString() });
      assert.equal(refused.body.error, 'AUDIO_END_NOT_CONFIRMED');
    }
    assert.equal((await send('status', { ...scope, operationId: op.operationId })).body.persisted, false);
    const sealed = await send('seal', op);
    assert.ok(sealed.ok, sealed.text);
    const ack = await send('status', { ...scope, operationId: op.operationId });
    assert.deepEqual(ack.body.receipt, sealed.body.receipt);
    assert.deepEqual((await send('seal', op)).body.receipt, sealed.body.receipt);
    assert.equal((await send('seal', { ...op, answers: { [question]: 'C' } })).body.error, 'OFFLINE_CONFLICT');
    const saved = (await f.db.query(`SELECT ${section}_answers AS answers FROM assessment.term_test_attempt WHERE exam_session_id=$1`,
      [scope.examSessionToken])).rows;
    assert.deepEqual(saved.map(row => row.answers), [{ [question]: 'B' }]);
    const other = section === 'listening' ? 'reading' : 'listening';
    const otherScope = { ...scope, section: other, attemptToken: sealed.body.receipt.attemptToken };
    const otherStarted = await post(other === 'reading' ? '/reading/start' : '/session/start', otherScope);
    assert.ok(otherStarted.ok, otherStarted.text);
    const secondGrant = await post('/cbt-offline/grant', { ...otherScope, ...info });
    assert.ok(secondGrant.ok, secondGrant.text);
    const second = await send('seal', { ...otherScope, operationId: randomUUID(), capturedAt: secondGrant.body.serverNow,
      revision: 1, automatic: false, answers: { [other === 'listening' ? '11' : '14']: 'A' } }, secondGrant.body.permit);
    assert.ok(second.ok, second.text);
    assert.equal(second.body.receipt.completed, true);
    assert.equal(second.body.receipt.nextSection, 'result');
    assert.equal(second.body.receipt.attemptToken, sealed.body.receipt.attemptToken);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assessment.mini_k67_cbt_offline_seal')).rows[0].n, 2);
  } finally { await f.db.close(); }
});
