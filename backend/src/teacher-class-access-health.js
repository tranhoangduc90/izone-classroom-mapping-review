const baseSummarySql = `WITH assignment_pairs AS (
  SELECT DISTINCT assignment.reviewer_email, course.erp_course_class_id
  FROM mapping.reviewer_class_assignment AS assignment
  JOIN mapping.reviewer_account AS reviewer
    ON reviewer.email = assignment.reviewer_email
   AND reviewer.status = 'active'
  JOIN mapping.classroom_course_mapping AS course
    ON upper(trim(course.erp_class_name_snapshot)) = upper(trim(assignment.class_name))
), unmapped_assignments AS (
  SELECT assignment.reviewer_email, assignment.class_name
  FROM mapping.reviewer_class_assignment AS assignment
  JOIN mapping.reviewer_account AS reviewer
    ON reviewer.email = assignment.reviewer_email
   AND reviewer.status = 'active'
  WHERE NOT EXISTS (
    SELECT 1
    FROM mapping.classroom_course_mapping AS course
    WHERE upper(trim(course.erp_class_name_snapshot)) = upper(trim(assignment.class_name))
  )
)
SELECT
  (SELECT count(*)::int FROM assignment_pairs) AS assignment_pairs,
  (SELECT count(*)::int FROM assignment_pairs AS expected
    WHERE NOT EXISTS (
      SELECT 1 FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = expected.reviewer_email
        AND access.erp_course_class_id = expected.erp_course_class_id
    )) AS missing_assignment_pairs,
  (SELECT count(*)::int FROM unmapped_assignments) AS unmapped_assignments,
  (SELECT count(*)::int FROM mapping.reviewer_class_access) AS materialized_pairs,
  (SELECT count(*)::int
    FROM mapping.reviewer_class_access AS access
    LEFT JOIN mapping.reviewer_account AS reviewer ON reviewer.email = access.reviewer_email
    WHERE reviewer.email IS NULL OR reviewer.status <> 'active') AS inactive_reviewer_pairs;`;

const portalSummarySql = `SELECT
  count(*) FILTER (WHERE access_source = 'portal')::int AS portal_pairs,
  count(*) FILTER (
    WHERE access_source = 'portal'
      AND (source_seen_at IS NULL OR source_seen_at < now() - ($1::int * interval '1 hour'))
  )::int AS stale_portal_pairs,
  count(*) FILTER (WHERE access_source = 'manual')::int AS manual_pairs
FROM mapping.reviewer_class_access;`;

const applyMissingSql = `INSERT INTO mapping.reviewer_class_access (
  reviewer_email, erp_course_class_id
)
SELECT DISTINCT assignment.reviewer_email, course.erp_course_class_id
FROM mapping.reviewer_class_assignment AS assignment
JOIN mapping.reviewer_account AS reviewer
  ON reviewer.email = assignment.reviewer_email
 AND reviewer.status = 'active'
JOIN mapping.classroom_course_mapping AS course
  ON upper(trim(course.erp_class_name_snapshot)) = upper(trim(assignment.class_name))
ON CONFLICT (reviewer_email, erp_course_class_id) DO NOTHING
RETURNING 1;`;

async function relationExists(query, qualifiedName) {
  const result = await query('SELECT to_regclass($1) IS NOT NULL AS exists;', [qualifiedName]);
  return Boolean(result.rows[0]?.exists);
}

async function columnExists(query, tableName, columnName) {
  const result = await query(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mapping' AND table_name = $1 AND column_name = $2
  ) AS exists;`, [tableName, columnName]);
  return Boolean(result.rows[0]?.exists);
}

async function latestCompletedRun(query, relationName) {
  if (!await relationExists(query, relationName)) return { available: false, ageHours: null };
  const result = await query(`SELECT
    max(finished_at) AS finished_at,
    CASE WHEN max(finished_at) IS NULL THEN NULL
      ELSE extract(epoch FROM (now() - max(finished_at))) / 3600
    END AS age_hours
  FROM ${relationName}
  WHERE status = 'completed';`);
  const row = result.rows[0] ?? {};
  return {
    available: true,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    ageHours: row.age_hours === null || row.age_hours === undefined ? null : Number(row.age_hours)
  };
}

function normalizeSummary(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
}

// Dữ liệu nhận vào: hàm query PostgreSQL và ngưỡng độ mới của các tiến trình đồng bộ.
// Việc chính: đối chiếu hai nguồn quyền, chỉ tự bổ sung cặp bị thiếu khi được yêu cầu.
// Kết quả: chỉ trả số đếm/timestamp vận hành; không trả email, lớp hay dữ liệu học viên.
// Khi lỗi: ném lỗi và không xóa bất kỳ quyền nào.
export async function inspectTeacherClassAccess({ query, freshnessHours = 36, applyMissing = false }) {
  if (typeof query !== 'function') throw new TypeError('query là bắt buộc.');
  if (!Number.isInteger(freshnessHours) || freshnessHours < 1 || freshnessHours > 168) {
    throw new TypeError('freshnessHours phải từ 1 đến 168.');
  }

  let appliedMissingPairs = 0;
  if (applyMissing) {
    const applied = await query(applyMissingSql);
    appliedMissingPairs = applied.rowCount ?? applied.rows.length;
  }

  const summary = normalizeSummary((await query(baseSummarySql)).rows[0]);
  const hasPortalMetadata = await columnExists(query, 'reviewer_class_access', 'access_source')
    && await columnExists(query, 'reviewer_class_access', 'source_seen_at');
  const portal = hasPortalMetadata
    ? normalizeSummary((await query(portalSummarySql, [freshnessHours])).rows[0])
    : { portal_pairs: 0, stale_portal_pairs: 0, manual_pairs: summary.materialized_pairs };
  const [mappingSync, larkReplicaSync] = await Promise.all([
    latestCompletedRun(query, 'mapping.sync_run'),
    latestCompletedRun(query, 'mapping.lark_replica_run')
  ]);

  const criticalReasons = [];
  const warningReasons = [];
  if (summary.missing_assignment_pairs > 0) criticalReasons.push('MISSING_ASSIGNMENT_PAIRS');
  if (portal.stale_portal_pairs > 0) criticalReasons.push('STALE_PORTAL_PAIRS');
  if (mappingSync.available && (mappingSync.ageHours === null || mappingSync.ageHours > freshnessHours)) {
    criticalReasons.push('MAPPING_SYNC_STALE');
  }
  if (larkReplicaSync.available && (larkReplicaSync.ageHours === null || larkReplicaSync.ageHours > freshnessHours)) {
    criticalReasons.push('LARK_REPLICA_SYNC_STALE');
  }
  if (summary.unmapped_assignments > 0) warningReasons.push('UNMAPPED_ASSIGNMENTS');
  if (summary.inactive_reviewer_pairs > 0) warningReasons.push('INACTIVE_REVIEWER_PAIRS');

  return {
    schemaVersion: 1,
    outcome: criticalReasons.length > 0 ? 'critical' : warningReasons.length > 0 ? 'attention' : 'healthy',
    checkedAt: new Date().toISOString(),
    freshnessHours,
    appliedMissingPairs,
    counts: { ...summary, ...portal },
    sync: { mapping: mappingSync, larkReplica: larkReplicaSync },
    criticalReasons,
    warningReasons
  };
}
