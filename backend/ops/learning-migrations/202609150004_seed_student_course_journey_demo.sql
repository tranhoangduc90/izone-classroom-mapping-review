-- Dữ liệu nhận vào: hồ sơ hoàn toàn giả của Progress Log demo.
-- Việc chính: công bố một báo cáo và tạo link cố định chỉ cho dữ liệu giả.
-- Kết quả: có thể kiểm toàn bộ màn hành trình học viên mà không dùng dữ liệu thật.
-- Khi lỗi: transaction seed rollback; không ảnh hưởng lớp thật.

UPDATE learning.periodic_report
SET status = 'published',
    report_kind = 'periodic',
    published_at = COALESCE(published_at, now()),
    updated_at = now()
WHERE id = '20000000-0000-4000-8000-000000000702'
  AND student_ref = '21000000-0000-4000-8000-000000000003'
  AND erp_course_class_id = 990000567;

UPDATE learning.evidence_event
SET visibility = 'student_visible'
WHERE id = '20000000-0000-4000-8000-000000000601'
  AND student_ref = '21000000-0000-4000-8000-000000000003'
  AND erp_course_class_id = 990000567;

INSERT INTO learning.student_progress_access (
  id, erp_course_class_id, student_ref, token_hash, status, expires_at,
  created_by_email, operation_key, idempotency_key
) VALUES (
  '23000000-0000-4000-8000-000000000001',
  990000567,
  '21000000-0000-4000-8000-000000000003',
  'c6a9514a5c597826c174987e2f4558bb6236cb1e6560afa3ba4258301aa2c3f4',
  'active',
  '2099-12-31T23:59:59Z',
  'progress-log-demo@izone.invalid',
  'demo:student-course-journey:student-03:v1',
  'demo:student-course-journey:student-03:write:v1'
)
ON CONFLICT (id) DO NOTHING;
