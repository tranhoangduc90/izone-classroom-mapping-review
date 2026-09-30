-- Dữ liệu vào: registry Speaking đang phục vụ các bài có CTA trong Google Docs.
-- Việc chính: thêm chế độ nộp trực tiếp cho bài cũ, mặc định giữ nguyên hành vi Docs.
-- Kết quả: chỉ assignment được chọn rõ mới bỏ bước CTA và việc ghi Docs.
ALTER TABLE speaking_homework.assignment
  ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'docs_cta'
  CHECK (delivery_mode IN ('docs_cta', 'direct'));
