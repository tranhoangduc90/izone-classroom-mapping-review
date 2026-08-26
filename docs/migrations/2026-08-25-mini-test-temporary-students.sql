-- Mục đích: cho học viên chưa có trong roster tự đăng ký danh tính tạm bằng tên và mã giáo viên cấp.
-- Dữ liệu nhận vào: slug Mini Test, lớp đã tồn tại, mã tạm đã chuẩn hóa và họ tên đã chuẩn hóa.
-- Kết quả: mỗi mã tạm trong một lớp/bài có một UUID ổn định; bài làm dùng ID âm riêng để không trùng ID ERP.
-- Lỗi: mã đã gắn với tên khác không bị ghi đè; tầng API sẽ chặn yêu cầu đó theo kiểu fail-closed.

BEGIN;

CREATE TABLE IF NOT EXISTS assessment.term_test_temporary_student (
  temporary_student_id BIGINT GENERATED ALWAYS AS IDENTITY (
    START WITH 9000000000000000000
    MINVALUE 9000000000000000000
    MAXVALUE 9223372036854775807
  ) PRIMARY KEY,
  test_slug TEXT NOT NULL REFERENCES assessment.test_definition(slug) ON DELETE CASCADE,
  erp_course_class_id BIGINT NOT NULL,
  temporary_code_normalized TEXT NOT NULL,
  student_ref UUID NOT NULL DEFAULT gen_random_uuid(),
  student_name_snapshot TEXT NOT NULL,
  student_name_key TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT term_test_temporary_student_slug_check
    CHECK (test_slug ~ '^mini-test-[a-z0-9-]+$'),
  CONSTRAINT term_test_temporary_student_code_check
    CHECK (temporary_code_normalized ~ '^[A-Z0-9][A-Z0-9_-]{1,15}$'),
  CONSTRAINT term_test_temporary_student_name_check
    CHECK (length(student_name_snapshot) BETWEEN 2 AND 80),
  UNIQUE (test_slug, erp_course_class_id, temporary_code_normalized),
  UNIQUE (test_slug, student_ref)
);

CREATE INDEX IF NOT EXISTS idx_term_test_temporary_student_class
  ON assessment.term_test_temporary_student (test_slug, erp_course_class_id, active, student_name_snapshot);

-- API được tạo và đọc hồ sơ tạm, nhưng không được xóa để lịch sử bài làm luôn truy ngược đúng người.
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT USAGE ON SCHEMA assessment TO mapping_review_api;
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_temporary_student TO mapping_review_api;
    GRANT USAGE, SELECT ON SEQUENCE assessment.term_test_temporary_student_temporary_student_id_seq
      TO mapping_review_api;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT USAGE ON SCHEMA assessment TO mapping_app;
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_temporary_student TO mapping_app;
    GRANT USAGE, SELECT ON SEQUENCE assessment.term_test_temporary_student_temporary_student_id_seq
      TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
