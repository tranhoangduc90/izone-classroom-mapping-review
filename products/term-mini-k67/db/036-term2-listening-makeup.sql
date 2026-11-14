BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS assessment.term2_listening_makeup (
  attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id),
  device_hash text NOT NULL,
  started_at timestamptz,
  deadline_at timestamptz,
  draft jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE ON assessment.term2_listening_makeup TO k67_app;
COMMIT;
