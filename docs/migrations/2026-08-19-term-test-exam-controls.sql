-- Dữ liệu nhận vào: các lượt Term Test hiện có; migration không sửa điểm hay bài làm đã nộp.
-- Việc chính: thêm phiên chuẩn bị Listening, hạn giờ máy chủ và vùng lưu nháp trước hạn.
-- Kết quả: máy chủ có thể khóa đúng nội dung ở thời điểm hết giờ dù trình duyệt mất mạng.
-- Khi lỗi: toàn bộ thay đổi rollback trong transaction, không để schema ở trạng thái dở dang.

BEGIN;

CREATE TABLE IF NOT EXISTS assessment.term_test_exam_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_slug TEXT NOT NULL REFERENCES assessment.test_definition(slug),
  definition_version INTEGER NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  listening_resume_offset_seconds INTEGER NOT NULL DEFAULT 0,
  listening_started_at TIMESTAMPTZ,
  listening_deadline_at TIMESTAMPTZ,
  listening_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  listening_draft_updated_at TIMESTAMPTZ,
  listening_submitted_at TIMESTAMPTZ,
  attempt_id UUID UNIQUE REFERENCES assessment.term_test_attempt(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT term_test_exam_session_listening_order_check CHECK (
    (listening_started_at IS NULL AND listening_deadline_at IS NULL AND listening_submitted_at IS NULL)
    OR
    (
      listening_started_at IS NOT NULL
      AND listening_deadline_at > listening_started_at
      AND (listening_submitted_at IS NULL OR listening_submitted_at >= listening_started_at)
    )
  )
);

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN IF NOT EXISTS listening_resume_offset_seconds INTEGER NOT NULL DEFAULT 0;

ALTER TABLE assessment.term_test_exam_session
  DROP CONSTRAINT IF EXISTS term_test_exam_session_listening_resume_offset_check;

ALTER TABLE assessment.term_test_exam_session
  ADD CONSTRAINT term_test_exam_session_listening_resume_offset_check CHECK (
    listening_resume_offset_seconds BETWEEN 0 AND 1844
  );

ALTER TABLE assessment.term_test_attempt
  ADD COLUMN IF NOT EXISTS exam_session_id UUID UNIQUE REFERENCES assessment.term_test_exam_session(id),
  ADD COLUMN IF NOT EXISTS reading_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reading_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reading_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reading_draft_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS writing_deadline_at TIMESTAMPTZ;

ALTER TABLE assessment.term_test_attempt
  DROP CONSTRAINT IF EXISTS term_test_attempt_section_deadline_check;

ALTER TABLE assessment.term_test_attempt
  ADD CONSTRAINT term_test_attempt_section_deadline_check CHECK (
    (reading_started_at IS NULL AND reading_deadline_at IS NULL)
    OR (reading_started_at IS NOT NULL AND reading_deadline_at > reading_started_at)
  );

CREATE INDEX IF NOT EXISTS idx_term_test_exam_session_lookup
  ON assessment.term_test_exam_session (test_slug, id, prepared_at DESC);

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_exam_session TO mapping_review_api;
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_attempt TO mapping_review_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_exam_session TO mapping_app;
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_attempt TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
