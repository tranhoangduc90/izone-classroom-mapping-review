import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createSpeakingHomeworkService, parseSpeakingShareUrl } from '../src/speaking-homework.js';

const studentRef = '60000000-0000-4000-8000-000000000001';
const secondStudentRef = '60000000-0000-4000-8000-000000000002';
const accessToken = 'student-access-token-32-characters-long';
const secondToken = 'second-access-token-32-characters-long';
const workerSecret = 'test-worker-secret-with-32-characters';
const fingerprint = letter => letter.repeat(64);
const share = letter => `https://chatgpt.com/share/${letter.repeat(32)}`;

function poolFrom(db) {
  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.rowCount ?? result.rows.length };
  };
  return { query, async connect() { return { query, release() {} }; } };
}

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY, erp_class_name_snapshot TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE mapping.student_mapping_review (
      public_id UUID PRIMARY KEY, erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL, erp_student_name_snapshot TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      erp_course_class_id BIGINT NOT NULL, erp_student_contact_id BIGINT NOT NULL
    );
    CREATE TABLE mapping.reviewer_class_access (
      reviewer_email TEXT NOT NULL, erp_course_class_id BIGINT NOT NULL
    );
    CREATE TABLE mapping.reviewer_class_assignment (
      reviewer_email TEXT NOT NULL, class_name TEXT NOT NULL
    );
    INSERT INTO mapping.classroom_course_mapping VALUES (2304, 'IC2304', 'approved');
    INSERT INTO mapping.student_mapping_review VALUES
      ('${studentRef}', 2304, 1, 'Học viên A', 'approved'),
      ('${secondStudentRef}', 2304, 2, 'Học viên B', 'approved');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES (2304, 1), (2304, 2);
  `);
  const migration = await readFile(new URL('../ops/migrations/202609270001_speaking_homework_candidate.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  const pool = poolFrom(db);
  const first = await pool.query(`INSERT INTO speaking_homework.assignment
    (class_id, course_id, course_work_id, assignment_code, doctor_course_key, title, status)
    VALUES (2304, 'course-2304', 'lesson-2', '67-speaking-lesson-2', '67', 'Homework Lesson 2', 'open') RETURNING id`);
  const second = await pool.query(`INSERT INTO speaking_homework.assignment
    (class_id, course_id, course_work_id, assignment_code, doctor_course_key, title, status)
    VALUES (2304, 'course-2304', 'lesson-3', '67-speaking-lam_ro', '67', 'Homework Lesson 3', 'open') RETURNING id`);
  for (const [assignmentId, parts] of [
    [first.rows[0].id, [['paraphrase', 5], ['speaking', 3]]],
    [second.rows[0].id, [['clarify_1', 3], ['clarify_2', 2], ['clarify_3', 2], ['speaking', 2]]]
  ]) {
    for (let i = 0; i < parts.length; i++) {
      await pool.query(`INSERT INTO speaking_homework.assignment_part
        (assignment_id, part_key, display_title, practice_url, min_questions, position)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [assignmentId, parts[i][0], parts[i][0], 'https://example.test/practice', parts[i][1], i + 1]);
    }
  }
  await pool.query('INSERT INTO speaking_homework.assignment_document (assignment_id, document_id) VALUES ($1, $2)', [first.rows[0].id, 'doc-A']);
  await pool.query('INSERT INTO speaking_homework.assignment_document (assignment_id, document_id) VALUES ($1, $2)', [second.rows[0].id, 'doc-B']);
  await pool.query('INSERT INTO speaking_homework.assignment_document (assignment_id, document_id) VALUES ($1, $2)', [second.rows[0].id, 'doc-C']);
  for (const [assignmentId, ref, token, doc] of [
    [first.rows[0].id, studentRef, accessToken, 'doc-A'],
    [second.rows[0].id, secondStudentRef, secondToken, 'doc-B']
  ]) {
    await pool.query(`INSERT INTO speaking_homework.access_grant
      (assignment_id, student_ref, document_id, token_hash) VALUES ($1, $2, $3, $4)`,
    [assignmentId, ref, doc, crypto.createHash('sha256').update(token).digest('hex')]);
  }
  return { db, pool, service: createSpeakingHomeworkService({ pool }) };
}

async function checkAccepted(service, token, ref, part, letter, count, fp = fingerprint(letter)) {
  await service.requestCheck({ accessToken: token, studentRef: ref, part, rawUrl: share(letter) });
  const job = await service.claimCheckJob();
  assert.equal(job.part, part);
  const checked = await service.completeCheck({ checkJobId: job.job_id, fingerprint: fp,
    questionCount: count, qualityPassed: true });
  assert.equal(checked.status, 'accepted');
  return job;
}

test('chỉ nhận đúng link Share, chuẩn hóa URL và chặn link hội thoại riêng', () => {
  assert.deepEqual(parseSpeakingShareUrl(`${share('a')}?utm=1#x`),
    { url: share('a'), shareId: 'a'.repeat(32) });
  assert.throws(() => parseSpeakingShareUrl('https://chatgpt.com/c/abc'), { code: 'INVALID_SHARE_URL' });
  assert.throws(() => parseSpeakingShareUrl('https://evil.test/share/' + 'a'.repeat(32)),
    { code: 'INVALID_SHARE_URL' });
});

test('đúng học viên mới mở được, hai link đạt mới chốt và retry chỉ có một biên nhận', async () => {
  const { db, pool, service } = await fixture();
  try {
    await assert.rejects(service.open({ accessToken, studentRef: secondStudentRef }), { code: 'ACCESS_DENIED' });
    await assert.rejects(service.finish({ accessToken, studentRef }), { code: 'ALL_LINKS_REQUIRED' });
    await checkAccepted(service, accessToken, studentRef, 'paraphrase', 'a', 5);
    await assert.rejects(service.finish({ accessToken, studentRef }), { code: 'ALL_LINKS_REQUIRED' });
    await checkAccepted(service, accessToken, studentRef, 'speaking', 'b', 3);
    const first = await service.finish({ accessToken, studentRef });
    const retry = await service.finish({ accessToken, studentRef });
    assert.equal(first.id, retry.id);
    const outbox = await pool.query('SELECT kind FROM speaking_homework.outbox ORDER BY kind');
    assert.deepEqual(outbox.rows.map(row => row.kind), ['doctor_analyze', 'grade_speaking', 'write_doc']);
    const queued = await service.claimOutboxJob();
    assert.equal(queued.receipt_id, first.id);
    assert.equal(queued.document_id, 'doc-A');
    assert.equal(queued.links.paraphrase.fingerprint, fingerprint('a'));
    await service.completeOutboxJob({ jobId: queued.job_id, externalReceipt: 'readback-proof-1' });
    const done = await pool.query('SELECT status, external_receipt FROM speaking_homework.outbox WHERE id = $1', [queued.job_id]);
    assert.equal(done.rows[0].status, 'done');
    assert.equal(done.rows[0].external_receipt, 'readback-proof-1');
    await assert.rejects(service.getTeacherReceipt({ receiptId: first.id,
      email: 'other@example.test' }), { code: 'RECEIPT_NOT_FOUND' });
    await pool.query('INSERT INTO mapping.reviewer_class_access VALUES ($1, $2)',
      ['teacher@example.test', 2304]);
    const teacher = await service.getTeacherReceipt({ receiptId: first.id,
      email: 'teacher@example.test' });
    assert.equal(teacher.document_id, 'doc-A');
    assert.equal(teacher.links.speaking.questionCount, 3);
    await assert.rejects(service.requestCheck({ accessToken: secondToken,
      studentRef: secondStudentRef, part: 'clarify_1', rawUrl: share('a') }),
    { code: 'REUSED_CONVERSATION', message: /Homework Lesson 2/ });
  } finally { await db.close(); }
});

test('nội dung trùng dù URL khác, thiếu câu và cảnh báo voice được xử lý đúng', async () => {
  const { db, service } = await fixture();
  try {
    await service.requestCheck({ accessToken, studentRef, part: 'paraphrase', rawUrl: share('a') });
    let job = await service.claimCheckJob();
    let checked = await service.completeCheck({ checkJobId: job.job_id,
      fingerprint: fingerprint('a'), questionCount: 4, qualityPassed: true });
    assert.equal(checked.code, 'INSUFFICIENT_PRACTICE');
    await checkAccepted(service, accessToken, studentRef, 'paraphrase', 'c', 5);
    await service.requestCheck({ accessToken, studentRef, part: 'speaking', rawUrl: share('d') });
    job = await service.claimCheckJob();
    checked = await service.completeCheck({ checkJobId: job.job_id,
      fingerprint: fingerprint('c'), questionCount: 3, qualityPassed: true });
    assert.equal(checked.status, 'accepted');
    // Chỉ claim từ bài đã chốt mới là trùng lịch sử; trùng trong cùng lượt bị bắt ở bước chốt.
    await assert.rejects(service.finish({ accessToken, studentRef }), { code: 'SAME_CONVERSATION' });
    await service.requestCheck({ accessToken, studentRef, part: 'speaking', rawUrl: share('e') });
    job = await service.claimCheckJob();
    checked = await service.completeCheck({ checkJobId: job.job_id,
      fingerprint: fingerprint('e'), questionCount: 3, qualityPassed: true,
      typingWarning: { summary: 'Có dấu hiệu gõ chữ.', evidence: ['Đoạn có dấu câu bất thường.'] } });
    assert.equal(checked.status, 'accepted');
    await assert.rejects(service.finish({ accessToken, studentRef }), { code: 'VOICE_CONFIRMATION_REQUIRED' });
    const receipt = await service.finish({ accessToken, studentRef,
      voiceConfirmedParts: ['speaking'] });
    assert.ok(receipt.id);
  } finally { await db.close(); }
});

test('Lesson 3 đòi đủ bốn phần theo ngưỡng riêng của bản cũ', async () => {
  const { db, service } = await fixture();
  try {
    await checkAccepted(service, secondToken, secondStudentRef, 'clarify_1', 'h', 3);
    await checkAccepted(service, secondToken, secondStudentRef, 'clarify_2', 'i', 2);
    await checkAccepted(service, secondToken, secondStudentRef, 'clarify_3', 'j', 2);
    await assert.rejects(service.finish({ accessToken: secondToken,
      studentRef: secondStudentRef }), { code: 'ALL_LINKS_REQUIRED' });
    await checkAccepted(service, secondToken, secondStudentRef, 'speaking', 'k', 2);
    const receipt = await service.finish({ accessToken: secondToken,
      studentRef: secondStudentRef });
    assert.ok(receipt.id);
  } finally { await db.close(); }
});

test('Bác sĩ AI giữ đúng Số lần đề xuất, Chờ luyện và điều kiện hơn 5 ngày của Lark', async () => {
  const { db, pool, service } = await fixture();
  try {
    const exercise = await pool.query(`INSERT INTO speaking_homework.doctor_exercise
      (course_key, source_record_id, title, exercise_url)
      VALUES ('67', 'lark-ex-1', 'Bài phát âm', 'https://example.test/exercise') RETURNING id`);
    const exerciseId = exercise.rows[0].id;
    async function event(sourceKey, kind, occurredAt) {
      return service.recordDoctorEvent({ sourceKey, kind, classId: '2304', studentRef,
        exerciseId, occurredAt });
    }
    await event('receipt-00000001:ex-1', 'recommendation', '2026-09-01T00:00:00.000Z');
    await event('practice-0000001:ex-1', 'practice', '2026-09-07T00:00:00.000Z');
    await event('receipt-00000002:ex-1', 'recommendation', '2026-09-08T00:00:00.000Z');
    let row = (await pool.query('SELECT * FROM speaking_homework.doctor_recommendation')).rows[0];
    assert.equal(row.recommendation_count, 2);
    assert.equal(row.practice_count, 1);
    assert.equal(row.waiting, true);
    assert.equal((await event('receipt-00000002:ex-1', 'recommendation', '2026-09-08T00:00:00.000Z')).duplicate, true);
    await event('practice-0000002:ex-1', 'practice', '2026-09-09T00:00:00.000Z');
    await event('receipt-00000003:ex-1', 'recommendation', '2026-09-10T00:00:00.000Z');
    row = (await pool.query('SELECT * FROM speaking_homework.doctor_recommendation')).rows[0];
    assert.equal(row.recommendation_count, 3);
    assert.equal(row.practice_count, 2);
    assert.equal(row.waiting, false);
    const list = await service.listDoctor({ accessToken, studentRef });
    assert.equal(list.neededCount, 0);
    assert.equal(list.practiced.length, 1);
  } finally { await db.close(); }
});

test('hai ô luyện bổ trợ nhận riêng, nhận diện đúng bài và tăng lượt luyện đúng một lần', async () => {
  const { db, pool, service } = await fixture();
  try {
    const exercise = await pool.query(`INSERT INTO speaking_homework.doctor_exercise
      (course_key, source_record_id, title, exercise_url)
      VALUES ('67', 'ex-1', 'Bài luyện âm', 'https://example.test/1') RETURNING id`);
    const exerciseId = exercise.rows[0].id;
    await service.recordDoctorEvent({ sourceKey: 'source-recommendation-01', kind: 'recommendation',
      classId: '2304', studentRef, exerciseId, occurredAt: '2026-09-01T00:00:00.000Z' });
    await service.requestPracticeCheck({ accessToken, studentRef, slot: 1,
      exerciseId, rawUrl: share('f') });
    let job = await service.claimPracticeCheckJob();
    let checked = await service.completePracticeCheck({ checkJobId: job.job_id,
      fingerprint: fingerprint('f'), questionCount: 2, qualityPassed: true,
      matchedExerciseId: exerciseId,
      typingWarning: { summary: 'Có dấu hiệu gõ.', evidence: ['Một câu cần xác minh.'] } });
    assert.equal(checked.status, 'needs_voice_confirmation');
    let rec = (await pool.query('SELECT practice_count FROM speaking_homework.doctor_recommendation')).rows[0];
    assert.equal(rec.practice_count, 0);
    await service.confirmPracticeVoice({ accessToken, studentRef, linkId: checked.linkId });
    await service.confirmPracticeVoice({ accessToken, studentRef, linkId: checked.linkId });
    rec = (await pool.query('SELECT practice_count, waiting FROM speaking_homework.doctor_recommendation')).rows[0];
    assert.equal(rec.practice_count, 1);
    assert.equal(rec.waiting, false);
    await assert.rejects(service.requestPracticeCheck({ accessToken, studentRef, slot: 2,
      exerciseId, rawUrl: share('f') }), { code: 'REUSED_CONVERSATION' });
    await service.requestPracticeCheck({ accessToken, studentRef, slot: 2,
      exerciseId, rawUrl: share('g') });
    job = await service.claimPracticeCheckJob();
    checked = await service.completePracticeCheck({ checkJobId: job.job_id,
      fingerprint: fingerprint('g'), questionCount: 2, qualityPassed: true,
      matchedExerciseId: exerciseId });
    assert.equal(checked.status, 'accepted');
    await service.completePracticeCheck({ checkJobId: job.job_id,
      fingerprint: fingerprint('g'), questionCount: 2, qualityPassed: true,
      matchedExerciseId: exerciseId });
    rec = (await pool.query('SELECT practice_count FROM speaking_homework.doctor_recommendation')).rows[0];
    assert.equal(rec.practice_count, 2);
  } finally { await db.close(); }
});

test('route nội bộ đòi secret; chưa bật cờ thì API cũ không đổi', async () => {
  const { db, pool } = await fixture();
  try {
    const config = { nodeEnv: 'test', authMode: 'legacy', legacyReviewToken: 'a-valid-test-token',
      allowedOrigins: new Set(['https://tranhoangduc90.github.io']), trustProxyHops: 0,
      speakingHomeworkEnabled: true, speakingHomeworkWorkerSecret: workerSecret,
      speakingHomeworkAccessSecret: 'test-student-access-secret-32-characters' };
    const app = createApp({ config, pool, speakingHomeworkPool: pool });
    const denied = await request(app).post('/api/speaking-homework/internal/checks/claim').send({});
    assert.equal(denied.status, 401);
    const opened = await request(app).post('/api/speaking-homework/open').send({ accessToken, studentRef });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.assignment.documentId, 'doc-A');
    const disabled = createApp({ config: { ...config, speakingHomeworkEnabled: false }, pool });
    const missing = await request(disabled).post('/api/speaking-homework/open').send({ accessToken, studentRef });
    assert.equal(missing.status, 404);
  } finally { await db.close(); }
});

test('CTA có Doc ID và lớp tải roster; tên đã nhớ mở lại theo Doc ID mà không cần lớp', async () => {
  const { db, pool } = await fixture();
  try {
    const app = createApp({ config: { nodeEnv: 'test', authMode: 'legacy',
      legacyReviewToken: 'a-valid-test-token', allowedOrigins: new Set(), trustProxyHops: 0,
      speakingHomeworkEnabled: true, speakingHomeworkWorkerSecret: workerSecret,
      speakingHomeworkAccessSecret: 'test-student-access-secret-32-characters' },
    pool, speakingHomeworkPool: pool });
    const entry = { documentId: 'doc-C', assignmentCode: '67-speaking-lam_ro' };
    const opened = await request(app).post('/api/speaking-homework/assignment/open')
      .send({ ...entry, classCode: 'IC2304' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.assignment.classCode, 'IC2304');
    assert.equal(opened.body.assignment.students.length, 2);
    assert.equal(opened.body.assignment.parts.length, 4);
    const wrongClass = await request(app).post('/api/speaking-homework/assignment/open')
      .send({ ...entry, classCode: 'IC9999' });
    assert.equal(wrongClass.status, 400);
    const session = await request(app).post('/api/speaking-homework/session/start')
      .send({ ...entry, studentRef, identityConfirmed: true });
    assert.equal(session.status, 200);
    const sessionAgain = await request(app).post('/api/speaking-homework/session/start')
      .send({ ...entry, studentRef, identityConfirmed: true });
    assert.equal(session.body.session.accessToken, sessionAgain.body.session.accessToken);
    const resumed = await request(app).post('/api/speaking-homework/open')
      .send({ accessToken: session.body.session.accessToken, studentRef });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.assignment.documentId, 'doc-C');
  } finally { await db.close(); }
});
