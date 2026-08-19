-- Mục đích: lưu bài Writing của Term Test theo đúng lượt làm để học viên đóng tab rồi mở lại vẫn đọc được.
-- Dữ liệu nhận vào: attempt token cùng nguyên văn Task 1 và Task 2 từ giao diện thi.
-- Kết quả: database giữ thời điểm bắt đầu, lần lưu gần nhất và thời điểm nộp Writing.
-- Lỗi: chạy trong transaction; bất kỳ lỗi nào cũng rollback toàn bộ migration.

BEGIN;

ALTER TABLE assessment.term_test_attempt
  ADD COLUMN IF NOT EXISTS writing_task_1 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS writing_task_2 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS writing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS writing_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS writing_submitted_at TIMESTAMPTZ;

ALTER TABLE assessment.term_test_attempt
  DROP CONSTRAINT IF EXISTS term_test_attempt_writing_order_check;

ALTER TABLE assessment.term_test_attempt
  ADD CONSTRAINT term_test_attempt_writing_order_check CHECK (
    (writing_started_at IS NULL AND writing_updated_at IS NULL AND writing_submitted_at IS NULL)
    OR
    (
      completed_at IS NOT NULL
      AND writing_started_at IS NOT NULL
      AND writing_updated_at IS NOT NULL
      AND (writing_submitted_at IS NULL OR writing_submitted_at >= writing_started_at)
    )
  );

-- Quyền vẫn chỉ áp dụng cho API; các view xuất Lark/Portal không đọc hai cột bài viết này.
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_attempt TO mapping_review_api;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT SELECT, INSERT, UPDATE ON assessment.term_test_attempt TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
