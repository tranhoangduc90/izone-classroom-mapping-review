-- Giữ nguồn nộp từng phần riêng với bài nộp cuối; không thay đổi bản ghi điểm danh cũ.
ALTER TABLE learning.attendance_record
  ADD COLUMN IF NOT EXISTS source_checkpoint_submission_id UUID REFERENCES learning.checkpoint_submission(id);
ALTER TABLE learning.attendance_event
  ADD COLUMN IF NOT EXISTS source_checkpoint_submission_id UUID REFERENCES learning.checkpoint_submission(id);

-- Quyền ứng dụng phải đủ để ghi/đọc nguồn mới trong cùng giao dịch nộp phần.
GRANT SELECT (source_checkpoint_submission_id), INSERT (source_checkpoint_submission_id),
  UPDATE (source_checkpoint_submission_id) ON learning.attendance_record TO learning_api;
GRANT SELECT (source_checkpoint_submission_id), INSERT (source_checkpoint_submission_id)
  ON learning.attendance_event TO learning_api;
