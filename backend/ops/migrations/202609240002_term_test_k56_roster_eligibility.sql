-- Dữ liệu vào: roster hiện có của Term/Mini Test, gồm bài và UUID cũ.
-- Việc chính: thêm cờ đủ điều kiện, mặc định giữ nguyên quyền của mọi hàng cũ.
-- Kết quả: đồng bộ sau này có thể khóa lượt thi mới mà không xóa kết quả lịch sử.
-- Khi lỗi: transaction rollback; không sửa bài nộp, điểm hoặc UUID.
BEGIN;

ALTER TABLE assessment.term_test_roster
  ADD COLUMN IF NOT EXISTS is_eligible BOOLEAN NOT NULL DEFAULT true;

-- Dữ liệu vào: số lượt đồng bộ ERP đã đối soát ở mỗi lần cập nhật sau này.
-- Việc chính: ghi nhớ lượt cuối trong cùng giao dịch với trạng thái đủ điều kiện.
-- Kết quả: lượt cũ không thể bật lại quyền dự thi đã được khóa ở lượt mới.
-- Khi lỗi: transaction rollback, checkpoint và roster đều không đổi.
CREATE TABLE IF NOT EXISTS assessment.k56_roster_sync_checkpoint (
  source_name TEXT PRIMARY KEY,
  last_sync_run_id BIGINT NOT NULL CHECK (last_sync_run_id > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
