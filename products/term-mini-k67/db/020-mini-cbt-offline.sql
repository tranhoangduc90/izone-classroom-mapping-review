BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS assessment.mini_k67_cbt_offline_seal (
  session_id uuid NOT NULL REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
  section text NOT NULL CHECK (section IN ('listening','reading')),
  operation_id uuid UNIQUE NOT NULL,
  payload_hash text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (session_id,section)
);
GRANT SELECT, INSERT ON assessment.mini_k67_cbt_offline_seal TO k67_app;
COMMIT;
