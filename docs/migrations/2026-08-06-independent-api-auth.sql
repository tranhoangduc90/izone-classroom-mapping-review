-- Mục đích: chuẩn bị định danh công khai và quyền truy cập cho API độc lập.
-- Dữ liệu nhận vào: các phiếu duyệt hiện có; không cần truyền dữ liệu học viên thủ công.
-- Kết quả: mỗi phiếu có UUID không lộ ID tuần tự, giảng viên được cấp quyền theo email/lớp.
-- Lỗi: chạy file trong transaction để PostgreSQL rollback toàn bộ nếu một bước thất bại.

BEGIN;

ALTER TABLE mapping.student_mapping_review
  ADD COLUMN IF NOT EXISTS public_id UUID;

UPDATE mapping.student_mapping_review
SET public_id = gen_random_uuid()
WHERE public_id IS NULL;

ALTER TABLE mapping.student_mapping_review
  ALTER COLUMN public_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN public_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_mapping_review_public_id
  ON mapping.student_mapping_review (public_id);

CREATE TABLE IF NOT EXISTS mapping.reviewer_account (
  email TEXT PRIMARY KEY,
  google_subject TEXT UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'teacher'
    CHECK (role IN ('teacher', 'admin')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  can_access_all_classes BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reviewer_account_email_lowercase_check
    CHECK (email = lower(email))
);

CREATE TABLE IF NOT EXISTS mapping.reviewer_class_access (
  reviewer_email TEXT NOT NULL
    REFERENCES mapping.reviewer_account(email) ON DELETE CASCADE,
  erp_course_class_id BIGINT NOT NULL
    REFERENCES mapping.classroom_course_mapping(erp_course_class_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reviewer_email, erp_course_class_id)
);

CREATE INDEX IF NOT EXISTS idx_reviewer_class_access_class
  ON mapping.reviewer_class_access (erp_course_class_id);

COMMIT;
