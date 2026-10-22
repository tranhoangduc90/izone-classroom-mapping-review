BEGIN;
-- Giữ mốc tự khóa gốc; gia hạn và thu hồi có revision riêng, không sửa bài hoặc điểm danh.
ALTER TABLE learning.form_assignment
  ADD COLUMN IF NOT EXISTS management_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extension_closes_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_by_email text,
  ADD COLUMN IF NOT EXISTS withdrawal_reason text;
CREATE TABLE IF NOT EXISTS learning.assignment_management_event (
  operation_id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES learning.form_assignment(id),
  revision integer NOT NULL,
  action text NOT NULL CHECK (action IN ('extend','withdraw')),
  reason text NOT NULL,
  actor_email text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, revision)
);
GRANT SELECT, INSERT ON learning.assignment_management_event TO learning_api;
GRANT UPDATE (management_revision,extension_closes_at,closes_at,status,updated_at,
  withdrawn_at,withdrawn_by_email,withdrawal_reason) ON learning.form_assignment TO learning_api;
COMMIT;
