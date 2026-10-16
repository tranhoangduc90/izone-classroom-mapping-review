-- Phân biệt lượt thi chính thức với phiếu chỉ nhập Listening/Reading.
-- Không tự đổi điểm hoặc chấm lại dữ liệu lịch sử; lượt đã có mặc định vẫn là bài thi.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN IF NOT EXISTS writing_scope text NOT NULL DEFAULT 'exam'
    CHECK (writing_scope IN ('exam','lr_only')),
  ADD COLUMN IF NOT EXISTS writing_source_attempt_id uuid;
COMMIT;
