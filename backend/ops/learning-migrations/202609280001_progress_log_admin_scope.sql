-- Dữ liệu nhận vào: tài khoản Google đã được cấp trong mapping.reviewer_account.
-- Việc chính: lưu quyền quản trị mọi lớp riêng cho Progress Log, có thể thu hồi và kiểm theo trạng thái tài khoản.
-- Kết quả: learning_api chỉ đọc quyền này; quyền các sản phẩm khác không đổi.
-- Khi lỗi: migration dừng, không mở quyền toàn hệ thống.
CREATE TABLE IF NOT EXISTS learning.progress_log_admin (
  reviewer_email TEXT PRIMARY KEY REFERENCES mapping.reviewer_account(email),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  grant_reference TEXT NOT NULL CHECK (length(trim(grant_reference)) BETWEEN 8 AND 500),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON learning.progress_log_admin TO learning_api;
