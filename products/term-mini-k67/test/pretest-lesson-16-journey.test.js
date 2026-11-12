import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createMiniFixture } from './helpers/mini-answer-sheet-fixture.js';

const slug = 'pretest-lesson-16';
const prefix = '/api/term-tests/' + slug;
const identity = { classCode: 'IC2304', studentRef: '11111111-1111-4111-8111-111111111111' };
const audioManifest = { sha256: 'a'.repeat(64), byteLength: 240, durationSeconds: 6 };
const assets = {
  supports: candidate => candidate === slug,
  getContent: () => ({ title: 'Đề kiểm Pretest' }),
  getTiming: () => ({
    readingDurationMinutes: 1,
    listeningDurationSeconds: 6,
    listeningTotalSeconds: 8,
    listeningReviewSeconds: 2
  }),
  getJourneyManifest: () => audioManifest,
  getSessionAudioKey: () => Buffer.alloc(32)
};

test('Pretest goes Reading → Listening → result and recovers the committed receipt once', async t => {
  const fixture = await createMiniFixture({
    examOrder: true,
    assets,
    pretestCbtJourneyMode: 'on'
  });
  t.after(() => fixture.db.close());

  const listeningKey = {
    questions: [21, 22].map(number => ({ number, type: 'Chọn hai', pairGroup: 'pair' })),
    pairGroups: { pair: { numbers: [21, 22], expected: ['C', 'E'] } }
  };
  const readingKey = { questions: [{ number: 14, type: 'Ghép đoạn', accepted: ['A'] }] };
  await fixture.db.query(`
    INSERT INTO assessment.test_definition
      (slug,title,version,listening_definition,reading_definition,is_active)
    VALUES($1,'Đề kiểm Pretest',1,$2,$3,true)
  `, [slug, JSON.stringify(listeningKey), JSON.stringify(readingKey)]);
  await fixture.db.query('UPDATE assessment.test_definition SET open_class_ids=$2 WHERE slug=$1', [slug, JSON.stringify(['1293'])]);
  await fixture.db.exec(`INSERT INTO mapping.classroom_course_mapping VALUES (1300, 'NONK67');
    INSERT INTO mapping.student_mapping_review VALUES
      ('88888888-8888-4888-8888-888888888888',1300,900003,'Học viên ngoài phạm vi','approved')`);

  const api = request(fixture.app);
  const audioCors = await api.options(prefix + '/cbt-journey/audio')
    .set('Origin', 'https://tranhoangduc90.github.io')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,range,x-term2-permit');
  assert.equal(audioCors.status,204);
  assert.match(audioCors.headers['access-control-allow-headers'],/\bRange\b/i);
  assert.match(audioCors.headers['access-control-expose-headers'],/\bContent-Range\b/i);
  assert.equal((await api.get('/api/term-tests/roster').query({class:'NONK67',test:slug})).status, 404);
  const outside = {classCode:'NONK67',studentRef:'88888888-8888-4888-8888-888888888888'};
  assert.equal((await api.post(prefix + '/student-identity').send(outside)).body.status, 'missing');
  assert.equal((await api.post(prefix + '/session/prepare').send({
    ...outside, examMode:'read_first', examDelivery:'cbt', orderClientVersion:1
  })).status, 404);
  assert.equal((await api.post('/api/term-tests/demo/reset').send({
    ...identity, testSlug:slug, confirmation:'RESET_DEMO_STUDENT'
  })).status, 400);
  const prepared = await api.post(prefix + '/session/prepare').send({
    ...identity, examMode: 'read_first', examDelivery: 'cbt', orderClientVersion: 1
  });
  assert.equal(prepared.status, 200, prepared.text);
  const scope = {
    examSessionToken: prepared.body.examSessionToken,
    generation: 0,
    deviceProof: 'b'.repeat(64)
  };
  const offer = await api.post(prefix + '/cbt-journey/prepare').send({ ...identity, ...scope });
  assert.equal(offer.status, 200, offer.text);
  assert.equal(offer.body.examMode, 'read_first');
  assert.deepEqual(offer.body.audioManifest, audioManifest);
  const post = (path, body) => api.post(prefix + '/cbt-journey/' + path)
    .set('x-term2-permit', offer.body.permit)
    .send({ ...scope, ...body });
  const begin = await post('begin', {});
  assert.equal(begin.status, 200, begin.text);

  const activation = await fixture.db.query(`
    UPDATE assessment.term_k67_cbt_journey SET activated_at=clock_timestamp()-interval '1 minute'
    WHERE session_id=$1 RETURNING activated_at
  `, [scope.examSessionToken]);
  const started = new Date(activation.rows[0].activated_at).getTime();
  const read = await post('seal', {
    section: 'reading', operationId: randomUUID(), previousOperationId: null,
    startedAt: started, capturedAt: started + 2_000, revision: 1,
    automatic: false, eofAt: null, heardSeconds: 0, answers: { 14: 'A' }
  });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.receipt.nextSection, 'listening');
  assert.equal(read.body.receipt.completed, false);

  const listening = {
    section: 'listening', operationId: randomUUID(), previousOperationId: read.body.receipt.operationId,
    startedAt: started + 3_000, capturedAt: started + 11_000, revision: 1,
    automatic: true, eofAt: started + 9_000, heardSeconds: 6, answers: { 21: 'E', 22: 'C' }
  };
  // Bỏ nội dung phản hồi đầu để mô phỏng máy chủ đã lưu nhưng người học chưa nhận xác nhận.
  const committed = await post('seal', listening);
  assert.equal(committed.status, 200, committed.text);

  const recovered = await post('status', { section: 'listening', operationId: listening.operationId });
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.body.persisted, true);
  assert.equal(recovered.body.receipt.operationId, listening.operationId);
  assert.equal(recovered.body.receipt.nextSection, 'result');
  assert.equal(recovered.body.receipt.completed, true);
  const retry = await post('seal', listening);
  assert.deepEqual(retry.body.receipt, recovered.body.receipt);
  assert.equal((await post('seal', { ...listening, answers: { 21: 'C' } })).status, 409);

  const attempts = await fixture.db.query(`
    SELECT id,writing_scope,writing_submitted_at,listening_result,reading_result,completed_at
    FROM assessment.term_test_attempt WHERE exam_session_id=$1
  `, [scope.examSessionToken]);
  assert.equal(attempts.rows.length, 1);
  const [attempt] = attempts.rows;
  assert.equal(attempt.id, recovered.body.receipt.attemptToken);
  assert.equal(attempt.writing_scope, 'lr_only');
  assert.equal(attempt.writing_submitted_at, null);
  assert.equal(attempt.listening_result.correct, 2);
  assert.equal(attempt.reading_result.correct, 1);
  assert.ok(attempt.completed_at);
});
