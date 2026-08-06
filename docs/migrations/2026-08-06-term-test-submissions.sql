-- Mục đích: lưu bài Listening/Reading và kết quả phân tích trong database tích hợp.
-- Dữ liệu nhận vào: định nghĩa đề được seed riêng trên VPS; repo công khai không chứa đáp án đúng.
-- Kết quả: mỗi lượt làm có UUID ngẫu nhiên, snapshot lớp/học viên và kết quả JSONB để truy vấn lại.
-- Lỗi: chạy trong transaction; bất kỳ lỗi nào cũng rollback toàn bộ migration.

BEGIN;

CREATE SCHEMA IF NOT EXISTS assessment;

CREATE TABLE IF NOT EXISTS assessment.test_definition (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  listening_band_adjustment NUMERIC(3, 1) NOT NULL DEFAULT 0
    CHECK (listening_band_adjustment BETWEEN -1 AND 1),
  listening_definition JSONB NOT NULL,
  reading_definition JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT test_definition_slug_check
    CHECK (slug ~ '^term-test-[1-9][0-9]*$')
);

CREATE TABLE IF NOT EXISTS assessment.term_test_roster (
  test_slug TEXT NOT NULL REFERENCES assessment.test_definition(slug) ON DELETE CASCADE,
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (test_slug, erp_course_class_id, erp_student_contact_id),
  UNIQUE (test_slug, student_ref)
);

CREATE TABLE IF NOT EXISTS assessment.term_test_attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_submission_id UUID NOT NULL,
  test_slug TEXT NOT NULL REFERENCES assessment.test_definition(slug),
  definition_version INTEGER NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  listening_answers JSONB NOT NULL,
  listening_result JSONB NOT NULL,
  listening_submitted_at TIMESTAMPTZ NOT NULL,
  reading_answers JSONB,
  reading_result JSONB,
  combined_result JSONB,
  reading_submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (test_slug, client_submission_id),
  CONSTRAINT term_test_attempt_completion_check CHECK (
    (completed_at IS NULL AND reading_answers IS NULL AND reading_result IS NULL AND combined_result IS NULL)
    OR
    (completed_at IS NOT NULL AND reading_answers IS NOT NULL AND reading_result IS NOT NULL AND combined_result IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_term_test_attempt_class_student
  ON assessment.term_test_attempt (erp_course_class_id, erp_student_contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_term_test_attempt_completed
  ON assessment.term_test_attempt (test_slug, completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- API chỉ được đọc định nghĩa đề và ghi/đọc lượt làm; không được sửa hoặc xóa đáp án chuẩn.
GRANT USAGE ON SCHEMA assessment TO mapping_app;
GRANT SELECT ON assessment.test_definition TO mapping_app;
GRANT SELECT ON assessment.term_test_roster TO mapping_app;
GRANT SELECT, INSERT, UPDATE ON assessment.term_test_attempt TO mapping_app;

COMMIT;
