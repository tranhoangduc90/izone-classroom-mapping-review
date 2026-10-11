-- Giữ đích ngay khi nhận bài để job đang chờ không bị đổi sang buổi khác.
BEGIN;
ALTER TABLE learning.portal_attendance_binding ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
-- Lưu trước/sau và mã thao tác; retry không tạo thêm lần xác nhận.
CREATE TABLE IF NOT EXISTS learning.journey_plan_change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id bigint NOT NULL,
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  previous_plan jsonb,
  next_plan jsonb NOT NULL,
  schedule_fingerprint text,
  erp_snapshot jsonb,
  actor_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, operation_id)
);
GRANT SELECT, INSERT ON learning.journey_plan_change TO learning_api;
GRANT USAGE ON SEQUENCE learning.journey_plan_change_id_seq TO learning_api;
GRANT UPDATE(accepted_at) ON learning.portal_attendance_binding TO learning_api;
GRANT UPDATE(opens_at,closes_at) ON learning.form_assignment TO learning_api;
COMMIT;
