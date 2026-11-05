import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createSpeakingHomeworkService} from '../legacy/src/speaking-homework.js';
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

async function fixture({progressDocsEnabled=false,journal}={}) {
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
      ,source_state TEXT NOT NULL DEFAULT 'active'
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
  await db.exec(`CREATE TABLE speaking_homework.main_conversation_snapshot(link_id uuid PRIMARY KEY,original_fingerprint text,fingerprint text,messages jsonb,source text DEFAULT 'accepted',recovery_job_id uuid);
    CREATE TABLE speaking_homework.practice_conversation_snapshot(LIKE speaking_homework.main_conversation_snapshot INCLUDING ALL);`);
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
  const lesson4Migration = await readFile(new URL('../ops/migrations/202609290003_speaking_lesson4_practice.sql', import.meta.url), 'utf8');
  await db.exec(lesson4Migration);
  await db.exec("ALTER TABLE speaking_homework.practice_link ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}'::jsonb;");
  const directMigration = await readFile(new URL('../ops/migrations/202609300001_speaking_direct_homework.sql', import.meta.url), 'utf8');
  await db.exec(directMigration);
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
  if(progressDocsEnabled){
    await db.exec("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='speaking_homework_api') THEN CREATE ROLE speaking_homework_api; END IF; END $$;");
    await db.exec(await readFile(new URL('../ops/migrations/202610250930_speaking_progress_docs.sql',import.meta.url),'utf8'));
  }
  return { db, pool, service: createSpeakingHomeworkService({ pool,progressDocsEnabled,journal }) };
}

export {fixture,studentRef,secondStudentRef,accessToken,secondToken,share,fingerprint};
