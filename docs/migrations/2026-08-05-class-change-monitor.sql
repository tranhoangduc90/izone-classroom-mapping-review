-- Mục đích: bổ sung snapshot và lịch sử thay đổi lớp cho luồng quét hằng ngày.
-- Dữ liệu nhận vào: không nhận tham số; chỉ tạo bảng/index còn thiếu trong schema mapping.
-- Kết quả: lưu trạng thái lớp trong Lark, trạng thái đăng ký ERP và các sự kiện thay đổi.
-- Lỗi: PostgreSQL dừng toàn bộ transaction; không để lại migration dở dang.

BEGIN;

CREATE TABLE IF NOT EXISTS mapping.class_monitor_state (
  class_name TEXT PRIMARY KEY,
  in_lark_active_view BOOLEAN NOT NULL,
  erp_source_found BOOLEAN NOT NULL DEFAULT false,
  classroom_source_found BOOLEAN NOT NULL DEFAULT false,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  absent_since TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mapping.erp_class_membership_snapshot (
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  erp_class_name_snapshot TEXT NOT NULL,
  erp_student_name_snapshot TEXT NOT NULL,
  erp_student_email_snapshot TEXT,
  registration_status TEXT,
  registration_updated_at TIMESTAMPTZ,
  source_state TEXT NOT NULL DEFAULT 'active'
    CHECK (source_state IN ('active', 'missing')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  missing_since TIMESTAMPTZ,
  sync_run_id BIGINT REFERENCES mapping.sync_run(id),
  PRIMARY KEY (erp_course_class_id, erp_student_contact_id)
);

CREATE TABLE IF NOT EXISTS mapping.class_change_event (
  id BIGSERIAL PRIMARY KEY,
  change_type TEXT NOT NULL CHECK (change_type IN (
    'lark_class_added_to_view',
    'lark_class_removed_from_view',
    'erp_class_source_missing',
    'erp_class_source_restored',
    'classroom_class_source_missing',
    'classroom_class_source_restored',
    'classroom_student_removed',
    'classroom_student_returned',
    'erp_registration_flagged',
    'erp_registration_status_changed',
    'erp_student_missing_from_source',
    'erp_student_returned_to_source'
  )),
  erp_course_class_id BIGINT,
  class_name_snapshot TEXT,
  erp_student_contact_id BIGINT,
  classroom_course_id TEXT,
  google_user_id TEXT,
  previous_value TEXT,
  new_value TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id BIGINT REFERENCES mapping.sync_run(id)
);

CREATE INDEX IF NOT EXISTS idx_class_change_event_detected
  ON mapping.class_change_event (detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_class_change_event_class_student
  ON mapping.class_change_event (erp_course_class_id, erp_student_contact_id);

COMMIT;
