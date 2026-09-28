-- Dữ liệu nhận vào: chính sách hiện đáp án của từng phiếu đã phát hành.
-- Việc chính: cho phép đổi chính sách ở cấp phiếu mà không đổi form version/hash hoặc bài đã nộp.
-- Kết quả: NULL kế thừa chính sách của form; immediate chỉ hiện đáp án sau khi nộp.
-- Khi lỗi: migration rollback; mọi phiếu tiếp tục dùng chính sách cũ.
ALTER TABLE learning.form_assignment
  ADD COLUMN IF NOT EXISTS answer_release_override TEXT
    CHECK (answer_release_override IN ('hidden', 'immediate')),
  ADD COLUMN IF NOT EXISTS answer_release_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS answer_release_updated_by TEXT;

GRANT UPDATE (answer_release_override, answer_release_updated_at, answer_release_updated_by, updated_at)
  ON learning.form_assignment TO learning_api;
