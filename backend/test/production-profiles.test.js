import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { resolveDeploymentProfile } from '../src/deployment-profile.js';
import { listTermTestTeacherOptionsLegacySql } from '../src/sql.js';

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
    CREATE TABLE assessment.test_definition (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      version INTEGER NOT NULL,
      is_active BOOLEAN NOT NULL
    );
    INSERT INTO mapping.classroom_course_mapping VALUES
      (2264, 'IC2264'), (2265, 'IC2265');
    INSERT INTO mapping.reviewer_class_access VALUES
      ('teacher@example.test', 2264);
    INSERT INTO assessment.test_definition VALUES
      ('term-test-2-k56', 'Term Test 2', 1, true);
  `);

  const teacher = await database.query(listTermTestTeacherOptionsLegacySql, ['teacher@example.test', false]);
  assert.deepEqual(teacher.rows[0].response.classes.map(item => item.name), ['IC2264']);
  assert.equal(teacher.rows[0].response.classes[0].accessMode, 'assigned_teacher');

  const admin = await database.query(listTermTestTeacherOptionsLegacySql, ['teacher@example.test', true]);
  assert.equal(admin.rows[0].response.classes.length, 2);
  const otherClass = admin.rows[0].response.classes.find(item => item.name === 'IC2265');
  assert.equal(otherClass.accessMode, 'admin_override');
  assert.equal(otherClass.isAssignedTeacher, false);
  assert.equal(admin.rows[0].response.tests[0].slug, 'term-test-2-k56');
});
