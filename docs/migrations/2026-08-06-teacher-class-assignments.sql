-- Mục đích: lưu quyền giảng viên theo mã lớp ngay cả khi lớp chưa có course mapping.
-- Dữ liệu nhận vào: tài khoản đã tồn tại trong mapping.reviewer_account và mã lớp ERP/Lark.
-- Kết quả: workflow hằng ngày có thể tự tạo reviewer_class_access khi lớp được đồng bộ.
-- Lỗi: toàn bộ transaction rollback, không để lại bảng hoặc quyền dở dang.

BEGIN;

CREATE TABLE IF NOT EXISTS mapping.reviewer_class_assignment (
  reviewer_email TEXT NOT NULL
    REFERENCES mapping.reviewer_account(email) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reviewer_email, class_name),
  CONSTRAINT reviewer_class_assignment_name_not_blank_check
    CHECK (length(trim(class_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_reviewer_class_assignment_normalized_name
  ON mapping.reviewer_class_assignment (upper(trim(class_name)));

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT SELECT ON mapping.reviewer_class_assignment TO mapping_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT SELECT ON mapping.reviewer_class_assignment TO mapping_review_api;
  END IF;
END
$migration$;

COMMIT;
