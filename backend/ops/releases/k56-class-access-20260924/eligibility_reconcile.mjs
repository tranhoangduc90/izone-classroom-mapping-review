// Dữ liệu vào: snapshot ERP đã kiểm và trạng thái K56 đã xem trước trong RAM.
// Việc chính: khóa bảng, so lại định danh/UUID/quyền, đổi cờ dự thi và ghi lượt nguồn.
// Kết quả: số hàng đổi trạng thái; roster, bài cũ và UUID luôn được giữ nguyên.
// Khi lỗi: rollback toàn bộ và chỉ trả mã lỗi, không in thông tin học viên.

const SLUGS = ['term-test-1-k56', 'term-test-2-k56', 'mini-test-k56'];
const slugSet = new Set(SLUGS);
const SOURCE = 'n8n_k56_erp_ongoing';

class ReconcileError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReconcileError';
  }
}

const requireCondition = (condition, code) => {
  if (!condition) throw new ReconcileError(code);
};
const rosterKey = row => `${row.test_slug}:${row.class_id}:${row.contact_id}`;
const memberKey = row => `${row.class_id}:${row.contact_id}`;
const accessKey = row => `${row.test_slug}:${row.class_id}`;

function indexRows(rows, keyOf, code) {
  const found = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    requireCondition(!found.has(key), code);
    found.set(key, row);
  }
  return found;
}

function sameRoster(expected, actual) {
  if (expected.size !== actual.size) return false;
  for (const [key, old] of expected) {
    const row = actual.get(key);
    if (!row || old.student_ref !== row.student_ref
      || old.student_name !== row.student_name
      || old.is_eligible !== row.is_eligible) return false;
  }
  return true;
}

function sameAccess(expected, actual) {
  if (expected.size !== actual.size) return false;
  for (const [key, old] of expected) {
    const row = actual.get(key);
    if (!row || old.enabled !== row.enabled) return false;
  }
  return true;
}

async function readRoster(db) {
  return (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id,
    erp_student_contact_id::text AS contact_id,
    student_ref::text AS student_ref,
    student_name_snapshot AS student_name, is_eligible
    FROM assessment.term_test_roster WHERE test_slug = ANY($1::text[])`, [SLUGS])).rows;
}

async function readAccess(db) {
  return (await db.query(`SELECT test_slug,
    erp_course_class_id::text AS class_id, enabled
    FROM assessment.term_test_class_access
    WHERE test_slug = ANY($1::text[])`, [SLUGS])).rows;
}

export async function reconcileK56Eligibility(db, input, expectedDatabase) {
  requireCondition(input && /^\d+$/.test(String(input.syncRunId))
    && Array.isArray(input.scopeClasses) && Array.isArray(input.eligibleMembers)
    && Array.isArray(input.expectedRoster) && Array.isArray(input.expectedAccess),
  'RECONCILE_INPUT_INVALID');
  requireCondition(expectedDatabase === 'izone_mapping_k56_ic2264'
    || expectedDatabase === 'pglite_test', 'RECONCILE_TARGET_NOT_ALLOWED');
  const summary = input.sourceSummary;
  const diff = input.diff;
  requireCondition(summary?.syncRunId === input.syncRunId
    && diff?.syncRunId === input.syncRunId
    && summary?.classCount === input.scopeClasses.length
    && summary?.eligibleStudents === input.eligibleMembers.length
    && summary?.testCount === SLUGS.length
    && summary?.classMappingsToAdd === 0 && summary?.rosterRowsToAdd === 0,
  'RECONCILE_SOURCE_LINEAGE_INVALID');

  const classes = indexRows(input.scopeClasses, row => String(row.class_id),
    'RECONCILE_DUPLICATE_CLASS');
  requireCondition(classes.size > 0 && [...classes.values()].every(row =>
    /^\d+$/.test(String(row.class_id)) && /^IC\d+$/.test(row.class_code)),
  'RECONCILE_CLASS_SCOPE_INVALID');
  const members = indexRows(input.eligibleMembers, memberKey,
    'RECONCILE_DUPLICATE_MEMBER');
  const counts = new Map([...classes.keys()].map(id => [id, 0]));
  for (const row of members.values()) {
    const id = String(row.class_id);
    requireCondition(classes.has(id) && /^\d+$/.test(String(row.contact_id)),
      'RECONCILE_MEMBER_OUTSIDE_SCOPE');
    counts.set(id, counts.get(id) + 1);
  }
  requireCondition([...counts.values()].every(count => count > 0),
    'RECONCILE_EMPTY_CLASS_ROSTER');

  const expectedRoster = indexRows(input.expectedRoster, rosterKey,
    'RECONCILE_DUPLICATE_EXPECTED_ROSTER');
  requireCondition([...expectedRoster.values()].every(row =>
    slugSet.has(row.test_slug) && /^\d+$/.test(String(row.class_id))
      && /^\d+$/.test(String(row.contact_id)) && typeof row.student_ref === 'string'
      && typeof row.student_name === 'string'
      && typeof row.is_eligible === 'boolean'),
  'RECONCILE_EXPECTED_ROSTER_INVALID');
  for (const slug of SLUGS) {
    for (const key of members.keys()) {
      requireCondition(expectedRoster.has(`${slug}:${key}`),
        'RECONCILE_ROSTER_NOT_READY');
    }
  }
  const expectedAccess = indexRows(input.expectedAccess, accessKey,
    'RECONCILE_DUPLICATE_EXPECTED_ACCESS');
  requireCondition([...expectedAccess.values()].every(row =>
    slugSet.has(row.test_slug) && /^\d+$/.test(String(row.class_id))
      && typeof row.enabled === 'boolean'),
  'RECONCILE_EXPECTED_ACCESS_INVALID');
  const wantedAccess = new Set(SLUGS.flatMap(slug =>
    [...classes.keys()].map(id => `${slug}:${id}`)));
  requireCondition([...wantedAccess].every(key => expectedAccess.has(key)),
    'RECONCILE_ACCESS_NOT_READY');

  const activate = [...expectedRoster.values()].filter(row =>
    !row.is_eligible && members.has(memberKey(row)));
  const deactivate = [...expectedRoster.values()].filter(row =>
    row.is_eligible && !members.has(memberKey(row)));
  const enable = [...expectedAccess.values()].filter(row =>
    !row.enabled && wantedAccess.has(accessKey(row)));
  const disable = [...expectedAccess.values()].filter(row =>
    row.enabled && !wantedAccess.has(accessKey(row)));
  const reviewRequired = deactivate.length > 0 || disable.length > 0;
  requireCondition(diff?.rosterRowsToActivate === activate.length
    && diff?.rosterRowsToDeactivate === deactivate.length
    && diff?.classTestPairsToEnable === enable.length
    && diff?.classTestPairsToDisable === disable.length
    && diff?.manualReviewRequired === reviewRequired,
  'RECONCILE_DIFF_MISMATCH');
  requireCondition(!reviewRequired
    || String(input.reviewedSyncRunId) === input.syncRunId,
  'RECONCILE_REVIEW_REQUIRED');

  await db.query('BEGIN');
  try {
    const name = (await db.query('SELECT current_database() AS name')).rows[0]?.name;
    requireCondition(name === expectedDatabase, 'RECONCILE_WRONG_DATABASE');
    const gate = (await db.query(`SELECT
      to_regclass('assessment.term_test_class_access') IS NOT NULL AS access_exists,
      to_regclass('assessment.k56_roster_sync_checkpoint') IS NOT NULL AS checkpoint_exists`))
      .rows[0];
    requireCondition(gate?.access_exists && gate?.checkpoint_exists,
      'RECONCILE_MIGRATION_MISSING');
    await db.query(`LOCK TABLE mapping.classroom_course_mapping,
      assessment.term_test_roster, assessment.term_test_class_access,
      assessment.k56_roster_sync_checkpoint IN SHARE ROW EXCLUSIVE MODE`);
    const checkpoint = (await db.query(`SELECT last_sync_run_id::text AS run_id
      FROM assessment.k56_roster_sync_checkpoint WHERE source_name = $1`, [SOURCE])).rows[0];
    requireCondition(!checkpoint || BigInt(input.syncRunId) >= BigInt(checkpoint.run_id),
      'RECONCILE_OLDER_SOURCE_RUN');
    const mapped = (await db.query(`SELECT erp_course_class_id::text AS class_id,
      erp_class_name_snapshot AS class_code FROM mapping.classroom_course_mapping
      WHERE erp_course_class_id = ANY($1::bigint[])`, [[...classes.keys()]])).rows;
    requireCondition(mapped.length === classes.size && mapped.every(row =>
      classes.get(row.class_id)?.class_code === row.class_code),
    'RECONCILE_CLASS_MAPPING_CHANGED');
    const beforeRoster = indexRows(await readRoster(db), rosterKey,
      'RECONCILE_DUPLICATE_CURRENT_ROSTER');
    const beforeAccess = indexRows(await readAccess(db), accessKey,
      'RECONCILE_DUPLICATE_CURRENT_ACCESS');
    requireCondition(sameRoster(expectedRoster, beforeRoster)
      && sameAccess(expectedAccess, beforeAccess),
    'RECONCILE_TARGET_CHANGED_SINCE_PREVIEW');

    for (const row of [...activate, ...deactivate]) {
      const result = await db.query(`UPDATE assessment.term_test_roster
        SET is_eligible = $4
        WHERE test_slug = $1 AND erp_course_class_id = $2
          AND erp_student_contact_id = $3 AND is_eligible = $5
        RETURNING 1`,
      [row.test_slug, row.class_id, row.contact_id,
        !row.is_eligible, row.is_eligible]);
      requireCondition(result.rows.length === 1, 'RECONCILE_ROSTER_WRITE_MISMATCH');
    }
    for (const row of [...enable, ...disable]) {
      const result = await db.query(`UPDATE assessment.term_test_class_access
        SET enabled = $3, updated_at = now()
        WHERE test_slug = $1 AND erp_course_class_id = $2 AND enabled = $4
        RETURNING 1`,
      [row.test_slug, row.class_id, !row.enabled, row.enabled]);
      requireCondition(result.rows.length === 1, 'RECONCILE_ACCESS_WRITE_MISMATCH');
    }
    await db.query(`INSERT INTO assessment.k56_roster_sync_checkpoint
      (source_name, last_sync_run_id) VALUES ($1, $2)
      ON CONFLICT (source_name) DO UPDATE
      SET last_sync_run_id = EXCLUDED.last_sync_run_id, updated_at = now()`,
    [SOURCE, input.syncRunId]);

    const afterRoster = indexRows(await readRoster(db), rosterKey,
      'RECONCILE_DUPLICATE_READBACK_ROSTER');
    const afterAccess = indexRows(await readAccess(db), accessKey,
      'RECONCILE_DUPLICATE_READBACK_ACCESS');
    requireCondition(afterRoster.size === expectedRoster.size
      && [...expectedRoster].every(([key, old]) => {
        const row = afterRoster.get(key);
        return row && row.student_ref === old.student_ref
          && row.student_name === old.student_name
          && row.is_eligible === members.has(memberKey(row));
      }), 'RECONCILE_ROSTER_READBACK_MISMATCH');
    requireCondition(afterAccess.size === expectedAccess.size
      && [...afterAccess].every(([key, row]) =>
        expectedAccess.has(key) && row.enabled === wantedAccess.has(key)),
    'RECONCILE_ACCESS_READBACK_MISMATCH');
    const savedRun = (await db.query(`SELECT last_sync_run_id::text AS run_id
      FROM assessment.k56_roster_sync_checkpoint WHERE source_name = $1`, [SOURCE]))
      .rows[0]?.run_id;
    requireCondition(savedRun === input.syncRunId,
      'RECONCILE_CHECKPOINT_READBACK_MISMATCH');
    await db.query('COMMIT');
    return { toolOutcome: 'success', businessOutcome: 'eligibility_readback_verified',
      syncRunId: input.syncRunId, activated: activate.length,
      deactivated: deactivate.length, classTestPairsEnabled: enable.length,
      classTestPairsDisabled: disable.length, rosterRowsPreserved: afterRoster.size };
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { /* Kết nối hỏng: phải kiểm lại đích. */ }
    throw error instanceof ReconcileError ? error
      : new ReconcileError('RECONCILE_TRANSACTION_FAILED');
  }
}

export { ReconcileError };
