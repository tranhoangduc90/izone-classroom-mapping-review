-- Dữ liệu vào: schema assessment_k56 vừa được tạo từ cấu trúc K56 đã kiểm.
-- Việc chính: thêm cờ đủ điều kiện và checkpoint của lượt ERP mới nhất.
-- Kết quả: học viên rời lớp bị khóa lượt thi mới mà bài/UUID cũ vẫn còn.
-- Khi lỗi: giao dịch rollback, không chạm schema assessment của K67.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE assessment_k56.term_test_roster
  ADD COLUMN IF NOT EXISTS is_eligible BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS assessment_k56.k56_roster_sync_checkpoint (
  source_name TEXT PRIMARY KEY,
  last_sync_run_id BIGINT NOT NULL CHECK (last_sync_run_id > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
