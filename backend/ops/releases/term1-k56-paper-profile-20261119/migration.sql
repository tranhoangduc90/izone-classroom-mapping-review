BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN term1_paper_profile_id uuid,
  ADD COLUMN term1_paper_legacy_bridge jsonb,
  ADD CONSTRAINT term1_paper_profile_scope CHECK (
    term1_paper_profile_id IS NULL OR (
      test_slug = 'term-test-1-k56' AND attempt_mode = 'cbt' AND term1_parallel_entry
    )
  ),
  ADD CONSTRAINT term1_paper_legacy_bridge_scope CHECK (
    term1_paper_legacy_bridge IS NULL OR (
      term1_paper_profile_id IS NOT NULL
      AND jsonb_typeof(term1_paper_legacy_bridge) = 'object'
      AND term1_paper_legacy_bridge ? 'attemptToken'
      AND term1_paper_legacy_bridge ? 'examSessionToken'
    )
  );

CREATE UNIQUE INDEX uq_term1_k56_active_paper_profile
  ON assessment.term_test_exam_session (erp_course_class_id, erp_student_contact_id, term1_paper_profile_id)
  WHERE term1_paper_profile_id IS NOT NULL AND superseded_at IS NULL;

ALTER TABLE assessment.term_test_attempt
  ADD COLUMN term1_paper_private_writing boolean NOT NULL DEFAULT false;

DO $migration$
DECLARE
  previous_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous_check
  FROM pg_constraint
  WHERE conrelid = 'assessment.term_test_attempt'::regclass
    AND conname = 'term_test_attempt_writing_order_check' AND contype = 'c' AND convalidated;

  ALTER TABLE assessment.term_test_attempt DROP CONSTRAINT term_test_attempt_writing_order_check;
  EXECUTE format('ALTER TABLE assessment.term_test_attempt
    ADD CONSTRAINT term_test_attempt_writing_order_check CHECK ((%s) OR (
      term1_paper_private_writing AND test_slug = %L AND attempt_mode = %L AND term1_parallel_entry
      AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL AND writing_submitted_at IS NULL
    ))', previous_check, 'term-test-1-k56', 'cbt');
END
$migration$;

COMMIT;
