import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { reconcileK56Eligibility } from '../ops/releases/k56-class-access-20260924/eligibility_reconcile.mjs';

const slugs = ['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56'];
const members = [
  { class_id: '1252', contact_id: '101' },
  { class_id: '1252', contact_id: '102' },
  { class_id: '2322', contact_id: '201' }
];

async function setup() {
  // Dữ liệu vào: hai lớp và ba học viên giả ở ba đề.
  // Việc chính: dựng database trong RAM, không dùng dữ liệu học viên thật.
  // Kết quả: trạng thái sau B5 để thử lượt đồng bộ kế tiếp.
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA mapping;
    CREATE SCHEMA assessment;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE assessment.term_test_roster (
      test_slug TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      student_ref UUID NOT NULL,
      student_name_snapshot TEXT NOT NULL,
      is_eligible BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (test_slug, erp_course_class_id, erp_student_contact_id)
    );
    CREATE TABLE assessment.term_test_class_access (
      test_slug TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      enabled BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (test_slug, erp_course_class_id)
    );
    CREATE TABLE assessment.k56_roster_sync_checkpoint (
      source_name TEXT PRIMARY KEY,
      last_sync_run_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO mapping.classroom_course_mapping VALUES
      (1252, 'IC2264'), (2322, 'IC2322');
    INSERT INTO assessment.k56_roster_sync_checkpoint VALUES
      ('n8n_k56_erp_ongoing', 102, now());
  `);
  for (const [index, slug] of slugs.entries()) {
    for (const [number, row] of members.entries()) {
      await db.query(`INSERT INTO assessment.term_test_roster
        (test_slug, erp_course_class_id, erp_student_contact_id,
          student_ref, student_name_snapshot)
        VALUES ($1, $2, $3, $4, $5)`,
      [slug, row.class_id, row.contact_id,
        `00000000-0000-4000-8000-${String(index * 3 + number + 1).padStart(12, '0')}`,
        `Học viên giả ${number + 1}`]);
    }
    for (const classId of ['1252', '2322']) {
      await db.query(`INSERT INTO assessment.term_test_class_access
        (test_slug, erp_course_class_id, enabled) VALUES ($1, $2, true)`,
      [slug, classId]);
    }
  }
  return db;
}

function testDatabase(db, interceptor = null) {
  return {
    query: (sql, params) => {
      if (sql === 'SELECT current_database() AS name') {
        return Promise.resolve({ rows: [{ name: 'pglite_test' }] });
      }
      if (interceptor) interceptor(sql);
      return db.query(sql, params);
    }
  };
}

async function target(db) {
  const roster = (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id,
    erp_student_contact_id::text AS contact_id,
    student_ref::text AS student_ref,
    student_name_snapshot AS student_name, is_eligible
    FROM assessment.term_test_roster ORDER BY test_slug, erp_course_class_id,
      erp_student_contact_id`)).rows;
  const access = (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id, enabled
    FROM assessment.term_test_class_access ORDER BY test_slug, erp_course_class_id`)).rows;
  return { roster, access };
}

async function payload(db, {
  runId = '103', eligible = members, classes = [
    { class_id: '1252', class_code: 'IC2264' },
    { class_id: '2322', class_code: 'IC2322' }
  ], reviewed = null
} = {}) {
  const baseline = await target(db);
  const wanted = new Set(eligible.map(row => `${row.class_id}:${row.contact_id}`));
  const wantedAccess = new Set(slugs.flatMap(slug =>
    classes.map(row => `${slug}:${row.class_id}`)));
  const activate = baseline.roster.filter(row =>
    !row.is_eligible && wanted.has(`${row.class_id}:${row.contact_id}`)).length;
  const deactivate = baseline.roster.filter(row =>
    row.is_eligible && !wanted.has(`${row.class_id}:${row.contact_id}`)).length;
  const enable = baseline.access.filter(row =>
    !row.enabled && wantedAccess.has(`${row.test_slug}:${row.class_id}`)).length;
  const disable = baseline.access.filter(row =>
    row.enabled && !wantedAccess.has(`${row.test_slug}:${row.class_id}`)).length;
  return {
    syncRunId: runId,
    sourceSummary: { syncRunId: runId, classCount: classes.length,
      eligibleStudents: eligible.length, testCount: 3,
      classMappingsToAdd: 0, rosterRowsToAdd: 0 },
    diff: { syncRunId: runId, rosterRowsToActivate: activate,
      rosterRowsToDeactivate: deactivate, classTestPairsToEnable: enable,
      classTestPairsToDisable: disable,
      manualReviewRequired: deactivate > 0 || disable > 0 },
    reviewedSyncRunId: reviewed,
    scopeClasses: classes, eligibleMembers: eligible,
    expectedRoster: baseline.roster, expectedAccess: baseline.access
  };
}

async function checkpoint(db) {
  return (await db.query(`SELECT last_sync_run_id::text AS run_id
    FROM assessment.k56_roster_sync_checkpoint`)).rows[0].run_id;
}

test('học viên rời lớp giữ UUID/bài cũ và không còn đủ điều kiện', async () => {
  const db = await setup();
  try {
    const before = await target(db);
    const input = await payload(db, {
      eligible: [members[0], members[2]], reviewed: '103'
    });
    const result = await reconcileK56Eligibility(testDatabase(db), input, 'pglite_test');
    assert.equal(result.businessOutcome, 'eligibility_readback_verified');
    assert.equal(result.deactivated, 3);
    assert.equal(result.rosterRowsPreserved, 9);
    const after = await target(db);
    assert.deepEqual(after.roster.map(row => row.student_ref),
      before.roster.map(row => row.student_ref));
    assert.equal(after.roster.filter(row => row.contact_id === '102'
      && !row.is_eligible).length, 3);
    assert.equal(after.access.filter(row => row.enabled).length, 6);
    assert.equal(await checkpoint(db), '103');
  } finally { await db.close(); }
});

test('người nghỉ quay lại và chạy lại cùng lượt không tạo bản ghi mới', async () => {
  const db = await setup();
  try {
    await reconcileK56Eligibility(testDatabase(db), await payload(db, {
      eligible: [members[0], members[2]], reviewed: '103'
    }), 'pglite_test');
    const returnResult = await reconcileK56Eligibility(testDatabase(db),
      await payload(db, { runId: '104' }), 'pglite_test');
    assert.equal(returnResult.activated, 3);
    const rerun = await reconcileK56Eligibility(testDatabase(db),
      await payload(db, { runId: '104' }), 'pglite_test');
    assert.equal(rerun.activated, 0);
    assert.equal(rerun.rosterRowsPreserved, 9);
    assert.equal(await checkpoint(db), '104');
  } finally { await db.close(); }
});

test('lớp rời phạm vi bị tắt ba đề nhưng roster lịch sử vẫn còn', async () => {
  const db = await setup();
  try {
    const input = await payload(db, {
      eligible: members.slice(0, 2), classes: [{ class_id: '1252', class_code: 'IC2264' }],
      reviewed: '103'
    });
    const result = await reconcileK56Eligibility(testDatabase(db), input, 'pglite_test');
    assert.equal(result.classTestPairsDisabled, 3);
    assert.equal(result.deactivated, 3);
    const after = await target(db);
    assert.equal(after.access.filter(row => row.class_id === '2322'
      && !row.enabled).length, 3);
    assert.equal(after.roster.filter(row => row.class_id === '2322'
      && !row.is_eligible).length, 3);
    assert.equal(after.roster.length, 9);
  } finally { await db.close(); }
});

test('thiếu duyệt lượt giảm, lượt cũ hoặc baseline đổi đều dừng', async () => {
  const db = await setup();
  try {
    const leaving = await payload(db, { eligible: [members[0], members[2]] });
    await assert.rejects(reconcileK56Eligibility(testDatabase(db), leaving,
      'pglite_test'), /RECONCILE_REVIEW_REQUIRED/);
    assert.equal(await checkpoint(db), '102');
    const old = await payload(db, { runId: '101' });
    await assert.rejects(reconcileK56Eligibility(testDatabase(db), old,
      'pglite_test'), /RECONCILE_OLDER_SOURCE_RUN/);
    const stale = await payload(db);
    await db.query(`UPDATE assessment.term_test_roster SET is_eligible = false
      WHERE erp_student_contact_id = 102 AND test_slug = $1`, [slugs[0]]);
    await assert.rejects(reconcileK56Eligibility(testDatabase(db), stale,
      'pglite_test'), /RECONCILE_TARGET_CHANGED_SINCE_PREVIEW/);
    assert.equal(await checkpoint(db), '102');
  } finally { await db.close(); }
});

test('lỗi giữa giao dịch rollback cả cờ và checkpoint', async () => {
  const db = await setup();
  try {
    const before = await target(db);
    const input = await payload(db, {
      eligible: [members[0], members[2]], reviewed: '103'
    });
    let writes = 0;
    const wrapped = testDatabase(db, sql => {
      if (sql.includes('UPDATE assessment.term_test_roster') && ++writes === 2) {
        throw new Error('simulated write failure');
      }
    });
    await assert.rejects(reconcileK56Eligibility(wrapped, input,
      'pglite_test'), /RECONCILE_TRANSACTION_FAILED/);
    assert.deepEqual(await target(db), before);
    assert.equal(await checkpoint(db), '102');
  } finally { await db.close(); }
});

test('kho chung K56 dùng một client cho giao dịch và không sửa schema K67', async () => {
  const db = await setup();
  try {
    await db.exec(`
      CREATE SCHEMA assessment_k56;
      CREATE TABLE assessment_k56.term_test_roster
        (LIKE assessment.term_test_roster INCLUDING ALL);
      CREATE TABLE assessment_k56.term_test_class_access
        (LIKE assessment.term_test_class_access INCLUDING ALL);
      CREATE TABLE assessment_k56.k56_roster_sync_checkpoint
        (LIKE assessment.k56_roster_sync_checkpoint INCLUDING ALL);
      INSERT INTO assessment_k56.term_test_roster
        SELECT * FROM assessment.term_test_roster;
      INSERT INTO assessment_k56.term_test_class_access
        SELECT * FROM assessment.term_test_class_access;
      INSERT INTO assessment_k56.k56_roster_sync_checkpoint
        SELECT * FROM assessment.k56_roster_sync_checkpoint;
    `);
    const beforeK67 = await target(db);
    const input = await payload(db, {
      eligible: [members[0], members[2]], reviewed: '103'
    });
    let released = 0;
    const pool = {
      query: () => { throw new Error('POOL_QUERY_MUST_NOT_RUN_IN_TRANSACTION'); },
      connect: async () => ({
        query: (sql, params) => sql === 'SELECT current_database() AS name'
          ? Promise.resolve({ rows: [{ name: 'pglite_shared_test' }] })
          : db.query(sql, params),
        release: () => { released += 1; }
      })
    };
    const result = await reconcileK56Eligibility(pool, input, 'pglite_shared_test');
    assert.equal(result.deactivated, 3);
    assert.equal(released, 1);
    assert.deepEqual(await target(db), beforeK67);
    const k56 = (await db.query(`SELECT count(*)::int AS count
      FROM assessment_k56.term_test_roster
      WHERE erp_student_contact_id=102 AND is_eligible=false`)).rows[0];
    assert.equal(k56.count, 3);
    assert.equal((await db.query(`SELECT last_sync_run_id::text AS run_id
      FROM assessment_k56.k56_roster_sync_checkpoint`)).rows[0].run_id, '103');
  } finally { await db.close(); }
});
