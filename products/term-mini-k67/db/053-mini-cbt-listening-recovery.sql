BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS assessment.mini_k67_cbt_listening_clock (
  session_id uuid PRIMARY KEY REFERENCES assessment.mini_k67_cbt_journey(session_id) ON DELETE CASCADE,
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_at_ms bigint,
  snapshot jsonb,
  CHECK ((revision = 0 AND snapshot IS NULL AND started_at_ms IS NULL)
      OR (revision > 0 AND snapshot IS NOT NULL AND started_at_ms IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS assessment.mini_k67_cbt_listening_clock_operation (
  operation_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES assessment.mini_k67_cbt_listening_clock(session_id) ON DELETE CASCADE,
  request_sha256 text NOT NULL,
  receipt jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS mini_k67_cbt_listening_clock_operation_session_idx
  ON assessment.mini_k67_cbt_listening_clock_operation(session_id);
GRANT SELECT, INSERT, UPDATE ON assessment.mini_k67_cbt_listening_clock TO k67_app;
GRANT SELECT, INSERT ON assessment.mini_k67_cbt_listening_clock_operation TO k67_app;
COMMIT;
