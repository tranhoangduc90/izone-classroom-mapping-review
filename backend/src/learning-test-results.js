// Dữ liệu nhận vào: lớp, học viên và các mã bài Test đã được giảng viên ghép vào buổi.
// Việc chính: nối định danh học viên với kho bài thi và lấy bản hoàn tất mới nhất.
// Kết quả: chỉ điểm tóm tắt Listening/Reading; Writing chỉ hiện khi bản chấm cuối đã sẵn sàng.
// Khi lỗi hoặc định danh không duy nhất: không trả điểm; caller giữ Journey và báo nguồn tạm lỗi.
const resultSql = `WITH requested AS (
  SELECT DISTINCT unnest($3::text[]) AS test_slug
), candidate_identity AS (
  SELECT requested.test_slug, roster.erp_student_contact_id
  FROM requested
  JOIN assessment.term_test_roster AS roster
    ON roster.test_slug = requested.test_slug
   AND roster.erp_course_class_id = $1::bigint
   AND roster.student_ref = $2::uuid
  UNION ALL
  SELECT requested.test_slug, review.erp_student_contact_id
  FROM requested
  JOIN mapping.student_mapping_review AS review
    ON review.erp_course_class_id = $1::bigint
   AND review.public_id = $2::uuid
   AND review.status <> 'superseded'
  UNION ALL
  SELECT requested.test_slug, -temporary.temporary_student_id
  FROM requested
  JOIN assessment.term_test_temporary_student AS temporary
    ON temporary.test_slug = requested.test_slug
   AND temporary.erp_course_class_id = $1::bigint
   AND temporary.student_ref = $2::uuid
   AND temporary.active = true
), unique_identity AS (
  SELECT test_slug, min(erp_student_contact_id) AS erp_student_contact_id
  FROM candidate_identity
  GROUP BY test_slug
  HAVING count(DISTINCT erp_student_contact_id) = 1
), source_rows AS (
  SELECT attempt.test_slug, definition.title, attempt.combined_result AS result_json,
    attempt.completed_at AS completed_at, attempt.writing_submitted_at,
    CASE WHEN final.status = 'ready' THEN final.writing_score ELSE NULL END AS writing_score,
    1 AS source_priority
  FROM unique_identity AS identity
  JOIN assessment.term_test_attempt AS attempt
    ON attempt.test_slug = identity.test_slug
   AND attempt.erp_course_class_id = $1::bigint
   AND attempt.erp_student_contact_id = identity.erp_student_contact_id
  JOIN assessment.test_definition AS definition ON definition.slug = attempt.test_slug
  LEFT JOIN assessment.term_test_writing_grading_final AS final ON final.attempt_id = attempt.id
  WHERE attempt.completed_at IS NOT NULL AND attempt.combined_result IS NOT NULL
  UNION ALL
  SELECT legacy.test_slug, definition.title, legacy.result AS result_json,
    legacy.updated_at AS completed_at, NULL::timestamptz AS writing_submitted_at,
    NULL::numeric AS writing_score, 0 AS source_priority
  FROM unique_identity AS identity
  JOIN assessment.mini_test_result AS legacy
    ON legacy.test_slug = identity.test_slug
   AND legacy.erp_course_class_id = $1::bigint
   AND legacy.erp_student_contact_id = identity.erp_student_contact_id
  JOIN assessment.test_definition AS definition ON definition.slug = legacy.test_slug
  WHERE legacy.result IS NOT NULL
), ranked AS (
  SELECT source_rows.*,
    row_number() OVER (PARTITION BY test_slug
      ORDER BY completed_at DESC, source_priority DESC) AS rank
  FROM source_rows
)
SELECT test_slug, title, result_json, completed_at, writing_submitted_at, writing_score
FROM ranked WHERE rank = 1;`;

function sectionScore(section) {
  if (!section || typeof section !== 'object') return null;
  const correct = Number(section.correct);
  const total = Number(section.total);
  if (!Number.isInteger(correct) || !Number.isInteger(total)
    || total < 1 || correct < 0 || correct > total) return null;
  const band = section.band;
  return { correct, total,
    band: typeof band === 'number' && Number.isFinite(band) && band >= 0 && band <= 9
      ? band : band === '<2.5' ? band : null };
}

export function createLearningTestResultReader({ pool }) {
  if (!pool) return null;
  return async ({ classId: rawClassId, studentRef, testSlugs }) => {
    const classId = String(rawClassId);
    if (!/^\d{1,19}$/u.test(classId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(studentRef)
      || !Array.isArray(testSlugs) || testSlugs.length > 100
      || testSlugs.some(slug => !/^(?:term-test-[1-9]\d*|mini-test-[a-z0-9-]+)$/u.test(slug))) {
      throw new Error('TEST_RESULT_INPUT_INVALID');
    }
    if (!testSlugs.length) return [];
    const result = await pool.query(resultSql, [classId, studentRef, testSlugs]);
    if (!Array.isArray(result.rows) || result.rows.length > testSlugs.length) {
      throw new Error('TEST_RESULT_RESPONSE_INVALID');
    }
    const allowed = new Set(testSlugs);
    return result.rows.map(row => {
      if (!allowed.has(row.test_slug)) throw new Error('TEST_RESULT_ROW_INVALID');
      const data = row.result_json;
      const completed = new Date(row.completed_at);
      if (!data || typeof data !== 'object' || !Number.isFinite(completed.getTime())) {
        throw new Error('TEST_RESULT_ROW_INVALID');
      }
      const writingScore = row.writing_score == null ? null : Number(row.writing_score);
      if (writingScore !== null && (!Number.isFinite(writingScore)
        || writingScore < 0 || writingScore > 9)) throw new Error('TEST_RESULT_ROW_INVALID');
      return {
        testSlug: row.test_slug,
        title: String(row.title || 'Buổi Test'),
        completedAt: completed.toISOString(),
        listening: sectionScore(data.listening),
        reading: sectionScore(data.reading),
        writing: row.test_slug.startsWith('term-test-')
          ? { status: writingScore !== null ? 'ready'
            : row.writing_submitted_at ? 'pending' : 'not_submitted',
          score: writingScore } : null
      };
    });
  };
}
