// Dữ liệu nhận vào: ID lớp đã qua kiểm quyền từ API Progress Log.
// Việc chính: liệt kê bài Test có thể ghép trước khi có điểm, kèm dấu hiệu đã có roster/kết quả trong lớp.
// Kết quả: giảng viên xác nhận đúng bài Test cho từng buổi; không đọc điểm hay bài làm.
// Khi lỗi: caller báo nguồn tạm lỗi; không gửi dữ liệu học viên hoặc câu SQL ra trình duyệt.
const testSourceSql = `WITH source_rows AS (
  SELECT attempt.test_slug, attempt.erp_student_contact_id, attempt.completed_at AS result_at
  FROM assessment.term_test_attempt AS attempt
  WHERE attempt.erp_course_class_id = $1::bigint
    AND attempt.completed_at IS NOT NULL
    AND attempt.combined_result IS NOT NULL
  UNION ALL
  SELECT legacy.test_slug, legacy.erp_student_contact_id, legacy.updated_at AS result_at
  FROM assessment.mini_test_result AS legacy
  WHERE legacy.erp_course_class_id = $1::bigint
    AND legacy.result IS NOT NULL
), counted AS (
  SELECT test_slug, count(DISTINCT erp_student_contact_id)::integer AS students_with_result,
    max(result_at) AS latest_result_at
  FROM source_rows
  GROUP BY test_slug
), rostered AS (
  SELECT DISTINCT roster.test_slug
  FROM assessment.term_test_roster AS roster
  WHERE roster.erp_course_class_id = $1::bigint
)
SELECT definition.slug AS test_slug, definition.title, definition.version,
  coalesce(counted.students_with_result, 0) AS students_with_result,
  counted.latest_result_at,
  CASE WHEN counted.test_slug IS NOT NULL THEN 'result'
    WHEN rostered.test_slug IS NOT NULL THEN 'roster'
    ELSE 'definition_only' END AS class_evidence
FROM assessment.test_definition AS definition
LEFT JOIN counted ON counted.test_slug = definition.slug
LEFT JOIN rostered ON rostered.test_slug = definition.slug
WHERE (definition.slug LIKE 'term-test-%' OR definition.slug LIKE 'mini-test-%')
  AND (definition.is_active = true OR counted.test_slug IS NOT NULL OR rostered.test_slug IS NOT NULL)
ORDER BY CASE WHEN counted.test_slug IS NOT NULL THEN 0
    WHEN rostered.test_slug IS NOT NULL THEN 1 ELSE 2 END,
  counted.latest_result_at DESC NULLS LAST, definition.slug
LIMIT 100;`;

export function createLearningTestSourceReader({ pool }) {
  if (!pool) return null;
  return async classIdInput => {
    const classId = String(classIdInput);
    if (!/^\d{1,19}$/u.test(classId)) throw new Error('TEST_SOURCE_CLASS_INVALID');
    const result = await pool.query(testSourceSql, [classId]);
    if (!Array.isArray(result.rows) || result.rows.length > 100) {
      throw new Error('TEST_SOURCE_RESPONSE_INVALID');
    }
    return result.rows.map(row => {
      const count = Number(row.students_with_result);
      const version = Number(row.version);
      const latest = row.latest_result_at == null ? null : new Date(row.latest_result_at);
      if (!/^(?:term-test-[1-9]\d*|mini-test-[a-z0-9-]+)$/u.test(String(row.test_slug))
        || !Number.isInteger(count) || count < 0
        || !Number.isInteger(version) || version < 1
        || !['result', 'roster', 'definition_only'].includes(row.class_evidence)
        || (row.class_evidence === 'result' && (count < 1 || !latest))
        || (row.class_evidence !== 'result' && (count !== 0 || latest))
        || (latest && !Number.isFinite(latest.getTime()))) {
        throw new Error('TEST_SOURCE_ROW_INVALID');
      }
      return {
        testSlug: row.test_slug,
        title: String(row.title),
        definitionVersion: version,
        studentsWithResult: count,
        latestResultAt: latest?.toISOString() || null,
        classEvidence: row.class_evidence
      };
    });
  };
}
