import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resolveDeploymentProfile } from '../src/deployment-profile.js';
import { listTermTestTeacherOptionsLegacySql, listTermTestTeacherResultsLegacySql } from '../src/sql.js';

test('hai profile production giữ riêng cổng lớp và đường cập nhật', () => {
  const k56 = resolveDeploymentProfile('k56-ic2264');
  const k67 = resolveDeploymentProfile('k67');
  assert.equal(k56.family, 'k56');
  assert.equal(k56.teacherOptionsMode, 'legacy-access');
  assert.equal(k56.writingNotifierEnabled, true);
  assert.equal(k67.family, 'k67');
  assert.equal(k67.teacherOptionsMode, 'portal-metadata');
  assert.equal(k67.writingNotifierEnabled, true);
  assert.throws(() => resolveDeploymentProfile('unknown'));
});

test('K56 dùng schema lớp live: giảng viên chỉ xem lớp được giao, admin thấy cả lớp khác', async () => {
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA mapping;
    CREATE SCHEMA assessment;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE mapping.reviewer_class_access (
      reviewer_email TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL
    );
    CREATE TABLE mapping.reviewer_class_assignment (
      reviewer_email TEXT NOT NULL,
      class_name TEXT NOT NULL
    );
    CREATE TABLE mapping.reviewer_account (
      email TEXT PRIMARY KEY,
      display_name TEXT,
      role TEXT NOT NULL,
      can_access_all_classes BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      google_subject TEXT,
      last_login_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );
    CREATE TABLE assessment.test_definition (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      version INTEGER NOT NULL,
      is_active BOOLEAN NOT NULL
    );
    CREATE TABLE mapping.student_mapping_review (
      public_id UUID NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      erp_student_name_snapshot TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE assessment.term_test_roster (
      test_slug TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      student_ref UUID NOT NULL,
      student_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE assessment.mini_test_result (
      id UUID,
      test_slug TEXT,
      erp_course_class_id BIGINT,
      erp_student_contact_id BIGINT,
      student_name_snapshot TEXT,
      updated_at TIMESTAMPTZ,
      result JSONB,
      created_at TIMESTAMPTZ
    );
    CREATE TABLE assessment.term_test_temporary_student (
      test_slug TEXT,
      erp_course_class_id BIGINT,
      temporary_student_id BIGINT,
      student_ref UUID,
      student_name_snapshot TEXT,
      active BOOLEAN
    );
    CREATE TABLE assessment.term_test_attempt (
      id UUID,
      test_slug TEXT,
      erp_course_class_id BIGINT,
      erp_student_contact_id BIGINT,
      completed_at TIMESTAMPTZ,
      combined_result JSONB,
      writing_submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ
    );
    CREATE TABLE assessment.term_test_writing_grading_final (
      attempt_id UUID,
      status TEXT,
      task_1_score NUMERIC,
      task_2_score NUMERIC,
      writing_score NUMERIC
    );
    CREATE TABLE assessment.term_test_writing_grading_run (
      attempt_id UUID,
      task_number SMALLINT,
      status TEXT,
      grading_version INTEGER,
      updated_at TIMESTAMPTZ
    );
    INSERT INTO mapping.classroom_course_mapping VALUES
      (2264, 'IC2264'), (2265, 'IC2265');
    INSERT INTO mapping.reviewer_class_access VALUES
      ('teacher@example.test', 2264);
    INSERT INTO mapping.reviewer_account (email, display_name, role) VALUES
      ('teacher@example.test', 'Giảng viên mẫu', 'teacher'),
      ('admin@example.test', 'Quản trị viên mẫu', 'admin');
    INSERT INTO assessment.test_definition VALUES
      ('term-test-2-k56', 'Term Test 2 khóa 56', 1, true),
      ('term-test-2', 'Term Test 2', 1, true);
    INSERT INTO assessment.term_test_roster VALUES
      ('term-test-2-k56', 2264, 9001, '00000000-0000-4000-8000-000000000001', 'Học viên mẫu A'),
      ('term-test-2-k56', 2265, 9002, '00000000-0000-4000-8000-000000000002', 'Học viên mẫu B');
    ALTER TABLE assessment.term_test_roster
      ADD COLUMN is_eligible BOOLEAN NOT NULL DEFAULT true;
    UPDATE assessment.term_test_roster SET is_eligible = false
      WHERE erp_course_class_id = 2265;
  `);

  const teacher = await database.query(listTermTestTeacherOptionsLegacySql, ['teacher@example.test', false]);
  assert.deepEqual(teacher.rows[0].response.classes.map(item => item.name), ['IC2264']);
  assert.equal(teacher.rows[0].response.classes[0].accessMode, 'assigned_teacher');

  const admin = await database.query(listTermTestTeacherOptionsLegacySql, ['teacher@example.test', true]);
  assert.equal(admin.rows[0].response.classes.length, 2);
  const otherClass = admin.rows[0].response.classes.find(item => item.name === 'IC2265');
  assert.equal(otherClass.accessMode, 'admin_override');
  assert.equal(otherClass.isAssignedTeacher, false);
  assert.deepEqual(admin.rows[0].response.tests.map(item => item.slug), ['term-test-2', 'term-test-2-k56']);

  await database.exec("INSERT INTO mapping.reviewer_class_assignment VALUES ('other-teacher@example.test', 'IC2265');");
  const assigned = await database.query(listTermTestTeacherOptionsLegacySql, ['other-teacher@example.test', false]);
  assert.deepEqual(assigned.rows[0].response.classes.map(item => item.name), ['IC2265']);
  assert.equal(assigned.rows[0].response.classes[0].accessMode, 'assigned_teacher');
  const assignedResults = await database.query(listTermTestTeacherResultsLegacySql, [
    'IC2265', 'term-test-2-k56', 'other-teacher@example.test', false
  ]);
  assert.equal(assignedResults.rows[0].authorized_class_count, 1);
  assert.equal(assignedResults.rows[0].access_mode, 'assigned_teacher');
  assert.equal(assignedResults.rows[0].students?.length, 1);
  const deniedResults = await database.query(listTermTestTeacherResultsLegacySql, [
    'IC2264', 'term-test-2-k56', 'other-teacher@example.test', false
  ]);
  assert.equal(deniedResults.rows[0].authorized_class_count, 0);

  // Kiểm endpoint thật với schema K56: bảng quyền không có cột metadata Portal.
  const config = {
    nodeEnv: 'test', port: 8788, databaseUrl: 'postgresql://unused-in-tests', dbPoolMax: 2,
    authMode: 'legacy', legacyReviewToken: 'a-valid-test-token', googleClientId: '',
    allowedOrigins: new Set(['https://tranhoangduc90.github.io']), trustProxyHops: 0,
    deploymentProfileName: 'k56-ic2264'
  };
  const app = createApp({
    pool: database,
    config,
    logger: { info() {}, error() {} }
  });
  const k56Options = await request(app)
    .get('/api/term-tests/teacher/options')
    .set('x-review-token', 'a-valid-test-token');
  assert.equal(k56Options.status, 200);
  assert.equal(k56Options.body.classes.length, 2);
  assert.equal(k56Options.body.classes.find(item => item.name === 'IC2265').accessMode, 'admin_override');
  const response = await request(app)
    .get('/api/term-tests/teacher/results?class=IC2265&test=term-test-2-k56')
    .set('x-review-token', 'a-valid-test-token');
  assert.equal(response.status, 200);
  assert.equal(response.body.class.name, 'IC2265');
  assert.equal(response.body.class.accessMode, 'admin_override');
  assert.deepEqual(response.body.students.map(item => item.ref), ['00000000-0000-4000-8000-000000000002']);

  const googleApp = createApp({
    pool: {
      // PGlite trả rows nhưng không trả rowCount như pg; mô phỏng đúng hợp đồng pool của production.
      async query(sql, params) {
        const result = await database.query(sql, params);
        return { ...result, rowCount: result.rows.length };
      }
    },
    config: { ...config, authMode: 'google', googleClientId: 'client-for-test' },
    verifyGoogleToken: async token => ({
      email: token === 'admin-test' ? 'admin@example.test' : 'teacher@example.test',
      sub: token === 'admin-test' ? 'admin-subject-test' : 'teacher-subject-test',
      email_verified: true
    }),
    logger: { info() {}, error() {} }
  });
  const teacherOwn = await request(googleApp)
    .get('/api/term-tests/teacher/results?class=IC2264&test=term-test-2-k56')
    .set('Authorization', 'Bearer teacher-test');
  assert.equal(teacherOwn.status, 200, JSON.stringify(teacherOwn.body));
  assert.equal(teacherOwn.body.class.accessMode, 'assigned_teacher');
  assert.deepEqual(teacherOwn.body.students.map(item => item.ref), ['00000000-0000-4000-8000-000000000001']);
  const teacherOther = await request(googleApp)
    .get('/api/term-tests/teacher/results?class=IC2265&test=term-test-2-k56')
    .set('Authorization', 'Bearer teacher-test');
  assert.equal(teacherOther.status, 403);
  assert.equal(teacherOther.body.error, 'ACCESS_DENIED');
  const adminOther = await request(googleApp)
    .get('/api/term-tests/teacher/results?class=IC2265&test=term-test-2-k56')
    .set('Authorization', 'Bearer admin-test');
  assert.equal(adminOther.status, 200);
  assert.equal(adminOther.body.class.accessMode, 'admin_override');
  assert.equal(adminOther.body.class.isAssignedTeacher, false);

  // Cùng source chạy profile API chính sau khi có đúng metadata Portal của schema ấy.
  await database.exec(`
    ALTER TABLE mapping.reviewer_class_access
      ADD COLUMN portal_teacher_contact_id BIGINT,
      ADD COLUMN class_status_snapshot TEXT,
      ADD COLUMN class_started_at TIMESTAMPTZ,
      ADD COLUMN class_ended_at TIMESTAMPTZ;
    INSERT INTO mapping.reviewer_class_access VALUES
      ('legacy@mapping.local', 2264, 9901, 'on_going', NULL, NULL);
  `);
  const mainApp = createApp({
    pool: database,
    config: { ...config, deploymentProfileName: 'k67' },
    logger: { info() {}, error() {} }
  });
  const mainOptions = await request(mainApp)
    .get('/api/term-tests/teacher/options')
    .set('x-review-token', 'a-valid-test-token');
  assert.equal(mainOptions.status, 200);
  assert.equal(mainOptions.body.classes.find(item => item.name === 'IC2264').accessMode, 'assigned_teacher');
  const mainResults = await request(mainApp)
    .get('/api/term-tests/teacher/results?class=IC2264&test=term-test-2')
    .set('x-review-token', 'a-valid-test-token');
  assert.equal(mainResults.status, 200);
  assert.equal(mainResults.body.class.accessMode, 'assigned_teacher');
});
