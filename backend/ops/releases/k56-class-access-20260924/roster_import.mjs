// Dữ liệu vào: snapshot đích đã đọc trước đó và các hàng K56 mới đã kiểm định.
// Việc chính: khóa hai bảng, so lại toàn bộ đích rồi chèn một giao dịch duy nhất.
// Kết quả: chỉ số lượng đã ghi; không đổi hàng cũ, quyền mở bài hoặc dữ liệu lớp khác.
// Khi lỗi: rollback toàn giao dịch và chỉ trả mã lỗi, không in hồ sơ học viên.

import { createAssessmentSchemaPool } from '../../../src/assessment-schema-pool.js';

const TEST_SLUGS = new Set(['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56']);

class ImportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ImportError';
  }
}

const requireCondition = (condition, code) => {
  if (!condition) throw new ImportError(code);
};

const mappingKey = row => String(row.class_id);
const rosterKey = row => `${row.test_slug}:${row.class_id}:${row.contact_id}`;
const refKey = row => `${row.test_slug}:${row.student_ref}`;

const indexRows = (rows, keyOf, code) => {
  const result = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    requireCondition(!result.has(key), code);
    result.set(key, row);
  }
  return result;
};

const sameRows = (expected, observed, keyOf, fields) => {
  const left = indexRows(expected, keyOf, 'DUPLICATE_EXPECTED_ROW');
  const right = indexRows(observed, keyOf, 'DUPLICATE_TARGET_ROW');
  if (left.size !== right.size) return false;
  for (const [key, row] of left) {
    const current = right.get(key);
    if (!current || fields.some(field => String(row[field]) !== String(current[field]))) {
      return false;
    }
  }
  return true;
};

const readTarget = async (db, classIds = null) => {
  const scoped = Array.isArray(classIds);
  const mappings = (await db.query(`SELECT erp_course_class_id::text AS class_id,
    erp_class_name_snapshot AS class_code
    FROM mapping.classroom_course_mapping
    ${scoped ? 'WHERE erp_course_class_id = ANY($1::bigint[]) FOR SHARE' : ''}`,
  scoped ? [classIds] : [])).rows;
  const roster = (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id,
    erp_student_contact_id::text AS contact_id,
    student_ref::text AS student_ref,
    student_name_snapshot AS student_name
    FROM assessment.term_test_roster WHERE test_slug = ANY($1::text[])
    ${scoped ? 'AND erp_course_class_id = ANY($2::bigint[])' : ''}`,
    scoped ? [[...TEST_SLUGS], classIds] : [[...TEST_SLUGS]])).rows;
  return { mappings, roster };
};

export async function applyRosterImport(db, payload, expectedDatabase) {
  requireCondition(payload && Array.isArray(payload.expectedMappings)
    && Array.isArray(payload.expectedRoster) && Array.isArray(payload.newMappings)
    && Array.isArray(payload.newRoster), 'IMPORT_PAYLOAD_INVALID');
  requireCondition(/^\d+$/.test(String(payload.syncRunId))
    && payload.summary?.syncRunId === payload.syncRunId
    && payload.summary?.classMappingsToAdd === payload.newMappings.length
    && payload.summary?.rosterRowsToAdd === payload.newRoster.length
    && payload.summary?.testCount === TEST_SLUGS.size,
  'IMPORT_SOURCE_LINEAGE_INVALID');
  requireCondition(expectedDatabase === 'mapping_db'
    || expectedDatabase === 'pglite_shared_test'
    || expectedDatabase === 'izone_mapping_k56_ic2264'
    || expectedDatabase === 'pglite_test', 'IMPORT_TARGET_NOT_ALLOWED');
  const shared = expectedDatabase === 'mapping_db'
    || expectedDatabase === 'pglite_shared_test';
  requireCondition(!shared || payload.newMappings.length === 0,
    'SHARED_MAPPING_ALREADY_EXISTS');
  if (shared) db = createAssessmentSchemaPool(db, { family: 'k56' });
  const oldMappings = indexRows(payload.expectedMappings, mappingKey,
    'DUPLICATE_EXPECTED_MAPPING');
  const oldRoster = indexRows(payload.expectedRoster, rosterKey,
    'DUPLICATE_EXPECTED_ROSTER');
  const newMappings = indexRows(payload.newMappings, mappingKey,
    'DUPLICATE_NEW_MAPPING');
  const newRoster = indexRows(payload.newRoster, rosterKey,
    'DUPLICATE_NEW_ROSTER');
  const allClasses = new Map(oldMappings);
  const allRefs = new Set([...oldRoster.values()].map(refKey));
  for (const [key, row] of newMappings) {
    requireCondition(!allClasses.has(key), 'MAPPING_ALREADY_EXISTS');
    requireCondition(/^\d+$/.test(String(row.class_id))
      && typeof row.class_code === 'string' && /^IC\d+$/.test(row.class_code),
      'INVALID_NEW_CLASS_CODE');
    allClasses.set(key, row);
  }
  const codes = new Set();
  for (const row of allClasses.values()) {
    requireCondition(!codes.has(row.class_code), 'DUPLICATE_CLASS_CODE');
    codes.add(row.class_code);
  }
  for (const [key, row] of newRoster) {
    requireCondition(!oldRoster.has(key), 'ROSTER_ALREADY_EXISTS');
    requireCondition(TEST_SLUGS.has(row.test_slug) && allClasses.has(String(row.class_id))
      && /^\d+$/.test(String(row.contact_id))
      && typeof row.student_name === 'string' && row.student_name.trim(),
    'INVALID_NEW_ROSTER_ROW');
    requireCondition(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(row.student_ref), 'INVALID_NEW_STUDENT_REF');
    requireCondition(!allRefs.has(refKey(row)), 'DUPLICATE_NEW_STUDENT_REF');
    allRefs.add(refKey(row));
  }

  await db.query('BEGIN');
  try {
    const database = (await db.query('SELECT current_database() AS name')).rows[0]?.name;
    requireCondition(database === expectedDatabase, 'WRONG_TARGET_DATABASE');
    const gate = (await db.query(`SELECT
      to_regclass('assessment.term_test_class_access') IS NOT NULL AS exists`)).rows[0];
    requireCondition(gate?.exists, 'CLASS_ACCESS_GATE_NOT_INSTALLED');
    await db.query(shared
      ? 'LOCK TABLE assessment.term_test_roster IN SHARE ROW EXCLUSIVE MODE'
      : `LOCK TABLE mapping.classroom_course_mapping,
        assessment.term_test_roster IN SHARE ROW EXCLUSIVE MODE`);
    const scopeIds = shared ? [...oldMappings.keys()] : null;
    const before = await readTarget(db, scopeIds);
    requireCondition(sameRows(payload.expectedMappings, before.mappings, mappingKey,
      ['class_id', 'class_code'])
      && sameRows(payload.expectedRoster, before.roster, rosterKey,
        ['test_slug', 'class_id', 'contact_id', 'student_ref', 'student_name']),
    'TARGET_CHANGED_SINCE_PREVIEW');
    for (const row of payload.newMappings) {
      await db.query(`INSERT INTO mapping.classroom_course_mapping
        (erp_course_class_id, erp_class_name_snapshot) VALUES ($1, $2)`,
      [row.class_id, row.class_code]);
    }
    for (const row of payload.newRoster) {
      await db.query(`INSERT INTO assessment.term_test_roster
        (test_slug, erp_course_class_id, erp_student_contact_id,
          student_ref, student_name_snapshot)
        VALUES ($1, $2, $3, $4, $5)`,
      [row.test_slug, row.class_id, row.contact_id,
        row.student_ref, row.student_name]);
    }
    const after = await readTarget(db, scopeIds);
    requireCondition(sameRows([...payload.expectedMappings, ...payload.newMappings],
      after.mappings, mappingKey, ['class_id', 'class_code'])
      && sameRows([...payload.expectedRoster, ...payload.newRoster],
        after.roster, rosterKey,
        ['test_slug', 'class_id', 'contact_id', 'student_ref', 'student_name']),
    'IMPORT_READBACK_MISMATCH');
    await db.query('COMMIT');
    return { toolOutcome: 'success', businessOutcome: 'import_readback_verified',
      classMappingsAdded: payload.newMappings.length,
      rosterRowsAdded: payload.newRoster.length,
      rosterRowsPreserved: payload.expectedRoster.length,
      accessRowsChanged: 0 };
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { /* Kết nối hỏng: caller phải đọc lại đích. */ }
    throw error instanceof ImportError ? error : new ImportError('IMPORT_TRANSACTION_FAILED');
  }
}

export { ImportError };
