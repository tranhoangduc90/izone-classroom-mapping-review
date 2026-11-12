BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.mini_k56_offline_run
  ADD COLUMN IF NOT EXISTS submission_hold_hours smallint NOT NULL DEFAULT 0
    CHECK (submission_hold_hours BETWEEN 0 AND 72),
  ADD COLUMN IF NOT EXISTS submission_hold_limit integer NOT NULL DEFAULT 0
    CHECK (submission_hold_limit BETWEEN 0 AND 20000);

CREATE TABLE IF NOT EXISTS assessment.mini_k56_submission_hold (
  attempt_id uuid NOT NULL REFERENCES assessment.mini_k56_offline_run(attempt_id),
  generation bigint NOT NULL CHECK (generation >= 0),
  operation_id uuid NOT NULL,
  section text NOT NULL CHECK (section IN ('listening', 'reading', 'writing')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb CHECK (payload IS NULL OR octet_length(payload::text) <= 520000),
  held_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > held_at),
  PRIMARY KEY (attempt_id, generation, operation_id)
);

CREATE INDEX IF NOT EXISTS mini_k56_submission_hold_active_expiry
  ON assessment.mini_k56_submission_hold (expires_at) WHERE payload IS NOT NULL;

GRANT SELECT, INSERT ON assessment.mini_k56_submission_hold TO k56_shared_api;
GRANT UPDATE (payload) ON assessment.mini_k56_submission_hold TO k56_shared_api;

COMMIT;
