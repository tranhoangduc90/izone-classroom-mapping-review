-- Mục đích: cho phép Mini Test dùng chung luồng web Listening → Reading với Term Test.
-- Dữ liệu nhận vào: chỉ nới quy tắc mã bài; đáp án được seed riêng ngoài repo công khai.
-- Kết quả: API có thể lưu bài Mini Test trong bảng attempt và trang giảng viên vẫn đọc được dữ liệu cũ.
-- Khi lỗi: transaction rollback, quy tắc mã bài cũ vẫn được giữ nguyên.

BEGIN;

ALTER TABLE assessment.test_definition
  DROP CONSTRAINT IF EXISTS test_definition_slug_check;

ALTER TABLE assessment.test_definition
  ADD CONSTRAINT test_definition_slug_check
  CHECK (slug ~ '^(term-test-[1-9][0-9]*|mini-test-[a-z0-9-]+)$');

COMMIT;
