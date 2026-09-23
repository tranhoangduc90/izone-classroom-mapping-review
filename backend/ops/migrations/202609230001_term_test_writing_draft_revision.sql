-- Dữ liệu vào: các lượt Term Test đã có từ bản production trước.
-- Việc chính: bổ sung số phiên bản bản nháp Writing mà API production đang dùng.
-- Kết quả: lượt cũ bắt đầu ở phiên bản 0; chạy lại migration không làm đổi bài.
-- Khi lỗi: PostgreSQL dừng migration, không tự sửa hoặc xóa bài học viên.
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN IF NOT EXISTS writing_draft_revision BIGINT NOT NULL DEFAULT 0;
