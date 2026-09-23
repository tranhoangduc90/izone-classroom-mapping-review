import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createTermTestPortalSyncService } from '../src/term-test-portal-sync.js';

test('hàng đồng bộ Portal chỉ nhận Term K56 đã cấp quyền, còn K67 giữ hành vi cũ', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE SCHEMA assessment;
      CREATE SCHEMA mapping;
      CREATE TABLE mapping.classroom_course_mapping (
        erp_course_class_id BIGINT PRIMARY KEY
      );
      CREATE TABLE assessment.test_definition (
        slug TEXT PRIMARY KEY,
        is_active BOOLEAN NOT NULL
      );
      CREATE TABLE assessment.term_test_attempt (
        id UUID PRIMARY KEY,
        test_slug TEXT NOT NULL,
        class_name_snapshot TEXT NOT NULL,
        erp_course_class_id BIGINT NOT NULL
      );
      CREATE TABLE assessment.term_test_class_access (
        test_slug TEXT NOT NULL,
        erp_course_class_id BIGINT NOT NULL,
        enabled BOOLEAN NOT NULL,
        PRIMARY KEY (test_slug, erp_course_class_id)
      );
      CREATE TABLE assessment.term_test_portal_sync_job (
        attempt_id UUID PRIMARY KEY,
        request_version BIGINT NOT NULL,
        writing_score NUMERIC,
        status TEXT NOT NULL,
        available_at TIMESTAMPTZ NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        lease_until TIMESTAMPTZ,
        worker_id TEXT,
        last_error_code TEXT,
        completed_at TIMESTAMPTZ
      );
      INSERT INTO assessment.term_test_attempt VALUES
        ('00000000-0000-4000-8000-000000000001', 'term-test-1-k56', 'LỚP A', 1252),
        ('00000000-0000-4000-8000-000000000002', 'term-test-1-k56', 'LỚP B', 2002),
        ('00000000-0000-4000-8000-000000000003', 'term-test-2', 'LỚP C', 3003);
      INSERT INTO assessment.term_test_class_access VALUES
        ('term-test-1-k56', 1252, false),
        ('term-test-1-k56', 2002, true);
      INSERT INTO mapping.classroom_course_mapping VALUES (1252), (2002);
      INSERT INTO assessment.test_definition VALUES
        ('term-test-1-k56', true), ('term-test-2', true);
    `);
    const service = createTermTestPortalSyncService({
      pool: database,
      syncErpGrades: async () => ({ status: 'synced' }),
      logger: { info() {}, error() {} }
    });
    assert.equal(await service.enqueue({ attemptToken: '00000000-0000-4000-8000-000000000001' }), 'not_applicable');
    assert.equal(await service.enqueue({ attemptToken: '00000000-0000-4000-8000-000000000002' }), 'queued');
    assert.equal(await service.enqueue({ attemptToken: '00000000-0000-4000-8000-000000000003' }), 'queued');
    const rows = await database.query(`SELECT attempt_id::text AS attempt_token
      FROM assessment.term_test_portal_sync_job ORDER BY attempt_id`);
    assert.deepEqual(rows.rows.map(row => row.attempt_token), [
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003'
    ]);
  } finally {
    await database.close();
  }
});
