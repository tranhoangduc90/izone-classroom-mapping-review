import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { listReviewsSql, writeDecisionSql } from '../src/sql.js';

// Dựng đúng phần schema production có trước migration, hoàn toàn trong RAM của tiến trình test.
const schemaBeforeMigration = `
  CREATE SCHEMA mapping;

  CREATE TABLE mapping.classroom_course_mapping (
    id BIGSERIAL PRIMARY KEY,
    erp_course_class_id BIGINT NOT NULL UNIQUE,
    erp_class_name_snapshot TEXT NOT NULL,
    classroom_course_id TEXT UNIQUE
  );

  CREATE TABLE mapping.classroom_roster_snapshot (
    id BIGSERIAL PRIMARY KEY,
    classroom_course_id TEXT NOT NULL,
    classroom_user_id TEXT NOT NULL,
    classroom_name_snapshot TEXT,
    classroom_email_snapshot TEXT,
    roster_state TEXT NOT NULL DEFAULT 'active',
    UNIQUE (classroom_course_id, classroom_user_id)
  );

  CREATE TABLE mapping.student_identity_mapping (
    id BIGSERIAL PRIMARY KEY,
    erp_student_contact_id BIGINT NOT NULL UNIQUE,
    google_user_id TEXT NOT NULL UNIQUE,
    google_email_snapshot TEXT,
    erp_name_snapshot TEXT,
    google_name_snapshot TEXT,
    status TEXT NOT NULL DEFAULT 'approved',
    match_method TEXT NOT NULL,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE mapping.student_mapping_review (
    id BIGSERIAL PRIMARY KEY,
    erp_course_class_id BIGINT NOT NULL,
    erp_student_contact_id BIGINT NOT NULL,
    erp_student_code TEXT,
    erp_student_name_snapshot TEXT NOT NULL,
    erp_student_email_snapshot TEXT,
    classroom_course_id TEXT,
    classroom_user_id TEXT,
    classroom_name_snapshot TEXT,
    classroom_email_snapshot TEXT,
    ai_score NUMERIC(5, 4),
    ai_reason TEXT,
    match_method TEXT NOT NULL DEFAULT 'pending',
    status TEXT NOT NULL DEFAULT 'pending_review',
    reviewer_email TEXT,
    reviewer_note TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (erp_course_class_id, erp_student_contact_id)
  );

  CREATE TABLE mapping.mapping_decision_event (
    id BIGSERIAL PRIMARY KEY,
    review_id BIGINT NOT NULL REFERENCES mapping.student_mapping_review(id),
    decision TEXT NOT NULL,
    selected_google_user_id TEXT,
    reviewer_email TEXT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

test('migration và hai câu SQL chính chạy được trên PostgreSQL trong RAM', async () => {
  const database = new PGlite();
  await database.exec(schemaBeforeMigration);

  // Migration nhận schema cũ, bổ sung UUID cùng bảng phân quyền, rồi phải chạy lại an toàn.
  const migrationUrl = new URL('../../docs/migrations/2026-08-06-independent-api-auth.sql', import.meta.url);
  const migrationSql = await readFile(migrationUrl, 'utf8');
  await database.exec(migrationSql);
  await database.exec(migrationSql);

  await database.exec(`
    INSERT INTO mapping.classroom_course_mapping (
      erp_course_class_id, erp_class_name_snapshot, classroom_course_id
    ) VALUES (2172, 'IC2172', 'classroom-course-2172');

    INSERT INTO mapping.classroom_roster_snapshot (
      classroom_course_id, classroom_user_id, classroom_name_snapshot,
      classroom_email_snapshot, roster_state
    ) VALUES (
      'classroom-course-2172', 'google-user-1', 'Học viên Google',
      'student@example.com', 'active'
    );

    INSERT INTO mapping.student_mapping_review (
      erp_course_class_id, erp_student_contact_id, erp_student_name_snapshot,
      classroom_course_id, classroom_user_id, classroom_name_snapshot,
      classroom_email_snapshot, ai_score, ai_reason
    ) VALUES (
      2172, 9001, 'Học viên ERP', 'classroom-course-2172', 'google-user-1',
      'Học viên Google', 'student@example.com', 0.95, 'Tên gần trùng.'
    );

    INSERT INTO mapping.reviewer_account (
      email, display_name, role, can_access_all_classes
    ) VALUES ('teacher@gmail.com', 'Giảng viên', 'teacher', false);

    INSERT INTO mapping.reviewer_class_access (reviewer_email, erp_course_class_id)
    VALUES ('teacher@gmail.com', 2172);
  `);

  const listResult = await database.query(listReviewsSql, [
    null,
    'pending_review',
    'teacher@gmail.com',
    false
  ]);
  assert.equal(listResult.rows[0].response.items.length, 1);
  const reviewId = listResult.rows[0].response.items[0].id;
  assert.match(reviewId, /^[0-9a-f-]{36}$/);

  const decisionResult = await database.query(writeDecisionSql, [
    reviewId,
    'approve',
    null,
    'Đã kiểm tra tại lớp.',
    'teacher@gmail.com',
    false
  ]);
  assert.equal(decisionResult.rows[0].response.ok, true);
  assert.equal(decisionResult.rows[0].response.status, 'approved');

  const auditResult = await database.query(`
    SELECT
      (SELECT count(*)::int FROM mapping.mapping_decision_event) AS event_count,
      (SELECT count(*)::int FROM mapping.student_identity_mapping WHERE status = 'approved') AS mapping_count
  `);
  assert.equal(auditResult.rows[0].event_count, 1);
  assert.equal(auditResult.rows[0].mapping_count, 1);

  await database.close();
});
