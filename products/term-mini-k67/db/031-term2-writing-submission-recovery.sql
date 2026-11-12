BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE assessment.term_k67_cbt_journey
  ADD COLUMN IF NOT EXISTS writing_hold_cohort boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS assessment.term_k67_writing_submission_hold (
  session_id uuid NOT NULL REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation >= 0),
  operation_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb,
  held_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > held_at),
  PRIMARY KEY (session_id, generation, operation_id)
);
CREATE INDEX IF NOT EXISTS term_k67_writing_submission_hold_expiry
  ON assessment.term_k67_writing_submission_hold (expires_at);
GRANT SELECT, INSERT, DELETE ON assessment.term_k67_writing_submission_hold TO k67_app;
GRANT UPDATE (payload) ON assessment.term_k67_writing_submission_hold TO k67_app;

COMMIT;
