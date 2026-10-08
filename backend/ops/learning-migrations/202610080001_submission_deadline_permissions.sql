BEGIN;

-- Hai mốc tự khóa được ghi trong transaction nộp cuối. Quyền theo cột cũ không tự mở rộng.
-- Chỉ cấp đúng hai cột cho ứng dụng; giữ quyền hạn chế trên version và các cột khác.
GRANT UPDATE (auto_submission_threshold_at, auto_submission_closes_at)
  ON learning.form_assignment TO learning_api;

COMMIT;
