BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS assessment.term_k67_listening_retake (
  id uuid PRIMARY KEY,
  definition_version integer NOT NULL,
  class_id bigint NOT NULL,
  class_code text NOT NULL,
  student_id bigint NOT NULL,
  student_ref uuid NOT NULL,
  student_name text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  device_hash text NOT NULL,
  audio_hash text NOT NULL,
  listening_duration_ms integer NOT NULL CHECK (listening_duration_ms > 0),
  ticket_expires_at timestamptz NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  sealed_at timestamptz,
  answers jsonb,
  result jsonb,
  receipt jsonb,
  CHECK ((sealed_at IS NULL AND answers IS NULL AND result IS NULL AND receipt IS NULL)
    OR (sealed_at IS NOT NULL AND started_at IS NOT NULL AND answers IS NOT NULL AND result IS NOT NULL AND receipt IS NOT NULL))
);
GRANT SELECT, INSERT, UPDATE ON assessment.term_k67_listening_retake TO k67_app;
COMMIT;
