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
