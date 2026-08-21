-- Mục đích: cho luồng Writing tự nhận diện mọi lớp hợp lệ thay vì khóa cứng từng lớp.
-- Dữ liệu nhận vào: không nhận dữ liệu học viên; chỉ bổ sung quyền đọc các bảng mapping đã có.
-- Kết quả: backend được phép đối chiếu lớp ERP, lớp Classroom và roster hiện tại trước khi tạo điểm.
-- Khi lỗi: transaction rollback; quyền cũ và dữ liệu cũ không bị thay đổi.

BEGIN;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_review_api') THEN
    GRANT SELECT ON mapping.classroom_course_mapping, mapping.classroom_roster_snapshot
      TO mapping_review_api;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mapping_app') THEN
    GRANT SELECT ON mapping.classroom_course_mapping, mapping.classroom_roster_snapshot
      TO mapping_app;
  END IF;
END
$permissions$;

COMMIT;
