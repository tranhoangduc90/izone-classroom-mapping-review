-- Dữ liệu nhận vào: các tác vụ đồng bộ điểm danh đã có trong learning.outbox_job.
-- Việc chính: tăng tốc đọc trạng thái đồng bộ của từng học viên trên dashboard.
-- Kết quả: mỗi hàng học viên tìm được tác vụ mới nhất mà không quét cả hàng đợi.
-- Khi lỗi: migration rollback; không sửa bài nộp hoặc điểm danh.

CREATE INDEX IF NOT EXISTS idx_learning_portal_attendance_student_unit
  ON learning.outbox_job (entity_key, unit_key, created_at DESC)
  WHERE job_type = 'sync_portal_attendance';
