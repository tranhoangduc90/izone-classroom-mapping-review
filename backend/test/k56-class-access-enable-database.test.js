import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { enableK56ClassAccess } from '../ops/releases/k56-class-access-20260924/class_access_enable.mjs';

const slugs = ['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56'];
const input = () => ({
  syncRunId: '102',
  summary: { syncRunId: '102', classCount: 2, eligibleStudents: 2, testCount: 3 },
  scopeClasses: [
    { class_id: '1252', class_code: 'IC2264' },
    { class_id: '2322', class_code: 'IC2322' }
  ],
  eligibleMembers: [
    { class_id: '1252', contact_id: '101' },
    { class_id: '2322', contact_id: '202' }
  ],
  expectedRosterRefs: slugs.flatMap((test_slug, index) => [
    { test_slug, class_id: '1252', contact_id: '101',
      student_ref: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` },
    { test_slug, class_id: '2322', contact_id: '202',
      student_ref: `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}` }
  ]),
  expectedAccess: slugs.map(test_slug =>
    ({ test_slug, class_id: '1252', enabled: true }))
});

async function setup({ missingRoster = false, outsideEnabled = false } = {}) {
  // Dữ liệu vào: hai lớp và hai học viên giả ở ba đề K56.
  // Việc chính: dựng PostgreSQL trong RAM với cổng quyền pilot.
  // Kết quả: database cho test; không gọi production.
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA mapping;
    CREATE SCHEMA assessment;
    CREATE TABLE mapping.classroom_course_mapping (
      erp_course_class_id BIGINT PRIMARY KEY,
      erp_class_name_snapshot TEXT NOT NULL
    );
    CREATE TABLE assessment.test_definition (
      slug TEXT PRIMARY KEY,
      is_active BOOLEAN NOT NULL
    );
    CREATE TABLE assessment.term_test_roster (
      test_slug TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      erp_student_contact_id BIGINT NOT NULL,
      student_ref UUID NOT NULL,
      is_eligible BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (test_slug, erp_course_class_id, erp_student_contact_id)
    );
    CREATE TABLE assessment.term_test_class_access (
      test_slug TEXT NOT NULL,
      erp_course_class_id BIGINT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL DEFAULT 'manual_review',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (test_slug, erp_course_class_id)
    );
    INSERT INTO mapping.classroom_course_mapping VALUES
      (1252, 'IC2264'), (2322, 'IC2322');
  `);
  for (const [index, slug] of slugs.entries()) {
    await db.query(`INSERT INTO assessment.test_definition VALUES ($1, true)`, [slug]);
    await db.query(`INSERT INTO assessment.term_test_roster VALUES ($1, 1252, 101, $2)`,
      [slug, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]);
    if (!missingRoster || slug !== slugs[1]) {
      await db.query(`INSERT INTO assessment.term_test_roster VALUES ($1, 2322, 202, $2)`,
        [slug, `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`]);
    }
    await db.query(`INSERT INTO assessment.term_test_class_access
      (test_slug, erp_course_class_id, enabled, source)
      VALUES ($1, 1252, true, 'existing_ic2264_pilot')`, [slug]);
  }
  if (outsideEnabled) {
    await db.query(`INSERT INTO assessment.term_test_class_access
      (test_slug, erp_course_class_id, enabled) VALUES ($1, 9999, true)`, [slugs[0]]);
  }
  return db;
}

function testDatabase(db) {
  return {
    query: (sql, params) => sql === 'SELECT current_database() AS name'
      ? Promise.resolve({ rows: [{ name: 'pglite_test' }] })
      : db.query(sql, params)
  };
}

async function accessRows(db) {
  return (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id, enabled, source, updated_at
    FROM assessment.term_test_class_access ORDER BY test_slug, erp_course_class_id`)).rows;
}

test('chỉ bật ba đề sau khi từng roster đã khớp, giữ pilot', async () => {
  const db = await setup();
  try {
    const before = await accessRows(db);
    const result = await enableK56ClassAccess(testDatabase(db), input(), 'pglite_test');
    assert.equal(result.businessOutcome, 'access_readback_verified');
    assert.equal(result.enabledClassCount, 2);
    assert.equal(result.enabledClassTestPairs, 6);
    assert.equal(result.rosterRowsChecked, 6);
    const after = await accessRows(db);
    assert.equal(after.length, 6);
    for (const row of before) {
      assert.deepEqual(after.find(current => current.test_slug === row.test_slug
        && current.class_id === row.class_id), row);
    }
    assert.equal(after.filter(row => row.class_id === '2322'
      && row.source === 'k56_erp_ongoing_sync').length, 3);
  } finally { await db.close(); }
});

test('thiếu một học viên/đề thì không bật bất kỳ cặp mới nào', async () => {
  const db = await setup({ missingRoster: true });
  try {
    await assert.rejects(enableK56ClassAccess(testDatabase(db), input(), 'pglite_test'),
      /ACCESS_ROSTER_NOT_RECONCILED/);
    assert.equal((await accessRows(db)).length, 3);
  } finally { await db.close(); }
});

test('UUID bài đã đổi sau import thì không bật quyền', async () => {
  const db = await setup();
  try {
    await db.query(`UPDATE assessment.term_test_roster
      SET student_ref = '00000000-0000-4000-9000-000000000099'
      WHERE test_slug = $1 AND erp_course_class_id = 2322`, [slugs[0]]);
    await assert.rejects(enableK56ClassAccess(testDatabase(db), input(), 'pglite_test'),
      /ACCESS_ROSTER_NOT_RECONCILED/);
    assert.equal((await accessRows(db)).length, 3);
  } finally { await db.close(); }
});

test('hàng lịch sử không đủ điều kiện được giữ nhưng không tính vào quyền mới', async () => {
  const db = await setup();
  try {
    await db.query(`INSERT INTO assessment.term_test_roster
      (test_slug, erp_course_class_id, erp_student_contact_id, student_ref, is_eligible)
      VALUES ($1, 2322, 999, '00000000-0000-4000-9000-000000000099', false)`,
    [slugs[0]]);
    const result = await enableK56ClassAccess(testDatabase(db), input(), 'pglite_test');
    assert.equal(result.enabledClassTestPairs, 6);
    assert.equal((await db.query(`SELECT count(*)::int AS count
      FROM assessment.term_test_roster WHERE erp_student_contact_id = 999`))
      .rows[0].count, 1);
  } finally { await db.close(); }
});

test('quyền ngoài phạm vi hoặc baseline thay đổi làm dừng an toàn', async () => {
  const db = await setup({ outsideEnabled: true });
  try {
    const scoped = input();
    scoped.expectedAccess.push({ test_slug: slugs[0], class_id: '9999', enabled: true });
    await assert.rejects(enableK56ClassAccess(testDatabase(db), scoped, 'pglite_test'),
      /ACCESS_ENABLED_OUTSIDE_SCOPE/);
    assert.equal((await accessRows(db)).length, 4);
  } finally { await db.close(); }
  const changed = await setup();
  try {
    await changed.query(`UPDATE assessment.term_test_class_access SET enabled = false
      WHERE test_slug = $1`, [slugs[0]]);
    await assert.rejects(enableK56ClassAccess(testDatabase(changed), input(), 'pglite_test'),
      /ACCESS_CHANGED_SINCE_PREVIEW/);
    assert.equal((await accessRows(changed)).length, 3);
  } finally { await changed.close(); }
});

test('chạy lại cùng lượt không tạo cặp trùng hoặc đổi pilot', async () => {
  const db = await setup();
  try {
    await enableK56ClassAccess(testDatabase(db), input(), 'pglite_test');
    const before = await accessRows(db);
    const rerun = input();
    rerun.expectedAccess = before.map(row => ({
      test_slug: row.test_slug, class_id: row.class_id, enabled: row.enabled
    }));
    const result = await enableK56ClassAccess(testDatabase(db), rerun, 'pglite_test');
    assert.equal(result.enabledClassTestPairs, 6);
    assert.deepEqual(await accessRows(db), before);
  } finally { await db.close(); }
});

test('ID lớp và học viên mâu thuẫn bị chặn trước giao dịch', async () => {
  const db = await setup();
  try {
    const wrong = input();
    wrong.eligibleMembers[1].class_id = '9999';
    await assert.rejects(enableK56ClassAccess(testDatabase(db), wrong, 'pglite_test'),
      /ACCESS_MEMBER_OUTSIDE_SCOPE/);
    assert.equal((await accessRows(db)).length, 3);
  } finally { await db.close(); }
});

test('thiếu lớp trong phạm vi hoặc sai lượt nguồn bị chặn', async () => {
  const db = await setup();
  try {
    const incomplete = input();
    incomplete.scopeClasses.pop();
    await assert.rejects(enableK56ClassAccess(testDatabase(db), incomplete, 'pglite_test'),
      /ACCESS_SOURCE_LINEAGE_INVALID/);
    const wrongRun = input();
    wrongRun.syncRunId = '103';
    await assert.rejects(enableK56ClassAccess(testDatabase(db), wrongRun, 'pglite_test'),
      /ACCESS_SOURCE_LINEAGE_INVALID/);
    assert.equal((await accessRows(db)).length, 3);
  } finally { await db.close(); }
});
