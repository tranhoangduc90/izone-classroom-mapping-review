import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAssessmentSchemaPool } from '../src/assessment-schema-pool.js';
import { reconcileK56Roster } from '../src/k56-roster-reconcile.js';

const SLUGS = ['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56'];
const now = new Date('2026-09-24T08:00:00Z');

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA mapping;
    CREATE SCHEMA assessment_k56;
    CREATE SCHEMA assessment;
    CREATE TABLE mapping.sync_run (
      id BIGINT PRIMARY KEY, source TEXT, status TEXT, class_names TEXT[],
      row_count INT, finished_at TIMESTAMPTZ, error_message TEXT
    );
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY, erp_class_name_snapshot TEXT
    );
    CREATE TABLE mapping.erp_class_membership_snapshot (
      sync_run_id BIGINT, erp_course_class_id BIGINT,
      erp_class_name_snapshot TEXT, erp_student_contact_id BIGINT,
      erp_student_name_snapshot TEXT, source_state TEXT, registration_status TEXT
    );
    CREATE TABLE assessment_k56.test_definition (slug TEXT PRIMARY KEY, is_active BOOLEAN);
    CREATE TABLE assessment_k56.term_test_roster (
      test_slug TEXT, erp_course_class_id BIGINT, erp_student_contact_id BIGINT,
      student_ref UUID, student_name_snapshot TEXT, is_eligible BOOLEAN,
      PRIMARY KEY (test_slug, erp_course_class_id, erp_student_contact_id),
      UNIQUE (test_slug, student_ref)
    );
    CREATE TABLE assessment_k56.term_test_class_access (
      test_slug TEXT, erp_course_class_id BIGINT, enabled BOOLEAN,
      source TEXT DEFAULT 'manual_review', updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (test_slug, erp_course_class_id)
    );
    CREATE TABLE assessment_k56.k56_roster_sync_checkpoint (
      source_name TEXT PRIMARY KEY, last_sync_run_id BIGINT, updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE assessment.k67_guard (id INT PRIMARY KEY);
    INSERT INTO assessment.k67_guard VALUES (67);
    INSERT INTO mapping.sync_run VALUES
      (98, 'n8n_k56_erp_ongoing', 'completed', ARRAY['IC2264'], 1,
        '2026-09-23T08:00:00Z', NULL),
      (105, 'n8n_k56_erp_ongoing', 'completed', ARRAY['IC2264'], 2,
        '2026-09-24T07:00:00Z', NULL);
    INSERT INTO mapping.classroom_course_mapping VALUES (1252, 'IC2264');
    INSERT INTO mapping.erp_class_membership_snapshot VALUES
      (105, 1252, 'IC2264', 101, 'Học viên giả A', 'active', 'on_going'),
      (105, 1252, 'IC2264', 102, 'Học viên giả B', 'active', 'on_going');
  `);
  for (const [index, slug] of SLUGS.entries()) {
    await db.query('INSERT INTO assessment_k56.test_definition VALUES ($1, true)', [slug]);
    await db.query(`INSERT INTO assessment_k56.term_test_roster VALUES
      ($1, 1252, 101, $2, 'Học viên giả A', true)`,
    [slug, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]);
    await db.query(`INSERT INTO assessment_k56.term_test_class_access
      (test_slug, erp_course_class_id, enabled) VALUES ($1, 1252, true)`, [slug]);
  }
  const pool = createAssessmentSchemaPool({
    query: (sql, params) => sql === 'SELECT current_database() AS name'
      ? Promise.resolve({ rows: [{ name: 'pglite_shared_test' }] })
      : db.query(sql, params),
    connect: async () => ({
      query: (sql, params) => sql === 'SELECT current_database() AS name'
        ? Promise.resolve({ rows: [{ name: 'pglite_shared_test' }] })
        : db.query(sql, params),
      release() {}
    })
  }, { family: 'k56' });
  return { db, pool };
}

async function counts(db) {
  const roster = (await db.query('SELECT count(*)::int AS n FROM assessment_k56.term_test_roster')).rows[0].n;
  const access = (await db.query('SELECT count(*)::int AS n FROM assessment_k56.term_test_class_access')).rows[0].n;
  const checkpoint = (await db.query(`SELECT last_sync_run_id::text AS id
    FROM assessment_k56.k56_roster_sync_checkpoint`)).rows[0]?.id ?? null;
  const k67 = (await db.query('SELECT count(*)::int AS n FROM assessment.k67_guard')).rows[0].n;
  return { roster, access, checkpoint, k67 };
}

test('thử trên dữ liệu thật theo giao dịch rồi rollback không đổi checkpoint', async () => {
  const { db, pool } = await setup();
  try {
    const before = await counts(db);
    const result = await reconcileK56Roster(pool,
      { dryRun: true, expectedDatabase: 'pglite_shared_test', now });
    assert.equal(result.businessOutcome, 'rollback_dry_run_verified');
    assert.equal(result.rosterRowsAdded, 3);
    assert.deepEqual(await counts(db), before);
  } finally { await db.close(); }
});

test('lượt ERP thêm học viên giữ UUID cũ, mở đúng K56 và chạy lại không ghi', async () => {
  const { db, pool } = await setup();
  try {
    const old = (await db.query(`SELECT student_ref::text AS ref
      FROM assessment_k56.term_test_roster ORDER BY test_slug`)).rows;
    const result = await reconcileK56Roster(pool,
      { expectedDatabase: 'pglite_shared_test', now });
    assert.equal(result.businessOutcome, 'reconciled_verified');
    assert.equal(result.rosterRowsAdded, 3);
    assert.deepEqual(await counts(db), { roster: 6, access: 3, checkpoint: '105', k67: 1 });
    const preserved = (await db.query(`SELECT student_ref::text AS ref
      FROM assessment_k56.term_test_roster WHERE erp_student_contact_id = 101
      ORDER BY test_slug`)).rows;
    assert.deepEqual(preserved, old);
    assert.equal((await reconcileK56Roster(pool,
      { expectedDatabase: 'pglite_shared_test', now })).businessOutcome,
    'already_reconciled');
    assert.deepEqual(await counts(db), { roster: 6, access: 3, checkpoint: '105', k67: 1 });
  } finally { await db.close(); }
});

test('lớp mới chỉ từ ID ERP, không cần Classroom, được ba roster và ba quyền', async () => {
  const { db, pool } = await setup();
  try {
    await db.exec(`UPDATE mapping.sync_run SET class_names = ARRAY['IC2264','IC2322'],
      row_count = 3 WHERE id = 105;
      INSERT INTO mapping.classroom_course_mapping VALUES (2322, 'IC2322');
      INSERT INTO mapping.erp_class_membership_snapshot VALUES
      (105, 2322, 'IC2322', 103, 'Học viên giả C', 'active', 'on_going');`);
    const result = await reconcileK56Roster(pool,
      { expectedDatabase: 'pglite_shared_test', now });
    assert.equal(result.rosterRowsAdded, 6);
    assert.equal(result.classTestPairsEnabled, 3);
    assert.deepEqual(await counts(db), { roster: 9, access: 6, checkpoint: '105', k67: 1 });
  } finally { await db.close(); }
});

test('học viên rời lớp phải xem riêng, không chốt lượt và không xóa bài cũ', async () => {
  const { db, pool } = await setup();
  try {
    await reconcileK56Roster(pool, { expectedDatabase: 'pglite_shared_test', now });
    await db.exec(`INSERT INTO mapping.sync_run VALUES
      (106, 'n8n_k56_erp_ongoing', 'completed', ARRAY['IC2264'], 2,
        '2026-09-24T07:30:00Z', NULL);
      INSERT INTO mapping.erp_class_membership_snapshot VALUES
      (106, 1252, 'IC2264', 101, 'Học viên giả A', 'active', 'on_going'),
      (106, 1252, 'IC2264', 102, 'Học viên giả B', 'active', 'finished');`);
    const before = await counts(db);
    await assert.rejects(reconcileK56Roster(pool,
      { expectedDatabase: 'pglite_shared_test', now }),
    /K56_MANUAL_REVIEW_REQUIRED/);
    assert.deepEqual(await counts(db), before);
  } finally { await db.close(); }
});

test('lỗi ở giữa lô rollback roster và checkpoint, K67 vẫn nguyên', async () => {
  const { db, pool } = await setup();
  try {
    const before = await counts(db);
    let inserts = 0;
    const failingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql, params) => {
            if (String(sql).includes('INSERT INTO assessment.term_test_roster')
                && ++inserts === 2) throw new Error('INJECTED_FAILURE');
            return client.query(sql, params);
          },
          release: () => client.release()
        };
      }
    };
    await assert.rejects(reconcileK56Roster(failingPool,
      { expectedDatabase: 'pglite_shared_test', now }),
    /K56_RECONCILE_TRANSACTION_FAILED/);
    assert.deepEqual(await counts(db), before);
  } finally { await db.close(); }
});

test('checkpoint cũ hoặc cùng lượt bị mất roster không được coi là thành công', async () => {
  const { db, pool } = await setup();
  try {
    await db.exec(`INSERT INTO assessment_k56.k56_roster_sync_checkpoint
      VALUES ('n8n_k56_erp_ongoing', 106, now());`);
    await assert.rejects(reconcileK56Roster(pool,
      { expectedDatabase: 'pglite_shared_test', now }), /K56_OLDER_SOURCE_RUN/);
    await db.exec(`UPDATE assessment_k56.k56_roster_sync_checkpoint
      SET last_sync_run_id = 105;`);
    await assert.rejects(reconcileK56Roster(pool,
      { expectedDatabase: 'pglite_shared_test', now }), /K56_CHECKPOINT_TARGET_DRIFT/);
    assert.deepEqual(await counts(db), { roster: 3, access: 3, checkpoint: '105', k67: 1 });
  } finally { await db.close(); }
});
