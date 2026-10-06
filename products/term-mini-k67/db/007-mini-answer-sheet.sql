-- Bổ sung chính sách nhập đáp án; không xóa/chấm lại bài hoặc thay runtime khác.
ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN IF NOT EXISTS attempt_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN IF NOT EXISTS attempt_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
-- Chỉ nhóm làm giấy đã được giảng viên xác nhận; giữ hạn lịch sử của bài đã nộp.
UPDATE assessment.term_test_attempt
SET attempt_mode='answer_sheet',
    reading_deadline_at=CASE WHEN completed_at IS NULL THEN NULL ELSE reading_deadline_at END
WHERE test_slug='mini-test-lesson-5' AND erp_course_class_id=1293
  AND exam_session_id IS NULL AND attempt_mode='legacy';
