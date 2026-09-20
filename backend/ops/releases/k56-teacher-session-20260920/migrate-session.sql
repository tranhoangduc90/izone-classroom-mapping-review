-- Đầu vào: biến psql api_role là role của đúng profile K56.
-- Việc làm: tạo bảng phiên chỉ lưu SHA-256 và cấp quyền tối thiểu cho role API đó.
-- Kết quả: API K56 có thể tạo, gia hạn và thu hồi phiên; Google token không được lưu.
-- Khi lỗi: toàn bộ transaction rollback; dashboard cũ tiếp tục dùng Bearer trong lúc chưa phát hành frontend.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('k56_teacher_session_migration'));

CREATE TABLE mapping.reviewer_session (
  token_hash bytea PRIMARY KEY,
  reviewer_email text NOT NULL
    REFERENCES mapping.reviewer_account (email)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  google_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT reviewer_session_token_hash_length_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT reviewer_session_expiry_order_check CHECK (created_at <= idle_expires_at AND idle_expires_at <= absolute_expires_at),
  CONSTRAINT reviewer_session_revocation_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX reviewer_session_account_active_idx
  ON mapping.reviewer_session (reviewer_email, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX reviewer_session_expiry_idx
  ON mapping.reviewer_session (idle_expires_at, absolute_expires_at)
  WHERE revoked_at IS NULL;

REVOKE ALL ON TABLE mapping.reviewer_session FROM PUBLIC;
GRANT USAGE ON SCHEMA mapping TO :"api_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mapping.reviewer_session TO :"api_role";

COMMIT;
