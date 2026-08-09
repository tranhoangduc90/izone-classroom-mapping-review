-- Mục đích: lưu tạm kết quả Mini Test trong database mapping khi Portal chưa có cột chuẩn.
-- Dữ liệu nhận vào: điểm tổng hợp và thống kê dạng bài; không lưu đáp án đúng hoặc khóa bí mật.
-- Kết quả: mỗi phản hồi có khóa chống trùng, có thể chạy chấm lại mà không tạo thêm bản ghi.
-- Khi lỗi: toàn bộ migration rollback, không để lại bảng hoặc quyền dở dang.

BEGIN;

CREATE SCHEMA IF NOT EXISTS assessment;

CREATE TABLE IF NOT EXISTS assessment.mini_test_result (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_submission_key TEXT NOT NULL,
  test_slug TEXT NOT NULL CHECK (test_slug ~ '^mini-test-[a-z0-9-]+$'),
  erp_course_class_id BIGINT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  student_name_snapshot TEXT NOT NULL,
  source_submitted_at TEXT,
  listening_correct SMALLINT NOT NULL CHECK (listening_correct BETWEEN 0 AND 20),
  reading_correct SMALLINT NOT NULL CHECK (reading_correct BETWEEN 0 AND 13),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (test_slug, source_submission_key)
);

CREATE INDEX IF NOT EXISTS idx_mini_test_result_class_student
  ON assessment.mini_test_result (
    erp_course_class_id,
    erp_student_contact_id,
    test_slug,
    updated_at DESC
  );

-- Chỉ mở các trường tối thiểu cần để nối họ tên trên bảng tính với ID trong ERP.
-- View chạy bằng quyền chủ sở hữu, nên tài khoản API không cần đọc bảng snapshot có email.
CREATE OR REPLACE VIEW assessment.mini_test_student_lookup AS
SELECT
  target.erp_course_class_id,
  target.erp_class_name_snapshot AS class_name,
  membership.erp_student_contact_id,
  membership.erp_student_name_snapshot AS student_name
FROM mapping.classroom_course_mapping AS target
JOIN mapping.erp_class_membership_snapshot AS membership
  ON membership.erp_course_class_id = target.erp_course_class_id;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT USAGE ON SCHEMA assessment TO mapping_review_api;
    GRANT SELECT ON assessment.mini_test_student_lookup TO mapping_review_api;
    GRANT SELECT, INSERT, UPDATE ON assessment.mini_test_result TO mapping_review_api;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT USAGE ON SCHEMA assessment TO mapping_app;
    GRANT SELECT ON assessment.mini_test_student_lookup TO mapping_app;
    GRANT SELECT, INSERT, UPDATE ON assessment.mini_test_result TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
