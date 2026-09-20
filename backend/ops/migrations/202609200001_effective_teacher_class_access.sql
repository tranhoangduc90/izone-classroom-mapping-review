-- Mục đích: cho API Progress Log đọc nguồn phân công lớp trực tiếp.
-- Dữ liệu nhận vào: bảng phân công đã có; migration không sửa dòng dữ liệu.
-- Kết quả: role learning_api chỉ có quyền SELECT, tương đương quyền đọc bảng access hiện tại.
-- Khi lỗi: transaction rollback, không để lại grant dở dang.

BEGIN;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT SELECT ON mapping.reviewer_class_assignment, mapping.sync_run TO mapping_review_api;
    IF to_regclass('mapping.lark_replica_run') IS NOT NULL THEN
      GRANT SELECT ON mapping.lark_replica_run TO mapping_review_api;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'learning_api') THEN
    GRANT SELECT ON mapping.reviewer_class_assignment TO learning_api;
  END IF;
END
$migration$;

COMMIT;
