import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseFormDefinition, parseFormGradingKey } from '../src/learning-contracts.js';
import { sha256, stableStringify } from '../src/learning-domain.js';
import { createLearningDemoApp, createPGlitePool, initializeLearningDemoDatabase } from '../src/learning-demo.js';
import { createLearningDemoGrant, verifyLearningDemoGrant } from '../src/learning-demo-grant.js';
import { createLearningRouter } from '../src/learning-routes.js';
import { fetchLearningDemoSourceSql, insertLearningAssignmentSql,
  listLearningTeacherOptionsSql } from '../src/learning-sql.js';
import express from 'express';
import { buildIc2305Session4Definition, buildIc2305Session4GradingKey } from '../src/learning-templates/ic2305-session4-listening1-speaking2.js';
import { buildIc2305Writing1Definition } from '../src/learning-templates/ic2305-entrance-writing1.js';
import { buildIc2304Session2SpeakingDefinition,
  buildIc2304Session2SpeakingGradingKey } from '../src/learning-templates/ic2304-session2-speaking.js';

const origin = 'https://tranhoangduc90.github.io';
const sourceTokenA = '90000000-0000-4000-8000-000000000001';
const sourceTokenB = '90000000-0000-4000-8000-000000000002';
const sourceTokenC = '90000000-0000-4000-8000-000000000003';
const demoHeaders = { origin, 'x-progress-log-demo': '1' };
const grantSecret = 'preview-grant-secret-for-tests-0123456789';
function grantFor(token, source) {
  return createLearningDemoGrant({ assignmentId: source.sourceAssignmentId,
    publicToken: token, definitionHash: source.definitionHash, secret: grantSecret });
}

function sources() {
  const writing = buildIc2305Writing1Definition();
  const shortDefinition = parseFormDefinition({
    ...writing,
    kind: 'reflection',
    blocks: [{ ...writing.blocks[0], items: writing.blocks[0].items.slice(0, 2) }]
  });
  const shortKey = parseFormGradingKey({
    schemaVersion: 'FormGradingKeyV1', formVersionId: shortDefinition.formVersionId,
    graderVersion: 1, items: {}, groups: {}
  });
  const session4 = buildIc2305Session4Definition();
  const session2 = buildIc2304Session2SpeakingDefinition();
  return new Map([
    [sourceTokenA, {
      sourceAssignmentId: 'a0000000-0000-4000-8000-000000000001',
      title: shortDefinition.title, className: 'Lớp kiểm thử A', sessionNumber: 4,
      courseCode: 'ic23', definition: shortDefinition, gradingKey: shortKey,
      blockReleases: [{ blockId: shortDefinition.blocks[0].blockId, status: 'locked' }],
      answerReleaseOverride: 'immediate',
      definitionHash: sha256(stableStringify(shortDefinition))
    }],
    [sourceTokenB, {
      sourceAssignmentId: 'a0000000-0000-4000-8000-000000000002',
      title: session4.title, className: 'Lớp kiểm thử B', sessionNumber: 5,
      courseCode: 'ic23', definition: session4, gradingKey: buildIc2305Session4GradingKey(),
      definitionHash: sha256(stableStringify(session4))
    }],
    [sourceTokenC, {
      sourceAssignmentId: 'a0000000-0000-4000-8000-000000000003',
      title: session2.title, className: 'Lớp kiểm thử C', sessionNumber: 2,
      courseCode: 'ic23', definition: session2,
      gradingKey: buildIc2304Session2SpeakingGradingKey(['A', 'A', 'A', 'A', 'A']),
      definitionHash: sha256(stableStringify(session2))
    }]
  ]);
}

test('bản thử tự tạo từ ba kiểu phiếu, cô lập giảng viên và đặt lại an toàn', async () => {
  const database = new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    const pool = createPGlitePool(database);
    const catalog = sources();
    const app = createLearningDemoApp({ pool, allowedOrigin: origin, grantSecret,
      fetchSource: async token => {
        if (!catalog.has(token)) throw new Error('Không có phiếu nguồn.');
        return catalog.get(token);
      }
    });
    await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ sourceToken: sourceTokenA }).expect(403);
    const mismatchedGrant = createLearningDemoGrant({ assignmentId: crypto.randomUUID(),
      publicToken: sourceTokenA, definitionHash: catalog.get(sourceTokenA).definitionHash,
      secret: grantSecret });
    await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ grant: mismatchedGrant }).expect(409);
    const noRun = await pool.query(`SELECT count(*)::int AS n FROM learning_demo.run`);
    assert.equal(noRun.rows[0].n, 0);
    const first = await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ grant: grantFor(sourceTokenA, catalog.get(sourceTokenA)) }).expect(201);
    const second = await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ grant: grantFor(sourceTokenB, catalog.get(sourceTokenB)) }).expect(201);
    const third = await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ grant: grantFor(sourceTokenC, catalog.get(sourceTokenC)) }).expect(201);
    assert.notEqual(first.body.run.publicToken, sourceTokenA);
    assert.notEqual(first.body.run.publicToken, second.body.run.publicToken);
    const thirdForm = await request(app).post('/api/learning/assignments/open').set(demoHeaders)
      .send({ publicToken: third.body.run.publicToken }).expect(200);
    assert.equal(thirdForm.body.assignment.definition.blocks.length, 3);
    assert.equal(thirdForm.body.assignment.roster.length, 3);

    const opened = await request(app).post('/api/learning/assignments/open').set(demoHeaders)
      .send({ publicToken: first.body.run.publicToken }).expect(200);
    assert.equal(opened.body.assignment.roster.length, 3);
    assert.ok(opened.body.assignment.roster.every(student => student.name.startsWith('Học viên mẫu')));
    assert.equal(opened.body.assignment.class.name, 'Lớp kiểm thử A · bản thử');
    assert.equal(opened.body.assignment.definition.blocks.length, 1);
    assert.equal(opened.body.assignment.blockReleases[0].status, 'locked');
    assert.equal(JSON.stringify(opened.body).includes('gradingKey'), false);
    const sourceReadback = await pool.query(fetchLearningDemoSourceSql, [first.body.run.publicToken]);
    assert.equal(sourceReadback.rows.length, 1);
    assert.equal(sourceReadback.rows[0].definition_hash, opened.body.assignment.definitionHash);
    assert.equal(JSON.stringify(sourceReadback.rows[0]).includes('Học viên mẫu'), false);

    const teacherA = { ...demoHeaders, 'x-demo-teacher-token': first.body.run.teacherToken };
    await request(app).post('/api/demo/runs/open-blocks').set(teacherA).send({}).expect(200);
    const afterOpen = await request(app).post('/api/learning/assignments/open').set(demoHeaders)
      .send({ publicToken: first.body.run.publicToken }).expect(200);
    assert.equal(afterOpen.body.assignment.blockReleases[0].status, 'open');
    const options = await request(app).get('/api/learning/teacher/options').set(teacherA).expect(200);
    assert.equal(options.body.assignments.length, 1);
    await request(app).get(`/api/learning/teacher/dashboard?assignment=${second.body.run.assignmentId}`)
      .set(teacherA).expect(404);

    const studentRef = opened.body.assignment.roster[0].studentRef;
    const started = await request(app).post('/api/learning/attempts/start').set(demoHeaders).send({
      publicToken: first.body.run.publicToken, studentRef,
      clientIdempotencyKey: crypto.randomUUID(), identityConfirmed: true
    }).expect(201);
    const responses = Object.fromEntries(opened.body.assignment.definition.blocks[0].items.map(item =>
      [item.itemVersionId, 'Câu trả lời thử']));
    await request(app).patch('/api/learning/attempts/draft').set(demoHeaders).send({
      attemptToken: started.body.attempt.attemptToken, revision: 1,
      definitionHash: opened.body.assignment.definitionHash, responses
    }).expect(200);
    const submitted = await request(app).post('/api/learning/attempts/submit').set(demoHeaders).send({
      attemptToken: started.body.attempt.attemptToken,
      submissionId: crypto.randomUUID(), definitionHash: opened.body.assignment.definitionHash,
      draftRevision: 1, responses
    }).expect(200);
    assert.equal(submitted.body.receipt.completeness, 'complete');
    const feedback = await request(app).put('/api/learning/teacher/session-feedback').set(teacherA).send({
      assignmentId: first.body.run.assignmentId, studentRef,
      noteText: 'Speaking: em đã nói rõ ý chính.', expectedRevision: 0,
      operationId: crypto.randomUUID()
    }).expect(200);
    assert.equal(feedback.body.feedback.revision, 1);
    const accessToken = crypto.randomBytes(32).toString('base64url');
    await request(app).post('/api/learning/teacher/student-progress-links').set(teacherA).send({
      assignmentId: first.body.run.assignmentId, studentRef, accessToken,
      expiresInDays: 1, operationId: crypto.randomUUID()
    }).expect(201);
    const journey = await request(app).post('/api/learning/student/course-journey').set(demoHeaders)
      .send({ accessToken }).expect(200);
    assert.equal(journey.body.journey.sessions[0].teacherSessionFeedback.noteText,
      'Speaking: em đã nói rõ ý chính.');

    const reset = await request(app).post('/api/demo/runs/reset').set(teacherA).send({}).expect(201);
    assert.notEqual(reset.body.run.publicToken, first.body.run.publicToken);
    await request(app).get('/api/learning/teacher/options').set(teacherA).expect(401);
    await request(app).post('/api/learning/assignments/open').set(demoHeaders)
      .send({ publicToken: first.body.run.publicToken }).expect(404);
    const expired = await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ runToken: first.body.run.publicToken }).expect(410);
    assert.equal(expired.body.error, 'DEMO_RUN_EXPIRED');
    await request(app).post('/api/learning/student/course-journey').set(demoHeaders)
      .send({ accessToken }).expect(404);

    await request(app).post('/api/demo/runs/draft').set(demoHeaders)
      .send({ source: catalog.get(sourceTokenA) }).expect(404);
  } finally { await database.close(); }
});

test('cổng nguồn chỉ trả nội dung cho khóa máy chủ, không trả roster', async () => {
  const source = sources().get(sourceTokenA);
  const app = express();
  app.use(express.json());
  app.use('/api/learning', createLearningRouter({
    pool: { query: async () => ({ rowCount: 1, rows: [{
      source_assignment_id: crypto.randomUUID(), class_name: source.className,
      course_code: source.courseCode, session_number: source.sessionNumber,
      title: source.title, definition_hash: source.definitionHash,
      public_definition: source.definition, private_definition: source.gradingKey,
      roster: [{ name: 'Không được xuất' }]
    }] }) },
    authenticate: (_req, _res, next) => next(),
    demoSourceSecret: 'a'.repeat(40)
  }));
  await request(app).post('/api/learning/assignments/demo-source')
    .set('x-learning-demo-source', 'wrong').send({ publicToken: sourceTokenA }).expect(404);
  const output = await request(app).post('/api/learning/assignments/demo-source')
    .set('x-learning-demo-source', 'a'.repeat(40))
    .send({ publicToken: sourceTokenA }).expect(200);
  assert.equal(JSON.stringify(output.body).includes('Không được xuất'), false);
  assert.equal(output.body.source.definitionHash, source.definitionHash);
  assert.ok(output.body.source.gradingKey);
});

test('vé xem thử bị khóa vào đúng phiếu, đúng phiên bản và hết hạn sau năm phút', () => {
  const source = sources().get(sourceTokenA);
  const grant = grantFor(sourceTokenA, source);
  assert.equal(verifyLearningDemoGrant(grant, grantSecret).assignmentId, source.sourceAssignmentId);
  assert.equal(verifyLearningDemoGrant(`${grant}x`, grantSecret), null);
  assert.equal(verifyLearningDemoGrant(grant, `${grantSecret}wrong`), null);
  const old = createLearningDemoGrant({ assignmentId: source.sourceAssignmentId,
    publicToken: sourceTokenA, definitionHash: source.definitionHash,
    secret: grantSecret, now: Date.now() - 301_000 });
  assert.equal(verifyLearningDemoGrant(old, grantSecret), null);
});

test('dashboard chỉ cấp vé cho giảng viên có quyền lớp của phiếu đã phát hành', async () => {
  const database = new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    const pool = createPGlitePool(database);
    const source = sources().get(sourceTokenA);
    await pool.query(`INSERT INTO mapping.classroom_course_mapping
      (erp_course_class_id, erp_class_name_snapshot) VALUES (12345, 'Lớp kiểm thử')`);
    await pool.query(`INSERT INTO mapping.reviewer_class_access
      (reviewer_email, erp_course_class_id) VALUES ('allowed@example.invalid', 12345)`);
    const form = await pool.query(`INSERT INTO learning.form_template
      (title, kind, created_by_email) VALUES ($1, $2, $3) RETURNING id::text`,
    [source.title, source.definition.kind, 'allowed@example.invalid']);
    await pool.query(`INSERT INTO learning.form_version
      (id, template_id, version, schema_version, public_definition, definition_hash,
       status, created_by_email, approved_by_email, published_at)
      VALUES ($1::uuid, $2::uuid, 1, 'FormDefinitionV1', $3::jsonb, $4,
        'published', 'allowed@example.invalid', 'approver@example.invalid', now())`,
    [source.definition.formVersionId, form.rows[0].id, JSON.stringify(source.definition), source.definitionHash]);
    const assignment = await pool.query(insertLearningAssignmentSql,
      [source.definition.formVersionId, source.courseCode, '12345', 'Lớp kiểm thử',
        source.sessionNumber, source.title, null, null, 'allowed@example.invalid']);
    const legacyDemo = await pool.query(insertLearningAssignmentSql,
      [source.definition.formVersionId, 'DEMO-56', '12345', 'Lớp kiểm thử',
        source.sessionNumber, `${source.title} · Bản dùng thử cũ`, null, null, 'allowed@example.invalid']);
    const options = await pool.query(listLearningTeacherOptionsSql, ['allowed@example.invalid', false]);
    assert.deepEqual(options.rows[0].response.assignments.map(item => item.assignment_id),
      [assignment.rows[0].assignment_id]);
    let reviewer = { email: 'denied@example.invalid', canAccessAllClasses: false };
    const app = express();
    app.use(express.json());
    app.use('/api/learning', createLearningRouter({ pool,
      authenticate: (req, _res, next) => { req.reviewer = reviewer; next(); },
      demoSourceSecret: grantSecret }));
    const body = { assignmentId: assignment.rows[0].assignment_id };
    await request(app).post('/api/learning/teacher/demo-grants').send(body).expect(404);
    reviewer = { email: 'allowed@example.invalid', canAccessAllClasses: false };
    const allowed = await request(app).post('/api/learning/teacher/demo-grants').send(body).expect(200);
    const verified = verifyLearningDemoGrant(allowed.body.grant, grantSecret);
    assert.equal(verified.assignmentId, body.assignmentId);
    assert.equal(verified.publicToken, assignment.rows[0].public_token);
    await pool.query(`INSERT INTO mapping.reviewer_account (email, status)
      VALUES ('progress-admin@example.invalid', 'active')`);
    await pool.query(`INSERT INTO learning.progress_log_admin
      (reviewer_email, status, grant_reference)
      VALUES ('progress-admin@example.invalid', 'active', 'local-test-grant')`);
    reviewer = { email: 'progress-admin@example.invalid', canAccessAllClasses: false };
    await request(app).post('/api/learning/teacher/demo-grants').send(body).expect(200);
    await pool.query(`UPDATE learning.progress_log_admin SET status = 'revoked'
      WHERE reviewer_email = 'progress-admin@example.invalid'`);
    await request(app).post('/api/learning/teacher/demo-grants').send(body).expect(404);
    reviewer = { email: 'allowed@example.invalid', canAccessAllClasses: false };
    await request(app).post('/api/learning/teacher/demo-grants')
      .send({ assignmentId: legacyDemo.rows[0].assignment_id }).expect(404);
    reviewer = { email: 'denied@example.invalid', canAccessAllClasses: false };
    await request(app).post('/api/learning/teacher/demo-grants')
      .send({ assignmentId: crypto.randomUUID() }).expect(404);
  } finally { await database.close(); }
});

test('dịch vụ demo chặn request thiếu dấu hiệu bản thử hoặc sai origin', async () => {
  const database = new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    const app = createLearningDemoApp({ pool: createPGlitePool(database),
      allowedOrigin: origin, grantSecret, fetchSource: async () => { throw new Error('Không được gọi.'); } });
    await request(app).post('/api/demo/runs').send({ sourceToken: sourceTokenA }).expect(403);
    await request(app).post('/api/demo/runs')
      .set({ 'x-progress-log-demo': '1', origin: 'https://example.invalid' })
      .send({ sourceToken: sourceTokenA }).expect(403);
  } finally { await database.close(); }
});

test('API lớp thật từ chối dấu hiệu demo trước khi truy vấn dữ liệu', async () => {
  let learningQueries = 0;
  const app = createApp({
    config: {
      nodeEnv: 'test', authMode: 'google', googleClientId: 'client-for-test',
      allowedOrigins: new Set([origin]), trustProxyHops: 0,
      learningEnabled: true, learningDemoSourceSecret: 'a'.repeat(40)
    },
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
    learningPool: { query: async () => { learningQueries += 1; return { rowCount: 0, rows: [] }; } },
    verifyGoogleToken: async () => { throw new Error('Không được gọi.'); }
  });
  const response = await request(app).post('/api/learning/assignments/open')
    .set('x-progress-log-demo', '1').send({ publicToken: sourceTokenA }).expect(403);
  assert.equal(response.body.error, 'DEMO_REQUEST_ON_LIVE_API');
  assert.equal(learningQueries, 0);
});

test('dịch vụ demo từ chối biến một kho learning có sẵn thành kho thử', async () => {
  const database = new PGlite();
  try {
    await database.exec('CREATE SCHEMA learning; CREATE TABLE learning.form_template (id integer);');
    await assert.rejects(initializeLearningDemoDatabase(database),
      /Từ chối biến kho dữ liệu khác thành kho demo/);
  } finally { await database.close(); }
});

test('hai tab đặt lại đồng thời chỉ giữ một lượt mới; lượt hết hạn bị khóa', async () => {
  const database = new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    const pool = createPGlitePool(database);
    const app = createLearningDemoApp({ pool, allowedOrigin: origin, grantSecret,
      fetchSource: async () => sources().get(sourceTokenA) });
    const created = await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ grant: grantFor(sourceTokenA, sources().get(sourceTokenA)) }).expect(201);
    const teacher = { ...demoHeaders, 'x-demo-teacher-token': created.body.run.teacherToken };
    const attempts = await Promise.all([1, 2].map(() => request(app)
      .post('/api/demo/runs/reset').set(teacher).send({})));
    assert.equal(attempts.filter(item => item.status === 201).length, 1);
    assert.ok([401, 409].includes(attempts.find(item => item.status !== 201).status));
    const newRun = attempts.find(item => item.status === 201).body.run;
    const active = await pool.query(`SELECT count(*)::int AS n FROM learning_demo.run
      WHERE source_token = $1::uuid AND reset_at IS NULL`, [sourceTokenA]);
    assert.equal(active.rows[0].n, 1);
    await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ runToken: created.body.run.publicToken }).expect(410);
    await pool.query(`UPDATE learning_demo.run SET expires_at = now() - interval '1 second'
      WHERE id = $1::uuid`, [newRun.runId]);
    await request(app).get('/api/learning/teacher/options').set({ ...demoHeaders,
      'x-demo-teacher-token': newRun.teacherToken }).expect(401);
    await request(app).post('/api/demo/runs').set(demoHeaders)
      .send({ runToken: newRun.publicToken }).expect(410);
  } finally { await database.close(); }
});

test('20 giảng viên cùng mở bản thử vẫn có 20 lượt tách biệt', async () => {
  const database = new PGlite();
  try {
    await initializeLearningDemoDatabase(database);
    const pool = createPGlitePool(database);
    const source = sources().get(sourceTokenA);
    const app = createLearningDemoApp({ pool, allowedOrigin: origin, grantSecret,
      fetchSource: async () => source });
    const grant = grantFor(sourceTokenA, source);
    const opened = await Promise.all(Array.from({ length: 20 }, () => request(app)
      .post('/api/demo/runs').set(demoHeaders).send({ grant })));
    assert.ok(opened.every(result => result.status === 201),
      opened.map(result => result.status).join(','));
    assert.equal(new Set(opened.map(result => result.body.run.publicToken)).size, 20);
    const stored = await pool.query(`SELECT count(*)::int AS n FROM learning_demo.run
      WHERE reset_at IS NULL AND expires_at > now()`);
    assert.equal(stored.rows[0].n, 20);
  } finally { await database.close(); }
});
