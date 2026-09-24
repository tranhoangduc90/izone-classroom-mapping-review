-- Dữ liệu vào: role API K56 và ba bảng K56 đã được tạo trong mapping_db.
-- Việc chính: cấp quyền tối thiểu để đối soát roster, quyền mở bài và checkpoint.
-- Kết quả: API K56 chỉ ghi schema assessment_k56; K67 không nhận grant mới.
-- Khi lỗi: toàn bộ thay đổi quyền được rollback.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

GRANT SELECT, INSERT, UPDATE ON
  assessment_k56.term_test_roster,
  assessment_k56.term_test_class_access,
  assessment_k56.k56_roster_sync_checkpoint
  TO k56_shared_api;

COMMIT;
