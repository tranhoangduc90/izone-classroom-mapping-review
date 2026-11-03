-- Giữ nguồn Classroom chưa ghép ERP để gắn CTA và cho học viên chọn tên.
-- Không tự tạo/duyệt mapping; hàng chưa có chủ không được linked với bài cá nhân.
ALTER TABLE speaking_independent.source_binding ALTER COLUMN student_ref DROP NOT NULL;
ALTER TABLE speaking_independent.source_binding ADD CONSTRAINT speaking_source_unmatched_owner_check
  CHECK (student_ref IS NOT NULL OR (status = 'pending' AND work_unit_id IS NULL));
