-- Dữ liệu nhận vào: assignment Reading 1 & Listening 1 của IC2305 đã phát hành nhầm ở buổi 2.
-- Việc chính: chuyển đúng assignment và evidence đã có sang buổi 4, không xóa bài học viên.
-- Kết quả: dashboard hiển thị đúng buổi; lịch sử và câu trả lời cũ được giữ nguyên.
-- Khi không tìm thấy đúng identity: câu UPDATE không tác động hàng nào; vận hành phải readback trước/sau.

UPDATE learning.form_assignment
SET session_number = 4,
    updated_at = now()
WHERE id = '0607693f-8af9-4c1c-9f3e-09f894761381'::uuid
  AND form_version_id = '56000000-0000-4000-8000-000000000002'::uuid
  AND erp_course_class_id = 1294
  AND session_number = 2
  AND title = 'ENTRANCE TICKET • READING 1 & LISTENING 1';

UPDATE learning.evidence_event
SET session_number = 4
WHERE assignment_id = '0607693f-8af9-4c1c-9f3e-09f894761381'::uuid
  AND session_number = 2;
