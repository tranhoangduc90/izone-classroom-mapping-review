// Đọc các phiếu mà giảng viên được phép xem; mọi tham số đều truyền riêng khỏi câu SQL.
export const listReviewsSql = `WITH input AS (
  SELECT
    $1::bigint AS class_id,
    $2::text AS requested_status,
    $3::text AS reviewer_email,
    $4::boolean AS can_access_all_classes
),
filtered AS (
  SELECT
    r.*,
    cm.erp_class_name_snapshot,
    current_roster.classroom_name_snapshot AS current_classroom_name,
    current_roster.classroom_email_snapshot AS current_classroom_email
  FROM mapping.student_mapping_review AS r
  JOIN mapping.classroom_course_mapping AS cm
    ON cm.erp_course_class_id = r.erp_course_class_id
  LEFT JOIN mapping.classroom_roster_snapshot AS current_roster
    ON current_roster.classroom_course_id = r.classroom_course_id
   AND current_roster.classroom_user_id = r.classroom_user_id
   AND current_roster.roster_state = 'active'
  CROSS JOIN input
  WHERE (input.class_id IS NULL OR r.erp_course_class_id = input.class_id)
    AND (input.requested_status = 'all' OR r.status = input.requested_status)
    AND (
      input.can_access_all_classes
      OR EXISTS (
        SELECT 1
        FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = input.reviewer_email
          AND access.erp_course_class_id = r.erp_course_class_id
      )
    )
),
items AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', filtered.public_id::text,
      'classId', filtered.erp_course_class_id::text,
      'className', filtered.erp_class_name_snapshot,
      'erpStudentId', filtered.erp_student_contact_id::text,
      'erpStudentName', filtered.erp_student_name_snapshot,
      'classroomCourseId', filtered.classroom_course_id,
      'classroomUserId', filtered.classroom_user_id,
      'classroomName', COALESCE(filtered.current_classroom_name, filtered.classroom_name_snapshot),
      'classroomEmail', COALESCE(filtered.current_classroom_email, filtered.classroom_email_snapshot),
      'confidence', COALESCE(filtered.ai_score, 0),
      'reason', filtered.ai_reason,
      'status', filtered.status,
      'candidates', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'userId', roster.classroom_user_id,
            'fullName', roster.classroom_name_snapshot,
            'email', roster.classroom_email_snapshot
          ) ORDER BY roster.classroom_name_snapshot, roster.classroom_email_snapshot
        )
        FROM mapping.classroom_roster_snapshot AS roster
        WHERE roster.classroom_course_id = filtered.classroom_course_id
          AND roster.roster_state = 'active'
      ), '[]'::jsonb)
    ) ORDER BY filtered.erp_class_name_snapshot, filtered.erp_student_name_snapshot
  ) AS data
  FROM filtered
)
SELECT jsonb_build_object(
  'ok', true,
  'items', COALESCE(items.data, '[]'::jsonb)
) AS response
FROM items;`;

// Ghi một quyết định duyệt trong transaction; email người duyệt lấy từ token đã xác thực.
export const writeDecisionSql = `WITH input AS (
  SELECT
    $1::uuid AS review_id,
    $2::text AS decision,
    $3::text AS requested_google_user_id,
    $4::text AS note,
    $5::text AS reviewer_email,
    $6::boolean AS can_access_all_classes
),
target AS (
  SELECT
    r.*,
    input.decision,
    input.requested_google_user_id,
    input.note,
    input.reviewer_email AS acting_reviewer_email,
    CASE
      WHEN input.decision = 'approve' THEN r.classroom_user_id
      WHEN input.decision IN ('choose_another', 'edit_mapping') THEN input.requested_google_user_id
      ELSE NULL
    END AS selected_google_user_id
  FROM mapping.student_mapping_review AS r
  CROSS JOIN input
  WHERE r.public_id = input.review_id
    AND (
      input.can_access_all_classes
      OR EXISTS (
        SELECT 1
        FROM mapping.reviewer_class_access AS access
        WHERE access.reviewer_email = input.reviewer_email
          AND access.erp_course_class_id = r.erp_course_class_id
      )
    )
    AND (
      (r.status = 'pending_review' AND input.decision IN ('approve', 'reject', 'choose_another'))
      OR (r.status IN ('approved', 'rejected') AND input.decision = 'reopen')
      OR (r.status = 'approved' AND input.decision = 'edit_mapping')
    )
  FOR UPDATE OF r
),
selected_roster AS (
  SELECT
    target.*,
    roster.classroom_name_snapshot AS selected_google_name,
    roster.classroom_email_snapshot AS selected_google_email,
    CASE
      WHEN target.decision IN ('reject', 'reopen') THEN true
      WHEN target.decision IN ('approve', 'choose_another', 'edit_mapping')
        AND roster.classroom_user_id IS NOT NULL THEN true
      ELSE false
    END AS candidate_is_valid
  FROM target
  LEFT JOIN mapping.classroom_roster_snapshot AS roster
    ON roster.classroom_course_id = target.classroom_course_id
   AND roster.classroom_user_id = target.selected_google_user_id
   AND roster.roster_state = 'active'
),
validated AS (
  SELECT
    selected_roster.*,
    NOT EXISTS (
      SELECT 1
      FROM mapping.student_identity_mapping AS existing
      WHERE existing.google_user_id = selected_roster.selected_google_user_id
        AND existing.erp_student_contact_id <> selected_roster.erp_student_contact_id
    ) AS google_user_is_available
  FROM selected_roster
),
accepted AS (
  SELECT *
  FROM validated
  WHERE candidate_is_valid
    AND (decision IN ('reject', 'reopen') OR google_user_is_available)
),
decision_event AS (
  INSERT INTO mapping.mapping_decision_event (
    review_id,
    decision,
    selected_google_user_id,
    reviewer_email,
    note
  )
  SELECT
    id,
    decision,
    selected_google_user_id,
    acting_reviewer_email,
    note
  FROM accepted
  RETURNING id
),
updated_review AS (
  UPDATE mapping.student_mapping_review AS review
  SET
    classroom_user_id = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.classroom_user_id ELSE accepted.selected_google_user_id END,
    classroom_name_snapshot = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.classroom_name_snapshot ELSE accepted.selected_google_name END,
    classroom_email_snapshot = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.classroom_email_snapshot ELSE accepted.selected_google_email END,
    match_method = CASE WHEN accepted.decision IN ('reject', 'reopen') THEN review.match_method ELSE 'teacher_confirmed' END,
    status = CASE
      WHEN accepted.decision = 'reject' THEN 'rejected'
      WHEN accepted.decision = 'reopen' THEN 'pending_review'
      ELSE 'approved'
    END,
    reviewer_email = CASE WHEN accepted.decision = 'reopen' THEN NULL ELSE accepted.acting_reviewer_email END,
    reviewer_note = CASE WHEN accepted.decision = 'reopen' THEN NULL ELSE accepted.note END,
    decided_at = CASE WHEN accepted.decision = 'reopen' THEN NULL ELSE now() END,
    updated_at = now()
  FROM accepted
  WHERE review.id = accepted.id
  RETURNING review.*
),
upsert_mapping AS (
  INSERT INTO mapping.student_identity_mapping (
    erp_student_contact_id,
    google_user_id,
    google_email_snapshot,
    erp_name_snapshot,
    google_name_snapshot,
    status,
    match_method,
    approved_by,
    approved_at,
    last_seen_at,
    updated_at
  )
  SELECT
    accepted.erp_student_contact_id,
    accepted.selected_google_user_id,
    accepted.selected_google_email,
    accepted.erp_student_name_snapshot,
    accepted.selected_google_name,
    'approved',
    'teacher_confirmed',
    accepted.acting_reviewer_email,
    now(),
    now(),
    now()
  FROM accepted
  WHERE accepted.decision IN ('approve', 'choose_another', 'edit_mapping')
  ON CONFLICT (erp_student_contact_id) DO UPDATE SET
    google_user_id = EXCLUDED.google_user_id,
    google_email_snapshot = EXCLUDED.google_email_snapshot,
    erp_name_snapshot = EXCLUDED.erp_name_snapshot,
    google_name_snapshot = EXCLUDED.google_name_snapshot,
    status = 'approved',
    match_method = 'teacher_confirmed',
    approved_by = EXCLUDED.approved_by,
    approved_at = now(),
    last_seen_at = now(),
    updated_at = now()
  RETURNING id
),
deactivate_reopened_mapping AS (
  UPDATE mapping.student_identity_mapping AS identity
  SET status = 'inactive', updated_at = now()
  FROM accepted
  WHERE accepted.decision = 'reopen'
    AND identity.erp_student_contact_id = accepted.erp_student_contact_id
  RETURNING identity.id
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM target) THEN jsonb_build_object(
    'ok', false,
    'error', 'REVIEW_NOT_FOUND',
    'message', 'Phiếu duyệt không tồn tại, không thuộc quyền truy cập hoặc đã được xử lý.'
  )
  WHEN EXISTS (SELECT 1 FROM validated WHERE NOT candidate_is_valid) THEN jsonb_build_object(
    'ok', false,
    'error', 'INVALID_CLASSROOM_USER',
    'message', 'Tài khoản Google không thuộc roster hiện tại của lớp.'
  )
  WHEN EXISTS (SELECT 1 FROM validated WHERE decision NOT IN ('reject', 'reopen') AND NOT google_user_is_available) THEN jsonb_build_object(
    'ok', false,
    'error', 'GOOGLE_ACCOUNT_ALREADY_MAPPED',
    'message', 'Tài khoản Google này đã được duyệt cho học viên khác.'
  )
  ELSE jsonb_build_object(
    'ok', true,
    'reviewId', (SELECT public_id::text FROM updated_review LIMIT 1),
    'status', (SELECT status FROM updated_review LIMIT 1),
    'mappingId', (SELECT id::text FROM upsert_mapping LIMIT 1),
    'reopenedMappingId', (SELECT id::text FROM deactivate_reopened_mapping LIMIT 1),
    'decidedAt', now()
  )
END AS response;`;

// Danh sách công khai chỉ trả tên và UUID ngẫu nhiên của phiếu; không trả ID ERP, email hoặc đáp án.
export const listTermTestRosterSql = `WITH definition AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE slug = $2
    AND is_active = true
),
target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
roster_mode AS (
  SELECT EXISTS (
    SELECT 1
    FROM assessment.term_test_roster AS roster
    JOIN target_classes AS target
      ON target.erp_course_class_id = roster.erp_course_class_id
    WHERE roster.test_slug = $2
  ) AS has_curated_roster
),
students AS (
  SELECT
    roster.student_ref::text AS student_ref,
    roster.student_name_snapshot AS student_name
  FROM assessment.term_test_roster AS roster
  JOIN target_classes AS target
    ON target.erp_course_class_id = roster.erp_course_class_id
  WHERE roster.test_slug = $2

  UNION ALL

  SELECT
    review.public_id::text AS student_ref,
    review.erp_student_name_snapshot AS student_name
  FROM mapping.student_mapping_review AS review
  JOIN target_classes AS target
    ON target.erp_course_class_id = review.erp_course_class_id
  CROSS JOIN roster_mode
  WHERE roster_mode.has_curated_roster = false
    AND review.status <> 'superseded'
)
SELECT
  definition.slug AS test_slug,
  definition.title AS test_title,
  definition.version AS definition_version,
  (SELECT count(*)::int FROM target_classes) AS class_count,
  (SELECT erp_course_class_id::text FROM target_classes LIMIT 1) AS class_id,
  (SELECT erp_class_name_snapshot FROM target_classes LIMIT 1) AS class_name,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('ref', students.student_ref, 'name', students.student_name)
      ORDER BY students.student_name
    )
    FROM students
  ), '[]'::jsonb) AS students
FROM definition;`;

// Xác minh học viên thuộc roster riêng; nếu lớp chưa có roster riêng thì dùng matching database.
export const findStudentForTermTestSql = `WITH target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
roster_mode AS (
  SELECT EXISTS (
    SELECT 1
    FROM assessment.term_test_roster AS roster
    JOIN target_classes AS target
      ON target.erp_course_class_id = roster.erp_course_class_id
    WHERE roster.test_slug = $2
  ) AS has_curated_roster
),
eligible_student AS (
  SELECT
    roster.erp_course_class_id,
    roster.erp_student_contact_id,
    roster.student_name_snapshot AS student_name
  FROM assessment.term_test_roster AS roster
  JOIN target_classes AS target
    ON target.erp_course_class_id = roster.erp_course_class_id
  WHERE roster.test_slug = $2
    AND roster.student_ref = $3::uuid

  UNION ALL

  SELECT
    review.erp_course_class_id,
    review.erp_student_contact_id,
    review.erp_student_name_snapshot AS student_name
  FROM mapping.student_mapping_review AS review
  JOIN target_classes AS target
    ON target.erp_course_class_id = review.erp_course_class_id
  CROSS JOIN roster_mode
  WHERE roster_mode.has_curated_roster = false
    AND review.public_id = $3::uuid
    AND review.status <> 'superseded'
)
SELECT
  definition.slug AS test_slug,
  definition.title AS test_title,
  definition.version AS definition_version,
  definition.listening_band_adjustment,
  definition.listening_definition,
  definition.reading_definition,
  student.erp_course_class_id::text AS class_id,
  target.erp_class_name_snapshot AS class_name,
  student.erp_student_contact_id::text AS student_id,
  student.student_name
FROM assessment.test_definition AS definition
JOIN eligible_student AS student ON true
JOIN target_classes AS target
  ON target.erp_course_class_id = student.erp_course_class_id
WHERE definition.slug = $2
  AND definition.is_active = true;`;

// client_submission_id giúp lần gửi lại do mạng chập chờn không tạo thêm lượt làm.
export const insertListeningAttemptSql = `WITH inserted AS (
  INSERT INTO assessment.term_test_attempt (
    client_submission_id,
    test_slug,
    definition_version,
    erp_course_class_id,
    class_name_snapshot,
    erp_student_contact_id,
    student_name_snapshot,
    listening_answers,
    listening_result,
    listening_submitted_at
  ) VALUES (
    $1::uuid, $2, $3::int, $4::bigint, $5, $6::bigint, $7,
    $8::jsonb, $9::jsonb, now()
  )
  ON CONFLICT (test_slug, client_submission_id) DO NOTHING
  RETURNING *
),
resolved AS (
  SELECT * FROM inserted
  UNION ALL
  SELECT existing.*
  FROM assessment.term_test_attempt AS existing
  WHERE existing.test_slug = $2
    AND existing.client_submission_id = $1::uuid
    AND NOT EXISTS (SELECT 1 FROM inserted)
)
SELECT
  id::text AS attempt_token,
  test_slug,
  erp_course_class_id::text AS class_id,
  erp_student_contact_id::text AS student_id,
  student_name_snapshot AS student_name,
  listening_submitted_at,
  completed_at
FROM resolved
LIMIT 1;`;

export const findAttemptForReadingSql = `SELECT
  attempt.id::text AS attempt_token,
  attempt.test_slug,
  attempt.definition_version,
  attempt.erp_course_class_id::text AS class_id,
  attempt.class_name_snapshot AS class_name,
  attempt.erp_student_contact_id::text AS student_id,
  attempt.student_name_snapshot AS student_name,
  attempt.listening_result,
  attempt.completed_at,
  attempt.combined_result,
  definition.slug,
  definition.title AS test_title,
  definition.version,
  definition.listening_band_adjustment,
  definition.listening_definition,
  definition.reading_definition
FROM assessment.term_test_attempt AS attempt
JOIN assessment.test_definition AS definition
  ON definition.slug = attempt.test_slug
 AND definition.version = attempt.definition_version
WHERE attempt.id = $1::uuid
  AND attempt.test_slug = $2;`;

export const completeReadingAttemptSql = `WITH updated AS (
  UPDATE assessment.term_test_attempt
  SET
    reading_answers = $2::jsonb,
    reading_result = $3::jsonb,
    combined_result = $4::jsonb,
    reading_submitted_at = now(),
    completed_at = now(),
    updated_at = now()
  WHERE id = $1::uuid
    AND completed_at IS NULL
  RETURNING *
),
resolved AS (
  SELECT * FROM updated
  UNION ALL
  SELECT existing.*
  FROM assessment.term_test_attempt AS existing
  WHERE existing.id = $1::uuid
    AND NOT EXISTS (SELECT 1 FROM updated)
)
SELECT id::text AS attempt_token, completed_at, combined_result
FROM resolved
LIMIT 1;`;

export const fetchTermTestResultSql = `SELECT
  id::text AS attempt_token,
  test_slug,
  erp_course_class_id::text AS class_id,
  erp_student_contact_id::text AS student_id,
  class_name_snapshot AS class_name,
  student_name_snapshot AS student_name,
  listening_submitted_at,
  reading_submitted_at,
  completed_at,
  combined_result
FROM assessment.term_test_attempt
WHERE id = $1::uuid
  AND completed_at IS NOT NULL;`;

// Danh sách lớp và bài test chỉ gồm phạm vi mà giảng viên đã được cấp quyền.
export const listTermTestTeacherOptionsSql = `WITH allowed_classes AS (
  SELECT
    course.erp_course_class_id::text AS class_id,
    course.erp_class_name_snapshot AS class_name
  FROM mapping.classroom_course_mapping AS course
  WHERE $2::boolean
    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $1
        AND access.erp_course_class_id = course.erp_course_class_id
    )
),
active_tests AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE is_active = true
)
SELECT jsonb_build_object(
  'classes', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('id', class_id, 'name', class_name)
      ORDER BY class_name
    )
    FROM allowed_classes
  ), '[]'::jsonb),
  'tests', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object('slug', slug, 'title', title, 'version', version)
      ORDER BY slug
    )
    FROM active_tests
  ), '[]'::jsonb)
) AS response;`;

// Trả kết quả mới nhất đã hoàn thành của từng học viên; nếu chưa có thì giữ trạng thái để tổng quan không bỏ sót học viên.
export const listTermTestTeacherResultsSql = `WITH definition AS (
  SELECT slug, title, version
  FROM assessment.test_definition
  WHERE slug = $2
    AND is_active = true
),
target_classes AS (
  SELECT erp_course_class_id, erp_class_name_snapshot
  FROM mapping.classroom_course_mapping
  WHERE upper(trim(erp_class_name_snapshot)) = upper(trim($1))
),
authorized_classes AS (
  SELECT target.*
  FROM target_classes AS target
  WHERE $4::boolean
    OR EXISTS (
      SELECT 1
      FROM mapping.reviewer_class_access AS access
      WHERE access.reviewer_email = $3
        AND access.erp_course_class_id = target.erp_course_class_id
    )
),
roster_mode AS (
  SELECT EXISTS (
    SELECT 1
    FROM assessment.term_test_roster AS roster
    JOIN authorized_classes AS target
      ON target.erp_course_class_id = roster.erp_course_class_id
    WHERE roster.test_slug = $2
  ) AS has_curated_roster
),
eligible_students AS (
  SELECT
    roster.erp_course_class_id,
    roster.erp_student_contact_id,
    roster.student_ref,
    roster.student_name_snapshot AS student_name
  FROM assessment.term_test_roster AS roster
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = roster.erp_course_class_id
  WHERE roster.test_slug = $2

  UNION ALL

  SELECT
    review.erp_course_class_id,
    review.erp_student_contact_id,
    review.public_id AS student_ref,
    review.erp_student_name_snapshot AS student_name
  FROM mapping.student_mapping_review AS review
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = review.erp_course_class_id
  CROSS JOIN roster_mode
  WHERE roster_mode.has_curated_roster = false
    AND review.status <> 'superseded'

  UNION ALL

  SELECT
    legacy.erp_course_class_id,
    legacy.erp_student_contact_id,
    review.public_id AS student_ref,
    legacy.student_name_snapshot AS student_name
  FROM assessment.mini_test_result AS legacy
  JOIN authorized_classes AS target
    ON target.erp_course_class_id = legacy.erp_course_class_id
  JOIN mapping.student_mapping_review AS review
    ON review.erp_course_class_id = legacy.erp_course_class_id
   AND review.erp_student_contact_id = legacy.erp_student_contact_id
  WHERE legacy.test_slug = $2
),
students AS (
  SELECT DISTINCT ON (erp_course_class_id, erp_student_contact_id)
    erp_course_class_id,
    erp_student_contact_id,
    student_ref,
    student_name
  FROM eligible_students
  ORDER BY erp_course_class_id, erp_student_contact_id, student_name
)
SELECT
  definition.slug AS test_slug,
  definition.title AS test_title,
  definition.version AS definition_version,
  (SELECT count(*)::int FROM target_classes) AS class_count,
  (SELECT count(*)::int FROM authorized_classes) AS authorized_class_count,
  (SELECT erp_course_class_id::text FROM authorized_classes LIMIT 1) AS class_id,
  (SELECT erp_class_name_snapshot FROM authorized_classes LIMIT 1) AS class_name,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'ref', student.student_ref::text,
        'name', student.student_name,
        'status', CASE
          WHEN attempt.completed_at IS NOT NULL AND attempt.combined_result IS NOT NULL THEN 'completed'
          WHEN attempt.id IS NOT NULL THEN 'incomplete'
          ELSE 'not_started'
        END,
        'completedAt', attempt.completed_at,
        'result', attempt.combined_result
      )
      ORDER BY student.student_name
    )
    FROM students AS student
    LEFT JOIN LATERAL (
      SELECT candidate.id, candidate.completed_at, candidate.combined_result, candidate.created_at
      FROM (
        SELECT
          stored.id,
          stored.completed_at,
          stored.combined_result,
          stored.created_at
        FROM assessment.term_test_attempt AS stored
        WHERE stored.test_slug = definition.slug
          AND stored.erp_course_class_id = student.erp_course_class_id
          AND stored.erp_student_contact_id = student.erp_student_contact_id

        UNION ALL

        SELECT
          legacy.id,
          legacy.updated_at AS completed_at,
          jsonb_set(
            jsonb_set(legacy.result, '{testTitle}', to_jsonb(definition.title), true),
            '{definitionVersion}',
            to_jsonb(definition.version),
            true
          ) AS combined_result,
          legacy.created_at
        FROM assessment.mini_test_result AS legacy
        WHERE legacy.test_slug = definition.slug
          AND legacy.erp_course_class_id = student.erp_course_class_id
          AND legacy.erp_student_contact_id = student.erp_student_contact_id
      ) AS candidate
      ORDER BY candidate.completed_at DESC NULLS LAST, candidate.created_at DESC
      LIMIT 1
    ) AS attempt ON true
  ), '[]'::jsonb) AS students
FROM definition;`;

// Mini Test dùng danh sách ERP lịch sử để vẫn nhận diện được học viên đã chuyển/nghỉ sau buổi kiểm tra.
export const findStudentForMiniTestSql = `SELECT
  student.erp_course_class_id::text AS class_id,
  student.class_name,
  student.erp_student_contact_id::text AS student_id,
  student.student_name
FROM assessment.mini_test_student_lookup AS student
WHERE upper(trim(student.class_name)) = upper(trim($1))
  AND lower(regexp_replace(trim(student.student_name), '\\s+', ' ', 'g')) =
      lower(regexp_replace(trim($2), '\\s+', ' ', 'g'));`;

// Cùng một phản hồi được cập nhật tại chỗ khi Apps Script chạy lại, không tạo bản ghi trùng.
export const upsertMiniTestResultSql = `INSERT INTO assessment.mini_test_result (
  source_submission_key,
  test_slug,
  erp_course_class_id,
  class_name_snapshot,
  erp_student_contact_id,
  student_name_snapshot,
  source_submitted_at,
  listening_correct,
  reading_correct,
  result
) VALUES (
  $1, $2, $3::bigint, $4, $5::bigint, $6, NULLIF($7, ''), $8::smallint, $9::smallint, $10::jsonb
)
ON CONFLICT (test_slug, source_submission_key) DO UPDATE SET
  erp_course_class_id = EXCLUDED.erp_course_class_id,
  class_name_snapshot = EXCLUDED.class_name_snapshot,
  erp_student_contact_id = EXCLUDED.erp_student_contact_id,
  student_name_snapshot = EXCLUDED.student_name_snapshot,
  source_submitted_at = EXCLUDED.source_submitted_at,
  listening_correct = EXCLUDED.listening_correct,
  reading_correct = EXCLUDED.reading_correct,
  result = EXCLUDED.result,
  updated_at = now()
RETURNING id::text AS result_id, updated_at;`;
