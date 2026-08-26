ALTER TABLE assessment.term_test_attempt
  ADD COLUMN IF NOT EXISTS reading_draft_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN IF NOT EXISTS listening_draft_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

WITH ranked_active_sessions AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY test_slug, definition_version, erp_course_class_id, erp_student_contact_id
      ORDER BY
        (listening_draft_updated_at IS NOT NULL) DESC,
        listening_draft_updated_at DESC NULLS LAST,
        listening_started_at DESC NULLS LAST,
        prepared_at DESC
    ) AS active_rank
  FROM assessment.term_test_exam_session
  WHERE listening_submitted_at IS NULL
    AND superseded_at IS NULL
)
UPDATE assessment.term_test_exam_session AS session
SET
  superseded_at = now(),
  updated_at = now()
FROM ranked_active_sessions AS ranked
WHERE ranked.id = session.id
  AND ranked.active_rank > 1;

-- Dữ liệu vào: các lượt cũ chưa hoàn tất của cùng một học viên và cùng phiên bản đề.
-- Việc chính: giữ lượt có tiến độ Reading mới nhất, đánh dấu các lượt trùng cũ là đã được thay thế.
-- Kết quả: mỗi học viên chỉ còn một lượt đang dở để resume; không xóa bài hay nội dung đã lưu.
-- Khi lỗi: migration runner rollback toàn bộ transaction nên production không ở trạng thái nửa chừng.
WITH ranked_active_attempts AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY test_slug, definition_version, erp_course_class_id, erp_student_contact_id
      ORDER BY
        (reading_draft_updated_at IS NOT NULL) DESC,
        reading_draft_updated_at DESC NULLS LAST,
        reading_started_at DESC NULLS LAST,
        listening_submitted_at DESC,
        created_at DESC
    ) AS active_rank
  FROM assessment.term_test_attempt
  WHERE completed_at IS NULL
    AND superseded_at IS NULL
)
UPDATE assessment.term_test_attempt AS attempt
SET
  superseded_at = now(),
  updated_at = now()
FROM ranked_active_attempts AS ranked
WHERE ranked.id = attempt.id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_term_test_attempt_one_active_student
  ON assessment.term_test_attempt (
    test_slug,
    definition_version,
    erp_course_class_id,
    erp_student_contact_id
  )
  WHERE completed_at IS NULL AND superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_term_test_exam_session_one_active_student
  ON assessment.term_test_exam_session (
    test_slug,
    definition_version,
    erp_course_class_id,
    erp_student_contact_id
  )
  WHERE listening_submitted_at IS NULL AND superseded_at IS NULL;
