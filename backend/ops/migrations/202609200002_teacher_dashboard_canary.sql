-- Mục đích: tạo một tài khoản kỹ thuật chỉ được xem hai lớp demo để chạy canary.
-- Dữ liệu nhận vào: hai lớp demo đã có; không dùng danh tính học viên thật.
-- Kết quả: canary có phạm vi hẹp; lớp khác vẫn bị từ chối.
-- Khi lỗi: transaction rollback, không để lại account hoặc quyền dở dang.

BEGIN;

INSERT INTO mapping.reviewer_account (
  email, google_subject, display_name, role, status, can_access_all_classes
) VALUES (
  'dashboard-canary@synthetic.invalid',
  'dashboard-canary-synthetic-v1',
  'Kiểm tra dashboard tự động',
  'teacher',
  'active',
  false
)
ON CONFLICT (email) DO UPDATE SET
  google_subject = EXCLUDED.google_subject,
  display_name = EXCLUDED.display_name,
  role = 'teacher',
  status = 'active',
  can_access_all_classes = false,
  updated_at = now();

INSERT INTO mapping.reviewer_class_access (reviewer_email, erp_course_class_id)
SELECT 'dashboard-canary@synthetic.invalid', course.erp_course_class_id
FROM mapping.classroom_course_mapping AS course
WHERE course.erp_course_class_id IN (-8062028, 990000567)
ON CONFLICT (reviewer_email, erp_course_class_id) DO NOTHING;

COMMIT;
