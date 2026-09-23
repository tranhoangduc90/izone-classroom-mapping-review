// Dữ liệu vào: phạm vi lớp/học viên K56 đã kiểm từ cùng một lượt ERP.
// Việc chính: chỉ bật quyền sau khi ba roster của từng lớp khớp chính xác.
// Kết quả: số cặp lớp–đề được bật; không ghép Classroom hay sửa bài học viên.
// Khi lỗi: rollback toàn bộ, không mở một phần lớp và không in ID học viên.

const SLUGS = ['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56'];
const slugSet = new Set(SLUGS);

class AccessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AccessError';
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new AccessError(code);
}

function distinctKeys(rows, keyOf, code) {
  const keys = new Set();
  for (const row of rows) {
    const key = keyOf(row);
    requireCondition(!keys.has(key), code);
    keys.add(key);
  }
  return keys;
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every(key => b.has(key));
}

async function readAccess(db) {
  return (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id, enabled
    FROM assessment.term_test_class_access`)).rows;
}

export async function enableK56ClassAccess(db, input, expectedDatabase) {
  requireCondition(input && /^\d+$/.test(String(input.syncRunId))
    && Array.isArray(input.scopeClasses) && Array.isArray(input.eligibleMembers)
    && Array.isArray(input.expectedRosterRefs)
    && Array.isArray(input.expectedAccess), 'ACCESS_INPUT_INVALID');
  requireCondition(input.summary?.syncRunId === input.syncRunId
    && input.summary?.classCount === input.scopeClasses.length
    && input.summary?.eligibleStudents === input.eligibleMembers.length
    && input.summary?.testCount === SLUGS.length,
  'ACCESS_SOURCE_LINEAGE_INVALID');
  requireCondition(expectedDatabase === 'izone_mapping_k56_ic2264'
    || expectedDatabase === 'pglite_test', 'ACCESS_TARGET_NOT_ALLOWED');
  const classes = new Map();
  for (const row of input.scopeClasses) {
    const id = String(row.class_id);
    requireCondition(/^\d+$/.test(id) && /^IC\d+$/.test(row.class_code)
      && !classes.has(id), 'ACCESS_CLASS_SCOPE_INVALID');
    classes.set(id, row.class_code);
  }
  requireCondition(classes.size > 0, 'ACCESS_CLASS_SCOPE_EMPTY');
  const members = distinctKeys(input.eligibleMembers,
    row => `${row.class_id}:${row.contact_id}`, 'ACCESS_DUPLICATE_MEMBER');
  const classCounts = new Map([...classes.keys()].map(id => [id, 0]));
  for (const row of input.eligibleMembers) {
    const id = String(row.class_id);
    requireCondition(classes.has(id) && /^\d+$/.test(String(row.contact_id)),
      'ACCESS_MEMBER_OUTSIDE_SCOPE');
    classCounts.set(id, classCounts.get(id) + 1);
  }
  requireCondition([...classCounts.values()].every(count => count > 0),
    'ACCESS_EMPTY_CLASS_ROSTER');
  const expectedAccessKeys = distinctKeys(input.expectedAccess,
    row => `${row.test_slug}:${row.class_id}`, 'ACCESS_DUPLICATE_BASELINE');
  requireCondition([...input.expectedAccess].every(row =>
    slugSet.has(row.test_slug) && typeof row.enabled === 'boolean'),
  'ACCESS_BASELINE_INVALID');

  await db.query('BEGIN');
  try {
    const dbName = (await db.query('SELECT current_database() AS name')).rows[0]?.name;
    requireCondition(dbName === expectedDatabase, 'ACCESS_WRONG_DATABASE');
    const gate = (await db.query(`SELECT
      to_regclass('assessment.term_test_class_access') IS NOT NULL AS exists`)).rows[0];
    requireCondition(gate?.exists, 'ACCESS_GATE_MISSING');
    await db.query(`LOCK TABLE mapping.classroom_course_mapping,
      assessment.term_test_roster, assessment.term_test_class_access
      IN SHARE ROW EXCLUSIVE MODE`);
    const definitions = (await db.query(`SELECT slug, is_active
      FROM assessment.test_definition WHERE slug = ANY($1::text[])`, [SLUGS])).rows;
    requireCondition(definitions.length === SLUGS.length
      && definitions.every(row => slugSet.has(row.slug) && row.is_active),
    'ACCESS_TEST_DEFINITIONS_NOT_READY');
    const mapped = (await db.query(`SELECT erp_course_class_id::text AS class_id,
      erp_class_name_snapshot AS class_code FROM mapping.classroom_course_mapping
      WHERE erp_course_class_id = ANY($1::bigint[])`, [[...classes.keys()]])).rows;
    requireCondition(mapped.length === classes.size
      && mapped.every(row => classes.get(row.class_id) === row.class_code),
    'ACCESS_CLASS_MAPPING_MISMATCH');
    const roster = (await db.query(`SELECT test_slug,
      erp_course_class_id::text AS class_id,
      erp_student_contact_id::text AS contact_id,
      student_ref::text AS student_ref
      FROM assessment.term_test_roster
      WHERE test_slug = ANY($1::text[])
        AND erp_course_class_id = ANY($2::bigint[])
        AND is_eligible = true`,
    [SLUGS, [...classes.keys()]])).rows;
    const expectedRoster = new Set();
    for (const slug of SLUGS) {
      for (const key of members) expectedRoster.add(`${slug}:${key}`);
    }
    const actualRoster = distinctKeys(roster,
      row => `${row.test_slug}:${row.class_id}:${row.contact_id}`,
      'ACCESS_DUPLICATE_ROSTER');
    const expectedRefs = new Map();
    for (const row of input.expectedRosterRefs) {
      const key = `${row.test_slug}:${row.class_id}:${row.contact_id}`;
      requireCondition(!expectedRefs.has(key), 'ACCESS_DUPLICATE_EXPECTED_REF');
      expectedRefs.set(key, row.student_ref);
    }
    requireCondition(sameSet(expectedRoster, actualRoster)
      && sameSet(expectedRoster, new Set(expectedRefs.keys()))
      && roster.every(row => expectedRefs.get(
        `${row.test_slug}:${row.class_id}:${row.contact_id}`) === row.student_ref),
      'ACCESS_ROSTER_NOT_RECONCILED');
    const before = await readAccess(db);
    const actualAccessKeys = distinctKeys(before,
      row => `${row.test_slug}:${row.class_id}`, 'ACCESS_DUPLICATE_CURRENT');
    requireCondition(sameSet(expectedAccessKeys, actualAccessKeys)
      && before.every(row => input.expectedAccess.some(old =>
        old.test_slug === row.test_slug && String(old.class_id) === row.class_id
        && old.enabled === row.enabled)), 'ACCESS_CHANGED_SINCE_PREVIEW');
    requireCondition(before.every(row => !row.enabled || classes.has(row.class_id)),
      'ACCESS_ENABLED_OUTSIDE_SCOPE');
    for (const slug of SLUGS) {
      for (const classId of classes.keys()) {
        await db.query(`INSERT INTO assessment.term_test_class_access
          (test_slug, erp_course_class_id, enabled, source)
          VALUES ($1, $2, true, 'k56_erp_ongoing_sync')
          ON CONFLICT (test_slug, erp_course_class_id)
          DO UPDATE SET enabled = true,
            source = 'k56_erp_ongoing_sync', updated_at = now()
          WHERE assessment.term_test_class_access.enabled = false`, [slug, classId]);
      }
    }
    const after = await readAccess(db);
    const enabled = after.filter(row => row.enabled);
    const desired = new Set(SLUGS.flatMap(slug =>
      [...classes.keys()].map(classId => `${slug}:${classId}`)));
    requireCondition(sameSet(desired, new Set(enabled.map(row =>
      `${row.test_slug}:${row.class_id}`))), 'ACCESS_READBACK_MISMATCH');
    await db.query('COMMIT');
    return { toolOutcome: 'success', businessOutcome: 'access_readback_verified',
      syncRunId: input.syncRunId, enabledClassCount: classes.size,
      enabledClassTestPairs: enabled.length, rosterRowsChecked: roster.length };
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { /* Đích phải được kiểm lại trước retry. */ }
    throw error instanceof AccessError ? error : new AccessError('ACCESS_TRANSACTION_FAILED');
  }
}

export { AccessError };
