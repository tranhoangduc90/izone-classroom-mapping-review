BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '6s';
LOCK TABLE ONLY assessment.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN listening_interrupted_at timestamptz,
  ADD CONSTRAINT k56_listening_interruption_check CHECK (
    listening_interrupted_at IS NULL OR (
      test_slug IN ('term-test-1-k56','term-test-2-k56','mini-test-k56') AND attempt_mode = 'cbt'
      AND listening_submitted_at IS NULL AND listening_result IS NULL
    )
  ) NOT VALID,
  DROP CONSTRAINT term_test_attempt_writing_order_check,
  ADD CONSTRAINT term_test_attempt_writing_order_check CHECK (
    (writing_started_at IS NULL AND writing_updated_at IS NULL AND writing_submitted_at IS NULL)
    OR (
      (completed_at IS NOT NULL OR (listening_interrupted_at IS NOT NULL AND reading_submitted_at IS NOT NULL))
      AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL
      AND (writing_submitted_at IS NULL OR writing_submitted_at >= writing_started_at)
    )
  ) NOT VALID;
ALTER TABLE assessment.term_test_attempt
  VALIDATE CONSTRAINT k56_listening_interruption_check,
  VALIDATE CONSTRAINT term_test_attempt_writing_order_check;

CREATE TABLE IF NOT EXISTS assessment.term1_skill_grant (
  id uuid PRIMARY KEY,
  secret_hash text NOT NULL UNIQUE,
  activation_hash text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  class_id bigint NOT NULL CHECK (class_id > 0),
  student_ref uuid NOT NULL,
  section text NOT NULL CHECK (section IN ('listening', 'reading', 'writing')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  owner_id uuid,
  bound_at timestamptz,
  revoked_at timestamptz,
  CHECK ((owner_id IS NULL) = (bound_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS term1_skill_grant_one_active
  ON assessment.term1_skill_grant(attempt_id, generation, section)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS assessment.term1_offline_run (
 attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, generation bigint NOT NULL, owner_id uuid NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(), policy text NOT NULL,
 state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS assessment.term1_offline_operation (
 operation_id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment.term1_offline_run(attempt_id) ON DELETE CASCADE,
 payload_hash text NOT NULL, section text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, receipt jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS term1_offline_operations_attempt ON assessment.term1_offline_operation(attempt_id,committed_at);
CREATE INDEX IF NOT EXISTS term1_offline_writing_pending ON assessment.term1_offline_operation(attempt_id)
 WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';
ALTER TABLE assessment.term1_offline_run ADD COLUMN IF NOT EXISTS main_owner_pending boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS assessment.term2_offline_run (
 attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, generation bigint NOT NULL, owner_id uuid NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(), policy text NOT NULL,
 state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS assessment.term2_offline_operation (
 operation_id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment.term2_offline_run(attempt_id) ON DELETE CASCADE,
 payload_hash text NOT NULL, section text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, receipt jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS term2_offline_operations_attempt ON assessment.term2_offline_operation(attempt_id,committed_at);
CREATE INDEX IF NOT EXISTS term2_offline_writing_pending ON assessment.term2_offline_operation(attempt_id)
 WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';

CREATE TABLE IF NOT EXISTS assessment.mini_k56_offline_run (
 attempt_id uuid PRIMARY KEY REFERENCES assessment.term_test_attempt(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, generation bigint NOT NULL, owner_id uuid NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(), policy text NOT NULL,
 state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS assessment.mini_k56_offline_operation (
 operation_id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment.mini_k56_offline_run(attempt_id) ON DELETE CASCADE,
 payload_hash text NOT NULL, section text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL, receipt jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mini_k56_offline_operations_attempt ON assessment.mini_k56_offline_operation(attempt_id,committed_at);
CREATE INDEX IF NOT EXISTS mini_k56_offline_writing_pending ON assessment.mini_k56_offline_operation(attempt_id)
 WHERE section='writing' AND kind='seal' AND receipt->>'status'='accepted';

GRANT SELECT,INSERT,UPDATE ON assessment.term1_skill_grant, assessment.term1_offline_run, assessment.term1_offline_operation, assessment.term2_offline_run, assessment.term2_offline_operation, assessment.mini_k56_offline_run, assessment.mini_k56_offline_operation TO k56_demo_runtime;
DO $migration$
DECLARE
  definition text := pg_get_functiondef('assessment.reset_demo_term_test_student(text,text,uuid)'::regprocedure);
  old_step text := $old$  UPDATE assessment.term_test_attempt
  SET exam_session_id = NULL
  WHERE test_slug = normalized_slug
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

$old$;
BEGIN
  IF strpos(definition, old_step) = 0 THEN
    RAISE EXCEPTION 'Unexpected K56 demo reset function definition';
  END IF;
  EXECUTE replace(definition,old_step,'');
END
$migration$;
COMMIT;
