BEGIN;

-- IC2146 hiển thị kỳ test thứ hai dưới tên Phase 2 trên Portal.
-- Chỉ sửa biến thể hai Task của khóa 56; các lớp dùng bài Writing trực tiếp giữ nguyên.
UPDATE assessment.writing_test_definition
SET portal_test_name = 'Phase 2 Writing',
    display_name = 'Khóa 56 - Phase 2 Writing - hai Task',
    updated_at = now()
WHERE test_key = 'course-56-term-2-weighted';

COMMIT;
