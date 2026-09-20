import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { inspectTeacherClassAccess } from '../src/teacher-class-access-health.js';

async function createDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.reviewer_account (
      email TEXT PRIMARY KEY,
      status TEXT NOT NULL
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
      access_source TEXT NOT NULL DEFAULT 'manual',
      source_seen_at TIMESTAMPTZ,
      PRIMARY KEY (reviewer_email, erp_course_class_id)
    );
    CREATE TABLE mapping.sync_run (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL,
      finished_at TIMESTAMPTZ
    );
    INSERT INTO mapping.reviewer_account VALUES
      ('teacher@example.test', 'active'),
      ('inactive@example.test', 'inactive');
    INSERT INTO mapping.classroom_course_mapping VALUES (2139, 'IC2139');
    INSERT INTO mapping.reviewer_class_assignment VALUES
      ('teacher@example.test', '  ic2139  '),
      ('teacher@example.test', 'IC-NOT-MAPPED');
    INSERT INTO mapping.reviewer_class_access VALUES
      ('inactive@example.test', 2139, 'manual', now());
    INSERT INTO mapping.sync_run (status, finished_at) VALUES ('completed', now());
  `);
  return database;
}

test('checker phát hiện thiếu, chỉ bổ sung dòng thiếu và không lộ danh tính', async () => {
  const database = await createDatabase();
  const query = database.query.bind(database);

  const before = await inspectTeacherClassAccess({ query, freshnessHours: 36 });
  assert.equal(before.outcome, 'critical');
  assert.equal(before.counts.missing_assignment_pairs, 1);
  assert.equal(before.counts.unmapped_assignments, 1);
  assert.equal(before.counts.inactive_reviewer_pairs, 1);
  assert.equal(before.sync.mapping.available, true);
  assert.equal(before.sync.larkReplica.available, false);

  const after = await inspectTeacherClassAccess({ query, freshnessHours: 36, applyMissing: true });
  assert.equal(after.appliedMissingPairs, 1);
  assert.equal(after.counts.missing_assignment_pairs, 0);
  assert.equal(after.outcome, 'attention');
  const stored = await database.query('SELECT count(*)::int AS count FROM mapping.reviewer_class_access;');
  assert.equal(stored.rows[0].count, 2);

  const publicOutput = JSON.stringify(after);
  assert.doesNotMatch(publicOutput, /teacher@example\.test|inactive@example\.test|IC2139|IC-NOT-MAPPED/);
  await database.close();
});

test('checker coi portal quá hạn và sync quá hạn là lỗi nghiêm trọng', async () => {
  const database = await createDatabase();
  await database.exec(`
    INSERT INTO mapping.reviewer_class_access
      (reviewer_email, erp_course_class_id, access_source, source_seen_at)
    VALUES ('teacher@example.test', 2139, 'portal', now() - interval '48 hours')
    ON CONFLICT (reviewer_email, erp_course_class_id) DO UPDATE SET
      access_source = 'portal', source_seen_at = EXCLUDED.source_seen_at;
    UPDATE mapping.sync_run SET finished_at = now() - interval '48 hours';
  `);
  const result = await inspectTeacherClassAccess({ query: database.query.bind(database), freshnessHours: 36 });
  assert.equal(result.outcome, 'critical');
  assert.deepEqual(result.criticalReasons.sort(), [
    'MAPPING_SYNC_STALE',
    'STALE_PORTAL_PAIRS'
  ]);
  await database.close();
});
