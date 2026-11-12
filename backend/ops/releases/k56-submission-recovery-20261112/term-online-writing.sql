BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_online_submission_hold
  ADD COLUMN IF NOT EXISTS writing_grading_run_id uuid REFERENCES assessment.term_test_writing_grading_run(id),
  DROP CONSTRAINT term_online_submission_hold_section_check,
  DROP CONSTRAINT term_online_submission_hold_payload_check,
  ADD CONSTRAINT term_online_submission_hold_section_check
    CHECK (section IN ('listening', 'reading', 'writing')),
  ADD CONSTRAINT term_online_submission_hold_payload_check
    CHECK (payload IS NULL OR octet_length(payload::text)
      <= CASE section WHEN 'writing' THEN 220000 ELSE 52000 END);

CREATE UNIQUE INDEX IF NOT EXISTS term_online_receipt_writing_grading_run
  ON assessment.term_online_submission_hold(writing_grading_run_id) WHERE writing_grading_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS term_online_one_writing_receipt
  ON assessment.term_online_submission_hold(attempt_id, generation)
  WHERE section='writing' AND receipt IS NOT NULL;
GRANT UPDATE (writing_grading_run_id) ON assessment.term_online_submission_hold TO k56_shared_api;

COMMIT;
