BEGIN;

-- Nhận toàn bộ phiếu cũ và mới, lưu mốc học viên thứ ba; không sửa bài đã nhận.
ALTER TABLE learning.form_assignment
  ADD COLUMN IF NOT EXISTS auto_submission_threshold_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_submission_closes_at timestamptz;
ALTER TABLE learning.outbox_job ADD COLUMN IF NOT EXISTS result_json jsonb;

WITH first_complete AS (
  SELECT assignment_id, student_ref, min(submitted_at) AS first_at
  FROM learning.submission WHERE completeness = 'complete'
  GROUP BY assignment_id, student_ref
), ranked AS (
  SELECT assignment_id, first_at,
    row_number() OVER (PARTITION BY assignment_id ORDER BY first_at, student_ref) AS ordinal
  FROM first_complete
)
UPDATE learning.form_assignment AS assignment
SET auto_submission_threshold_at = ranked.first_at,
    auto_submission_closes_at =
      (date_trunc('day', ranked.first_at AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '22 hours')
        AT TIME ZONE 'Asia/Ho_Chi_Minh'
FROM ranked WHERE ranked.ordinal = 3 AND assignment.id = ranked.assignment_id
  AND assignment.auto_submission_threshold_at IS NULL;

-- Mốc tự khóa đã hình thành không được gia hạn hoặc xóa bởi thao tác đóng/mở thủ công.
CREATE OR REPLACE FUNCTION learning.preserve_submission_deadline() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.auto_submission_threshold_at IS NOT NULL AND
     (NEW.auto_submission_threshold_at IS DISTINCT FROM OLD.auto_submission_threshold_at OR
      NEW.auto_submission_closes_at IS DISTINCT FROM OLD.auto_submission_closes_at) THEN
    RAISE EXCEPTION 'Hạn tự khóa Progress Log đã chốt không thể thay đổi';
  END IF;
  IF (NEW.auto_submission_threshold_at IS NULL) <> (NEW.auto_submission_closes_at IS NULL) THEN
    RAISE EXCEPTION 'Mốc học viên thứ ba và hạn khóa phải được ghi cùng nhau';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS preserve_submission_deadline ON learning.form_assignment;
CREATE TRIGGER preserve_submission_deadline BEFORE UPDATE ON learning.form_assignment
FOR EACH ROW EXECUTE FUNCTION learning.preserve_submission_deadline();

-- Mỗi phiếu dùng một đích ERP chung. Ý định ghi được lưu trước khi gọi Portal.
CREATE TABLE IF NOT EXISTS learning.portal_attendance_binding (
  assignment_id uuid PRIMARY KEY REFERENCES learning.form_assignment(id),
  class_id bigint NOT NULL,
  session_number integer NOT NULL CHECK (session_number BETWEEN 1 AND 100),
  target_session_id bigint NOT NULL,
  schedule_fingerprint text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  write_started boolean NOT NULL DEFAULT false,
  review_required boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning.portal_attendance_operation (
  operation_key text PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES learning.portal_attendance_binding(assignment_id),
  student_ref uuid NOT NULL,
  target_session_id bigint NOT NULL,
  binding_revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('intent', 'synced', 'already_present', 'conflict', 'target_changed')),
  session_date date,
  readback_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON learning.portal_attendance_binding,
  learning.portal_attendance_operation TO learning_api;

-- Các lượt điểm danh cũ chưa lưu đích thật phải được đối soát trước khi chọn lại buổi.
CREATE TABLE IF NOT EXISTS learning.portal_attendance_transition (
  id boolean PRIMARY KEY CHECK (id), activated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS learning.portal_attendance_legacy_guard (
  unit_key text PRIMARY KEY, captured_at timestamptz NOT NULL
);
-- Chụp một lần số lượt đã thử trước nâng cấp; claim sau nâng cấp không làm job mới thành job cũ.
WITH first_transition AS (
  INSERT INTO learning.portal_attendance_transition VALUES (true, clock_timestamp())
  ON CONFLICT DO NOTHING RETURNING activated_at
)
INSERT INTO learning.portal_attendance_legacy_guard (unit_key, captured_at)
SELECT DISTINCT job.unit_key, transition.activated_at
FROM learning.outbox_job AS job CROSS JOIN first_transition AS transition
WHERE job.job_type = 'sync_portal_attendance' AND job.attempt_count > 0
ON CONFLICT DO NOTHING;
GRANT SELECT ON learning.portal_attendance_transition,
  learning.portal_attendance_legacy_guard TO learning_api;

COMMIT;
