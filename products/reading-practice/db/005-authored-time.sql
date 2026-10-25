-- Cho bài mới có thời lượng riêng; không sửa bất kỳ nội dung/lượt làm cũ.
-- Chạy lại được. Quay về runtime cũ vẫn giữ dữ liệu; không khôi phục ràng buộc
-- một thời lượng nếu đã có bài mới khác thời lượng đó.
ALTER TABLE reading_practice.content DROP CONSTRAINT IF EXISTS content_total_ms_check;
ALTER TABLE reading_practice.content ADD CONSTRAINT content_total_ms_check CHECK(total_ms BETWEEN 1000 AND 86400000);
