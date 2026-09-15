-- Dữ liệu nhận vào: lớp, học viên và token truy cập do giảng viên tạo qua API.
-- Việc chính: lưu duy nhất hash của token để học viên mở hành trình học tập đã được công bố.
-- Kết quả: link cá nhân có thể hết hạn hoặc bị thay thế; database không lưu token thô.
-- Khi lỗi: transaction migration rollback; các phiếu và báo cáo hiện có không thay đổi.

CREATE TABLE IF NOT EXISTS learning.student_progress_access (
  id UUID PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by_email TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR status = 'revoked')
);

CREATE UNIQUE INDEX IF NOT EXISTS student_progress_access_one_active
  ON learning.student_progress_access (erp_course_class_id, student_ref)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS student_progress_access_lookup
  ON learning.student_progress_access (token_hash, status, expires_at);

GRANT SELECT, INSERT, UPDATE ON learning.student_progress_access TO learning_api;
