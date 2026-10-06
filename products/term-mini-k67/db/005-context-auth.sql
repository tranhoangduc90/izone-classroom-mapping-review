-- Delta cho fixture đã tạo trước khi kiểm auth đầy đủ; chỉ chạy trên DB K67 đã xác nhận.
-- Đồng bộ có thể thu hồi phiên khi quyền đổi, không đọc token hoặc tạo phiên.
ALTER TABLE mapping.reviewer_session ADD COLUMN IF NOT EXISTS revoked_reason text;
GRANT SELECT (reviewer_email,revoked_at) ON mapping.reviewer_session TO k67_context_sync;
GRANT UPDATE (revoked_at,revoked_reason) ON mapping.reviewer_session TO k67_context_sync;
