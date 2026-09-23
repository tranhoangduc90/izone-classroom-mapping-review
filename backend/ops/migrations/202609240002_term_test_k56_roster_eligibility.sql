-- Dữ liệu vào: roster hiện có của Term/Mini Test, gồm bài và UUID cũ.
-- Việc chính: thêm cờ đủ điều kiện, mặc định giữ nguyên quyền của mọi hàng cũ.
-- Kết quả: đồng bộ sau này có thể khóa lượt thi mới mà không xóa kết quả lịch sử.
-- Khi lỗi: transaction rollback; không sửa bài nộp, điểm hoặc UUID.
BEGIN;

ALTER TABLE assessment.term_test_roster
  ADD COLUMN IF NOT EXISTS is_eligible BOOLEAN NOT NULL DEFAULT true;

COMMIT;
