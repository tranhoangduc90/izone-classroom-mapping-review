import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createLearningService} from '../src/learning-service.js';
export function poolFrom(database, onQuery = () => {}) {
  const query = async (sql, params) => {
    onQuery(sql);
    const result = await database.query(sql, params);
    return {
      ...result,
      rowCount: result.rowCount ?? (result.rows.length || result.affectedRows || 0)
    };
  };
  return {
    query,
    async connect() {
      return {
        query,
        release() {}
      };
    }
  };
}

async function createV1Database(database = new PGlite()) {
  await database.exec(`
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      approved_by TEXT,
      approved_at TIMESTAMPTZ
    );
    CREATE TABLE mapping.student_mapping_review (
      id BIGSERIAL PRIMARY KEY,
      public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      erp_student_code TEXT,
      erp_student_name_snapshot TEXT NOT NULL,
      match_method TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'approved',
      reviewer_email TEXT,
      reviewer_note TEXT,
      decided_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      , UNIQUE (erp_course_class_id, erp_student_contact_id)
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
    );
    CREATE TABLE mapping.reviewer_class_access (
      reviewer_email TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      PRIMARY KEY (reviewer_email, erp_course_class_id)
    );
    CREATE TABLE mapping.reviewer_account (
      email TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE mapping.reviewer_class_assignment (
      reviewer_email TEXT NOT NULL,
      class_name TEXT NOT NULL
    );
    INSERT INTO mapping.classroom_course_mapping VALUES (2139, 'IC2139');
    INSERT INTO mapping.student_mapping_review (
      public_id, erp_course_class_id, erp_student_contact_id, erp_student_name_snapshot
    ) VALUES
      ('60000000-0000-4000-8000-000000000001', 2139, 9001, 'Học viên trùng tên'),
      ('60000000-0000-4000-8000-000000000002', 2139, 9002, 'Học viên trùng tên'),
      ('60000000-0000-4000-8000-000000000003', 2139, 9003, 'Học viên khác');
    INSERT INTO mapping.reviewer_class_access VALUES ('teacher@example.test', 2139);
    INSERT INTO mapping.reviewer_account VALUES ('teacher@example.test', 'active');
  `);
  const migration = await readFile(
    new URL('../ops/learning-migrations/202608290001_learning_platform_v1.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migration);
  return database;
}

export async function setupDatabase(connection=null) {
  const database = await createV1Database(connection||new PGlite());
  const migrationV2 = await readFile(
    new URL('../ops/learning-migrations/202609150001_learning_platform_v2.sql', import.meta.url),
    'utf8'
  );
  await database.exec(migrationV2);
  const attendanceOutboxMigration = await readFile(
    new URL('../ops/learning-migrations/202609160003_portal_attendance_outbox.sql', import.meta.url),
    'utf8'
  );
  await database.exec(attendanceOutboxMigration);
  const attendanceDashboardIndex = await readFile(
    new URL('../ops/learning-migrations/202609160006_portal_attendance_dashboard_index.sql', import.meta.url),
    'utf8'
  );
  await database.exec(attendanceDashboardIndex);
  const authorityMigration = await readFile(
    new URL('../ops/learning-migrations/202609160001_course_content_authority.sql', import.meta.url),
    'utf8'
  );
  await database.exec(authorityMigration);
  const progressAdminMigration = await readFile(
    new URL('../ops/learning-migrations/202609280001_progress_log_admin_scope.sql', import.meta.url),
    'utf8'
  );
  await database.exec(progressAdminMigration);
  const journeyMigration = await readFile(
    new URL('../ops/learning-migrations/202609150003_student_course_journey.sql', import.meta.url),
    'utf8'
  );
  await database.exec(journeyMigration);
  const speakingFeedbackMigration = await readFile(
    new URL('../ops/learning-migrations/202609240001_teacher_session_speaking_feedback.sql', import.meta.url),
    'utf8'
  );
  await database.exec(speakingFeedbackMigration);
  const answerReleaseMigration = await readFile(
    new URL('../ops/learning-migrations/202609280001_assignment_answer_release.sql', import.meta.url),
    'utf8'
  );
  await database.exec(answerReleaseMigration);
  const journeyPlanMigration = await readFile(
    new URL('../ops/learning-migrations/202609290001_teacher_confirmed_journey_plan.sql', import.meta.url),
    'utf8'
  );
  await database.exec(journeyPlanMigration);
  // Kho giả phải có cùng bảng đồng bộ và hạn nhận bài với runtime hiện hành.
  await database.exec(await readFile(new URL(
    '../ops/learning-migrations/202610060001_attendance_binding_and_submission_deadline.sql',
    import.meta.url
  ), 'utf8'));
  return { database, service: createLearningService({ pool: poolFrom(database) }) };
}
