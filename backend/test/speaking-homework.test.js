import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createSpeakingHomeworkService, parseSpeakingShareUrl } from '../src/speaking-homework.js';
import { createSpeakingAlerts } from '../src/speaking-alerts.js';
import { createSpeakingClassroomCopies, planSpeakingCopyCta,
  verifySpeakingCopyCta } from '../src/speaking-classroom-copies.js';
import { analyzeDoctorConversation, runSpeakingDoctorJob } from '../src/speaking-doctor-worker.js';

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
      classroom_user_id TEXT, status TEXT NOT NULL
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      erp_course_class_id BIGINT NOT NULL, erp_student_contact_id BIGINT NOT NULL,
      registration_status TEXT
    );
    CREATE TABLE mapping.reviewer_class_access (
      reviewer_email TEXT NOT NULL, erp_course_class_id BIGINT NOT NULL
    );
    CREATE TABLE mapping.reviewer_class_assignment (
      reviewer_email TEXT NOT NULL, class_name TEXT NOT NULL
    );
    INSERT INTO mapping.classroom_course_mapping VALUES (2304, 'IC2304', 'approved');
    INSERT INTO mapping.student_mapping_review VALUES
      ('${studentRef}', 2304, 1, 'Học viên A', 'classroom-A', 'approved'),
      ('${secondStudentRef}', 2304, 2, 'Học viên B', 'classroom-B', 'approved');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES (2304, 1, 'on_going'), (2304, 2, 'on_going');
  `);
  const migration = await readFile(new URL('../ops/migrations/202609270001_speaking_homework_candidate.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(`ALTER TABLE speaking_homework.assignment_document
    ADD COLUMN classroom_submission_id TEXT,
    ADD COLUMN cta_verified_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX speaking_document_student_once
    ON speaking_homework.assignment_document(assignment_id, student_ref)
    WHERE student_ref IS NOT NULL;
    CREATE UNIQUE INDEX speaking_document_classroom_submission_once
    ON speaking_homework.assignment_document(assignment_id, classroom_submission_id)
    WHERE classroom_submission_id IS NOT NULL;`);
  const pool = poolFrom(db);
  const first = await pool.query(`INSERT INTO speaking_homework.assignment
    (class_id, course_id, course_work_id, assignment_code, doctor_course_key, title, status)
    VALUES (2304, 'course-2304', 'lesson-2', '67-speaking-lesson-2', '67', 'Homework Lesson 2', 'open') RETURNING id`);
  const second = await pool.query(`INSERT INTO speaking_homework.assignment
    (class_id, course_id, course_work_id, assignment_code, doctor_course_key, title, status)
    VALUES (2304, 'course-2304', 'lesson-3', '67-speaking-lam_ro', NULL, 'Homework Lesson 3', 'open') RETURNING id`);
  const doctorMigration = await readFile(new URL('../ops/migrations/202609290001_speaking_doctor_lesson3.sql', import.meta.url), 'utf8');
  await db.exec(doctorMigration);
  assert.equal((await pool.query('SELECT doctor_course_key FROM speaking_homework.assignment WHERE id = $1',
    [second.rows[0].id])).rows[0].doctor_course_key, '67');
  for (const [assignmentId, parts] of [
    [first.rows[0].id, [['paraphrase', 5], ['speaking', 3]]],
    [second.rows[0].id, [['clarify_1', 3], ['clarify_2', 2], ['clarify_3', 2], ['freestyle', 2]]]
  ]) {
    for (let i = 0; i < parts.length; i++) {
      await pool.query(`INSERT INTO speaking_homework.assignment_part
        (assignment_id, part_key, display_title, practice_url, min_questions, position)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [assignmentId, parts[i][0], parts[i][0], 'https://example.test/practice', parts[i][1], i + 1]);
    }
  }
  await pool.query('INSERT INTO speaking_homework.assignment_document (assignment_id, document_id, student_ref) VALUES ($1, $2, $3)', [first.rows[0].id, 'doc-A', studentRef]);
  await pool.query('INSERT INTO speaking_homework.assignment_document (assignment_id, document_id, student_ref) VALUES ($1, $2, $3)', [second.rows[0].id, 'doc-B', secondStudentRef]);
  await pool.query('INSERT INTO speaking_homework.assignment_document (assignment_id, document_id, student_ref) VALUES ($1, $2, $3)', [second.rows[0].id, 'doc-C', studentRef]);
  await pool.query('INSERT INTO speaking_homework.assignment_document (assignment_id, document_id) VALUES ($1, $2)', [second.rows[0].id, 'template-doc']);
  await pool.query(`UPDATE speaking_homework.assignment_document
    SET cta_verified_at = now() WHERE student_ref IS NOT NULL`);
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
    questionCount: count, qualityPassed: true,
    evidence: part === 'clarify_1' ? { coveredCategories: ['noun', 'verb', 'adjective'] } : {} });
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

test('bản sao Classroom cần CTA đã đọc lại; học viên cùng lớp có thể mở bằng Doc ID', async () => {
  const { db, pool } = await fixture();
  const service = createSpeakingHomeworkService({ pool,
    accessSecret: 'test-student-access-secret-32-characters' });
  const copies = createSpeakingClassroomCopies({ pool });
  const copy = { id: 'submission-new', userId: 'classroom-A', documentId: 'student-doc-new' };
  const scope = { courseId: 'course-2304', courseWorkId: 'lesson-3', submissions: [copy] };
  const document = url => ({ documentId: copy.documentId, revisionId: 'rev-1', tabs: [{
    tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [{
      paragraph: { elements: [{ startIndex: 70, endIndex: 107,
        textRun: { content: 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING',
          textStyle: { link: { url }, underline: false, foregroundColor: {
            color: { rgbColor: { red: 1, green: 1, blue: 1 } }
          } } } }] }
    }] } }
  }] });
  try {
    await pool.query("DELETE FROM speaking_homework.assignment_document WHERE document_id = 'doc-C'");
    const bound = await copies.sync(scope);
    assert.equal(bound.bound, 1);
    assert.equal(bound.pending.length, 1);
    assert.equal((await copies.sync(scope)).pending.length, 1);
    await assert.rejects(service.openAssignment({ documentId: copy.documentId,
      assignmentCode: '67-speaking-lam_ro' }), { code: 'ASSIGNMENT_NOT_FOUND' });
    const plan = await copies.plan({ documentId: copy.documentId,
      document: document('https://example.test/old') });
    assert.equal(plan.status, 'write');
    assert.equal(plan.requests[0].updateTextStyle.range.tabId, 't.0');
    assert.equal(plan.requests[0].updateTextStyle.range.startIndex, 70);
    assert.match(plan.url, /documentId=student-doc-new/);
    assert.equal(verifySpeakingCopyCta({ document: document(plan.url),
      documentId: copy.documentId, classCode: 'IC2304',
      assignmentCode: '67-speaking-lam_ro' }), true);
    await assert.rejects(copies.verify({ documentId: copy.documentId,
      document: document('https://example.test/old') }), { code: 'DOC_CTA_NOT_VERIFIED' });
    await copies.verify({ documentId: copy.documentId, document: document(plan.url) });
    assert.equal((await copies.sync(scope)).pending.length, 0);
    const opened = await service.openAssignment({ documentId: copy.documentId,
      assignmentCode: '67-speaking-lam_ro', classCode: 'IC2304' });
    assert.equal(opened.students.length, 2);
    const otherStudent = await service.startSession({ documentId: copy.documentId,
      assignmentCode: '67-speaking-lam_ro', studentRef: secondStudentRef });
    assert.equal(otherStudent.studentRef, secondStudentRef);
    await service.open({ accessToken: otherStudent.accessToken, studentRef: secondStudentRef });
    const grant = await pool.query(`SELECT document_id FROM speaking_homework.access_grant
      WHERE document_id = $1 AND student_ref = $2`, [copy.documentId, secondStudentRef]);
    assert.equal(grant.rows[0].document_id, copy.documentId);
    await checkAccepted(service, otherStudent.accessToken, secondStudentRef, 'clarify_1', 'l', 3);
    await checkAccepted(service, otherStudent.accessToken, secondStudentRef, 'clarify_2', 'm', 2);
    await checkAccepted(service, otherStudent.accessToken, secondStudentRef, 'clarify_3', 'n', 2);
    await checkAccepted(service, otherStudent.accessToken, secondStudentRef, 'freestyle', 'o', 2);
    await service.finish({ accessToken: otherStudent.accessToken, studentRef: secondStudentRef });
    const writeJob = await service.claimOutboxJob('write_doc');
    assert.equal(writeJob.document_id, copy.documentId);
    assert.equal(writeJob.student_ref, secondStudentRef);
    await assert.rejects(copies.sync({ ...scope, submissions: [{ ...copy,
      userId: 'classroom-B' }] }), { code: 'DOCUMENT_BINDING_CONFLICT' });
    await assert.rejects(copies.sync({ ...scope, submissions: [{ ...copy,
      documentId: 'different-doc' }] }));
  } finally { await db.close(); }
});

test('CTA thiếu hoặc trùng không được đánh dấu đã cập nhật', () => {
  const input = { documentId: 'doc-1', classCode: 'IC2304',
    assignmentCode: '67-speaking-lam_ro' };
  const base = { documentId: 'doc-1', revisionId: 'rev-1', tabs: [{
    tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [] } }
  }] };
  assert.throws(() => planSpeakingCopyCta({ ...input, document: base }),
    /DOC_CTA_AMBIGUOUS/);
  assert.equal(verifySpeakingCopyCta({ ...input, document: base }), false);
});

test('CTA đã có đúng link nhưng đổi sang xanh gạch dưới phải được sửa về trắng', () => {
  const input = { documentId: 'doc-1', classCode: 'IC2304',
    assignmentCode: '67-speaking-lam_ro' };
  const url = 'https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/lesson-3.html?documentId=doc-1&class=IC2304&assignmentCode=67-speaking-lam_ro';
  const document = { documentId: 'doc-1', revisionId: 'rev-1', tabs: [{
    tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [{
      paragraph: { elements: [{ startIndex: 70, endIndex: 104,
        textRun: { content: 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING', textStyle: {
          link: { url }, underline: true, foregroundColor: {
            color: { rgbColor: { red: 0.06666667, green: 0.33333334, blue: 0.8 } }
          }
        } } }] }
    }] } }
  }] };
  assert.equal(verifySpeakingCopyCta({ ...input, document }), false);
  const plan = planSpeakingCopyCta({ ...input, document });
  assert.equal(plan.status, 'write');
  const update = plan.requests[0].updateTextStyle;
  assert.equal(update.textStyle.underline, false);
  assert.deepEqual(update.textStyle.foregroundColor.color.rgbColor,
    { red: 1, green: 1, blue: 1 });
  assert.equal(update.fields, 'link,foregroundColor,underline');
});

test('lịch Classroom chỉ gom TURNED_IN thiếu bài Speaking và gửi một lần', async () => {
  const { db, pool } = await fixture();
  const alerts = createSpeakingAlerts({ pool });
  const scope = { courseId: 'course-2304', courseWorkId: 'lesson-3' };
  const returned = { id: 'sub-A', userId: 'classroom-A', state: 'RETURNED',
    alternateLink: 'https://classroom.google.com/c/example/a/example/submissions/sub-A' };
  const turnedIn = { id: 'sub-B', userId: 'classroom-B', state: 'TURNED_IN',
    alternateLink: 'https://classroom.google.com/c/example/a/example/submissions/sub-B' };
  try {
    assert.equal((await alerts.scan({ ...scope, submissions: [returned, turnedIn] })).pending, 1);
    const batch = await alerts.claim(scope);
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0].studentName, 'Học viên B');
    assert.equal(await alerts.claim(scope), null);
    assert.equal((await alerts.acknowledge({ batchId: batch.batchId })).sent, 1);
    assert.equal((await alerts.scan({ ...scope, submissions: [returned, turnedIn] })).pending, 0);
    assert.equal(await alerts.claim(scope), null);
    assert.equal((await alerts.scan({ ...scope,
      submissions: [{ ...returned, state: 'TURNED_IN' }, turnedIn] })).pending, 1);
    assert.equal((await alerts.scan({ ...scope, submissions: [returned, turnedIn] })).pending, 0);
    assert.equal(await alerts.claim(scope), null);
  } finally { await db.close(); }
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

test('Lesson 3 phân tích bốn link, ghi danh sách Bác sĩ AI đúng học viên và không tăng khi retry', async () => {
  const { db, pool, service } = await fixture();
  try {
    const exercise = await pool.query(`INSERT INTO speaking_homework.doctor_exercise
      (course_key, source_record_id, title, exercise_url)
      VALUES ('67', 's-v', 'Hòa hợp Chủ ngữ - Vị ngữ (S-V)', 'https://example.test/s-v') RETURNING id`);
    const messagesByUrl = new Map();
    const lessonParts = ['clarify_1', 'clarify_2', 'clarify_3', 'freestyle'];
    for (let index = 0; index < lessonParts.length; index++) {
      const letter = 'cdef'[index];
      const messages = [
        { role: 'assistant', text: `Hỏi câu ${index + 1}` },
        { role: 'user', text: `I goes to school ${index + 1}` },
        { role: 'assistant', text: 'Chủ ngữ I đi với go, không dùng goes.' },
      ];
      const fp = crypto.createHash('sha256').update(messages.map(message =>
        `${message.role}\u0000${message.text.trim()}`).join('\u0001')).digest('hex');
      await checkAccepted(service, secondToken, secondStudentRef, lessonParts[index], letter,
        lessonParts[index] === 'clarify_1' ? 3 : 2, fp);
      messagesByUrl.set(share(letter), messages);
    }
    const receipt = await service.finish({ accessToken: secondToken, studentRef: secondStudentRef });
    const job = await service.claimOutboxJob('doctor_analyze');
    assert.equal(job.receipt_id, receipt.id);
    const result = await runSpeakingDoctorJob(service, job, {
      readShare: async url => ({ messages: messagesByUrl.get(url) }),
      analyze: async (part, _conversation, catalog) => part === 'clarify_1' || part === 'freestyle'
        ? [{ part, exerciseId: catalog.exercises[0].id, evidenceMessage: 3,
          evidenceQuote: 'Chủ ngữ I đi với go', reason: 'Lỗi hòa hợp chủ ngữ và động từ.' }]
        : [],
    });
    assert.equal(result.exerciseCount, 1);
    const rows = await pool.query(`SELECT r.recommendation_count, r.waiting, r.student_ref,
        a.matches, o.status
      FROM speaking_homework.doctor_recommendation r
      JOIN speaking_homework.doctor_analysis a ON a.receipt_id = $1
      JOIN speaking_homework.outbox o ON o.receipt_id = a.receipt_id AND o.kind = 'doctor_analyze'`,
    [receipt.id]);
    assert.equal(rows.rows[0].recommendation_count, 1);
    assert.equal(rows.rows[0].waiting, true);
    assert.equal(rows.rows[0].student_ref, secondStudentRef);
    assert.equal(rows.rows[0].matches.length, 2);
    assert.equal(rows.rows[0].status, 'done');
    assert.equal((await service.listDoctor({ accessToken: secondToken,
      studentRef: secondStudentRef })).neededCount, 1);
    assert.equal((await service.completeDoctorJob({ jobId: job.job_id,
      catalogDigest: 'x', matches: [] })).status, 'done');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM speaking_homework.doctor_event')).rows[0].count, 1);
    assert.equal(exercise.rows[0].id, rows.rows[0].matches[0].exerciseId);
  } finally { await db.close(); }
});

test('danh mục đổi giữa lúc AI đọc và lúc ghi thì rollback, kết quả không có đề xuất cũng được lưu', async () => {
  const { db, pool, service } = await fixture();
  try {
    await pool.query(`INSERT INTO speaking_homework.doctor_exercise
      (course_key, source_record_id, title, exercise_url)
      VALUES ('67', 'old', 'Bài cũ', 'https://example.test/old')`);
    for (const [part, letter, count] of [
      ['clarify_1', 'g', 3], ['clarify_2', 'h', 2], ['clarify_3', 'i', 2], ['freestyle', 'j', 2]
    ]) await checkAccepted(service, secondToken, secondStudentRef, part, letter, count);
    const receipt = await service.finish({ accessToken: secondToken, studentRef: secondStudentRef });
    const job = await service.claimOutboxJob('doctor_analyze');
    const before = await service.getDoctorCatalog(receipt.id);
    await pool.query(`INSERT INTO speaking_homework.doctor_exercise
      (course_key, source_record_id, title, exercise_url)
      VALUES ('67', 'new', 'Bài mới', 'https://example.test/new')`);
    await assert.rejects(service.completeDoctorJob({ jobId: job.job_id,
      catalogDigest: before.digest, matches: [] }), { code: 'DOCTOR_CATALOG_CHANGED' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM speaking_homework.doctor_analysis')).rows[0].count, 0);
    const after = await service.getDoctorCatalog(receipt.id);
    const completed = await service.completeDoctorJob({ jobId: job.job_id,
      catalogDigest: after.digest, matches: [] });
    assert.equal(completed.exerciseCount, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM speaking_homework.doctor_analysis')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('migration bổ sung đúng một việc Bác sĩ AI cho biên nhận cũ chưa có việc', async () => {
  const { db, pool, service } = await fixture();
  try {
    for (const [part, letter, count] of [
      ['clarify_1', 'k', 3], ['clarify_2', 'l', 2], ['clarify_3', 'm', 2], ['freestyle', 'n', 2]
    ]) await checkAccepted(service, secondToken, secondStudentRef, part, letter, count);
    const receipt = await service.finish({ accessToken: secondToken, studentRef: secondStudentRef });
    await pool.query(`DELETE FROM speaking_homework.outbox
      WHERE receipt_id = $1 AND kind = 'doctor_analyze'`, [receipt.id]);
    const migration = await readFile(new URL('../ops/migrations/202609290001_speaking_doctor_lesson3.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const jobs = await pool.query(`SELECT count(*)::int AS count FROM speaking_homework.outbox
      WHERE receipt_id = $1 AND kind = 'doctor_analyze'`, [receipt.id]);
    assert.equal(jobs.rows[0].count, 1);
  } finally { await db.close(); }
});

test('migration sửa ID nội bộ IC2304 chỉ bật Bác sĩ AI sau khi đối chiếu lớp đã duyệt', async () => {
  const { db, pool } = await fixture();
  try {
    await pool.query(`UPDATE speaking_homework.assignment
      SET class_id = 1293, doctor_course_key = NULL
      WHERE assignment_code = '67-speaking-lam_ro'`);
    const migration = await readFile(new URL(
      '../ops/migrations/202609290002_speaking_doctor_ic2304_class_id.sql', import.meta.url), 'utf8');
    await assert.rejects(db.exec(migration), /SPEAKING_DOCTOR_CLASS_MAPPING_MISMATCH/);
    assert.equal((await pool.query(`SELECT doctor_course_key FROM speaking_homework.assignment
      WHERE assignment_code = '67-speaking-lam_ro'`)).rows[0].doctor_course_key, null);
    await pool.query(`UPDATE mapping.classroom_course_mapping
      SET erp_course_class_id = 1293 WHERE erp_class_name_snapshot = 'IC2304'`);
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await pool.query(`SELECT doctor_course_key FROM speaking_homework.assignment
      WHERE assignment_code = '67-speaking-lam_ro'`)).rows[0].doctor_course_key, '67');
  } finally { await db.close(); }
});

test('AI Bác sĩ chỉ nhận ID trong danh mục và trích dẫn đúng lời góp ý', async () => {
  const catalog = { exercises: [{ id: '60000000-0000-4000-8000-000000000009', title: 'S-V' }] };
  const conversation = { messages: [
    { role: 'user', text: 'I goes to school' },
    { role: 'assistant', text: 'Chủ ngữ I đi với go, không dùng goes.' },
  ] };
  const call = async () => ({ ok: true, async json() { return { text: JSON.stringify({ confidence: 0.9,
    matches: [{ exerciseNumber: 1, evidenceMessage: 2,
      evidenceQuote: 'Chủ ngữ I đi với go', reason: 'S-V' }] }) }; } });
  assert.equal((await analyzeDoctorConversation('freestyle', conversation, catalog,
    'https://example.test/ai', call)).length, 1);
  const forged = async () => ({ ok: true, async json() { return { text: JSON.stringify({ confidence: 0.9,
    matches: [{ exerciseNumber: 1, evidenceMessage: 1,
      evidenceQuote: 'Chủ ngữ I đi với go', reason: 'S-V' }] }) }; } });
  await assert.rejects(analyzeDoctorConversation('freestyle', conversation, catalog,
    'https://example.test/ai', forged), /DOCTOR_AI_EVIDENCE_INVALID/);
  const markdownCall = async () => ({ ok: true, async json() { return { text: JSON.stringify({ confidence: 0.9,
    matches: [{ exerciseNumber: 1, evidenceMessage: 2,
      evidenceQuote: 'Chủ ngữ I đi với go, không dùng goes', reason: 'S-V' }] }) }; } });
  const markdownConversation = { messages: [conversation.messages[0],
    { role: 'assistant', text: 'Chủ ngữ **I** đi với **go**, không dùng goes.' }] };
  const adapted = await analyzeDoctorConversation('freestyle', markdownConversation, catalog,
    'https://example.test/ai', markdownCall);
  assert.ok(markdownConversation.messages[1].text.includes(adapted[0].evidenceQuote));
});

test('hội thoại Share đổi sau lúc xác nhận thì Bác sĩ AI không ghi sai bài', async () => {
  let failed = false;
  let completed = false;
  const service = {
    async getDoctorCatalog() { return { exercises: [], digest: 'a'.repeat(64) }; },
    async completeDoctorJob() { completed = true; },
    async failOutboxJob() { failed = true; },
  };
  const result = await runSpeakingDoctorJob(service,
    { job_id: 'job-1', receipt_id: 'receipt-1',
      links: { freestyle: { url: share('z'), fingerprint: 'b'.repeat(64) } } },
    { readShare: async () => ({ messages: [
      { role: 'assistant', text: 'Question' }, { role: 'user', text: 'Answer' }
    ] }), analyze: async () => [] });
  assert.equal(result.status, 'retry');
  assert.equal(failed, true);
  assert.equal(completed, false);
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
    await checkAccepted(service, secondToken, secondStudentRef, 'freestyle', 'k', 2);
    const receipt = await service.finish({ accessToken: secondToken,
      studentRef: secondStudentRef });
    assert.ok(receipt.id);
    const jobs = await db.query('SELECT kind FROM speaking_homework.outbox WHERE receipt_id = $1 ORDER BY kind', [receipt.id]);
    assert.deepEqual(jobs.rows.map(row => row.kind), ['doctor_analyze', 'grade_speaking', 'write_doc']);
  } finally { await db.close(); }
});

test('Lesson 3 tổng hợp kết quả AI cho giảng viên và retry chấm không ghi trùng', async () => {
  const { db, pool, service } = await fixture();
  try {
    await checkAccepted(service, secondToken, secondStudentRef, 'clarify_1', 'h', 3);
    await checkAccepted(service, secondToken, secondStudentRef, 'clarify_2', 'i', 2);
    await checkAccepted(service, secondToken, secondStudentRef, 'clarify_3', 'j', 2);
    await checkAccepted(service, secondToken, secondStudentRef, 'freestyle', 'k', 2);
    const receipt = await service.finish({ accessToken: secondToken, studentRef: secondStudentRef });
    const job = await service.claimOutboxJob('grade_speaking');
    assert.equal(job.kind, 'grade_speaking');
    await service.completeGradeJob(job.job_id);
    await service.completeGradeJob(job.job_id);
    const grades = await pool.query('SELECT * FROM speaking_homework.grade_result WHERE receipt_id = $1', [receipt.id]);
    assert.equal(grades.rows.length, 1);
    assert.equal(grades.rows[0].total_questions, 9);
    await pool.query('INSERT INTO mapping.reviewer_class_access VALUES ($1, $2)', ['teacher@example.test', 2304]);
    const teacher = await service.getTeacherReceipt({ receiptId: receipt.id, email: 'teacher@example.test' });
    assert.equal(teacher.grade_summary.totalQuestions, 9);
    assert.equal(teacher.grade_summary.status, 'meets_requirements');
  } finally { await db.close(); }
});

test('link Share không mở được được từ chối bền và có thể gửi link mới', async () => {
  const { db, service } = await fixture();
  try {
    await service.requestCheck({ accessToken, studentRef, part: 'paraphrase', rawUrl: share('a') });
    const job = await service.claimCheckJob();
    const rejected = await service.rejectCheckJob({ checkJobId: job.job_id, checkCode: 'SHARE_UNAVAILABLE' });
    assert.equal(rejected.status, 'rejected');
    const opened = await service.open({ accessToken, studentRef });
    assert.equal(opened.links[0].check_code, 'SHARE_UNAVAILABLE');
    const next = await service.requestCheck({ accessToken, studentRef, part: 'paraphrase', rawUrl: share('b') });
    assert.equal(next.revision, 2);
  } finally { await db.close(); }
});

test('Làm rõ cấp 1 phải có cả danh từ, động từ và tính từ', async () => {
  const { db, service } = await fixture();
  try {
    await service.requestCheck({ accessToken: secondToken, studentRef: secondStudentRef,
      part: 'clarify_1', rawUrl: share('l') });
    const job = await service.claimCheckJob();
    const result = await service.completeCheck({ checkJobId: job.job_id,
      fingerprint: fingerprint('l'), questionCount: 3, qualityPassed: true,
      evidence: { coveredCategories: ['noun', 'verb'] } });
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'MISSING_CLARIFICATION_CATEGORY');
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
    const deniedCopy = await request(app)
      .post('/api/speaking-homework/internal/classroom-copies/sync')
      .send({ courseId: '1', courseWorkId: '2', snapshotComplete: true, submissions: [] });
    assert.equal(deniedCopy.status, 401);
    const incompleteCopy = await request(app)
      .post('/api/speaking-homework/internal/classroom-copies/sync')
      .set('x-speaking-worker-secret', workerSecret)
      .send({ courseId: '1', courseWorkId: '2', snapshotComplete: false, submissions: [] });
    assert.equal(incompleteCopy.status, 400);
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
    const templateSession = await request(app).post('/api/speaking-homework/session/start')
      .send({ documentId: 'template-doc', assignmentCode: '67-speaking-lam_ro',
        studentRef, identityConfirmed: true });
    assert.equal(templateSession.status, 404);
    assert.equal(templateSession.body.error, 'ASSIGNMENT_NOT_FOUND');
  } finally { await db.close(); }
});
