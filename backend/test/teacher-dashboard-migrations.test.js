import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('hai migration quyền/canary chạy lặp an toàn và giữ canary trong hai lớp demo', async () => {
  const database = new PGlite();
  await database.exec(`
    CREATE ROLE mapping_review_api;
    CREATE ROLE learning_api;
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.reviewer_account (
      email TEXT PRIMARY KEY,
      google_subject TEXT UNIQUE,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'teacher',
      status TEXT NOT NULL DEFAULT 'active',
      can_access_all_classes BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE mapping.reviewer_class_assignment (
      reviewer_email TEXT NOT NULL,
      class_name TEXT NOT NULL,
      PRIMARY KEY (reviewer_email, class_name)
    );
    CREATE TABLE mapping.reviewer_class_access (
      reviewer_email TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      PRIMARY KEY (reviewer_email, erp_course_class_id)
    );
    CREATE TABLE mapping.sync_run (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL,
      finished_at TIMESTAMPTZ
    );
    CREATE TABLE mapping.lark_replica_run (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL,
      finished_at TIMESTAMPTZ
    );
    INSERT INTO mapping.classroom_course_mapping VALUES
      (-8062028, 'CODEXDEMO806'),
      (990000567, 'PROGRESS-DEMO'),
      (2139, 'IC2139');
  `);
  const grantMigration = await readFile(
    new URL('../ops/migrations/202609200001_effective_teacher_class_access.sql', import.meta.url),
    'utf8'
  );
  const canaryMigration = await readFile(
    new URL('../ops/migrations/202609200002_teacher_dashboard_canary.sql', import.meta.url),
    'utf8'
  );
  await database.exec(grantMigration);
  await database.exec(grantMigration);
  await database.exec(canaryMigration);
  await database.exec(canaryMigration);

  const account = await database.query(`SELECT role, status, can_access_all_classes
    FROM mapping.reviewer_account WHERE email = 'dashboard-canary@synthetic.invalid';`);
  assert.deepEqual(account.rows[0], { role: 'teacher', status: 'active', can_access_all_classes: false });
  const access = await database.query(`SELECT array_agg(erp_course_class_id::text ORDER BY erp_course_class_id) AS ids
    FROM mapping.reviewer_class_access WHERE reviewer_email = 'dashboard-canary@synthetic.invalid';`);
  assert.deepEqual(access.rows[0].ids, ['-8062028', '990000567']);

  const privileges = await database.query(`SELECT grantee, table_name
    FROM information_schema.role_table_grants
    WHERE table_schema = 'mapping'
      AND privilege_type = 'SELECT'
      AND grantee IN ('mapping_review_api', 'learning_api')
    ORDER BY grantee, table_name;`);
  assert.ok(privileges.rows.some(row => row.grantee === 'learning_api' && row.table_name === 'reviewer_class_assignment'));
  assert.ok(privileges.rows.some(row => row.grantee === 'mapping_review_api' && row.table_name === 'sync_run'));
  assert.ok(privileges.rows.some(row => row.grantee === 'mapping_review_api' && row.table_name === 'lark_replica_run'));
  await database.close();
});

test('canary chỉ ghi/xóa phiên tạm và không sửa bài của học viên', async () => {
  const source = await readFile(new URL('../scripts/teacher-dashboard-canary.mjs', import.meta.url), 'utf8');
  assert.match(source, /INSERT INTO mapping\.reviewer_session/);
  assert.match(source, /DELETE FROM mapping\.reviewer_session WHERE token_hash/);
  assert.doesNotMatch(source, /INSERT INTO learning\.(?:attempt|submission|attendance_record)/);
  assert.doesNotMatch(source, /UPDATE learning\.(?:attempt|submission|attendance_record)/);
  assert.doesNotMatch(source, /CANARY_HTTP_\$\{response\.status\}:\$\{path\}/);
  assert.match(source, /const endpoint = String\(path\)\.split\('\?', 1\)\[0\]/);
});
