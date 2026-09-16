-- Dữ liệu nhận vào: hàng đợi Learning hiện hành.
-- Việc chính: cho phép một loại tác vụ riêng để ghi điểm danh Progress Log sang Portal.
-- Kết quả: bài nộp được chốt trước; tác vụ Portal có lease, retry và idempotency độc lập.
-- Khi lỗi: transaction migration rollback; luồng nộp bài hiện hành không bị đổi dở dang.

ALTER TABLE learning.outbox_job
  DROP CONSTRAINT IF EXISTS outbox_job_job_type_check;

ALTER TABLE learning.outbox_job
  ADD CONSTRAINT outbox_job_job_type_check
  CHECK (job_type IN (
    'analyze_submission',
    'grade_translation',
    'grade_writing_speaking',
    'build_periodic_report',
    'refresh_dashboard',
    'purge_student',
    'deliver_report',
    'sync_portal_attendance'
  ));
