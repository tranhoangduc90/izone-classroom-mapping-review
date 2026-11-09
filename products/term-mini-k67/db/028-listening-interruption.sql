-- A technical interruption occupies the Listening slot without creating a Listening grade.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN listening_interrupted_at timestamptz,
  DROP CONSTRAINT term_test_attempt_completion_check,
  DROP CONSTRAINT term_test_attempt_section_snapshot_check;
ALTER TABLE assessment.term_test_attempt
  ADD CONSTRAINT term_test_attempt_completion_check CHECK (
    (listening_interrupted_at IS NULL AND (
      (exam_mode='lis_first' AND (
        (completed_at IS NULL AND reading_answers IS NULL AND reading_result IS NULL AND combined_result IS NULL)
        OR (completed_at IS NOT NULL AND reading_answers IS NOT NULL AND reading_result IS NOT NULL AND combined_result IS NOT NULL)
      )) OR (exam_mode='read_first' AND (
        (completed_at IS NULL AND combined_result IS NULL AND (listening_submitted_at IS NULL OR reading_submitted_at IS NULL))
        OR (completed_at IS NOT NULL AND combined_result IS NOT NULL
          AND listening_submitted_at IS NOT NULL AND reading_submitted_at IS NOT NULL)
      ))
    )) OR (listening_interrupted_at IS NOT NULL AND (
      (completed_at IS NULL AND reading_submitted_at IS NULL AND combined_result IS NULL)
      OR (completed_at IS NOT NULL AND reading_submitted_at IS NOT NULL AND combined_result IS NOT NULL
        AND combined_result->>'listeningStatus' IS NOT DISTINCT FROM 'interrupted'
        AND combined_result->'listening' IS NOT DISTINCT FROM 'null'::jsonb)
    ))
  ),
  ADD CONSTRAINT term_test_attempt_section_snapshot_check CHECK (
    (listening_interrupted_at IS NULL AND (
      (exam_mode='lis_first' AND listening_submitted_at IS NOT NULL AND listening_answers IS NOT NULL AND listening_result IS NOT NULL)
      OR (exam_mode='read_first' AND (
      ((listening_submitted_at IS NULL AND listening_answers IS NULL AND listening_result IS NULL)
       OR (listening_submitted_at IS NOT NULL AND listening_answers IS NOT NULL AND listening_result IS NOT NULL))
      AND ((reading_submitted_at IS NULL AND reading_answers IS NULL AND reading_result IS NULL)
       OR (reading_submitted_at IS NOT NULL AND reading_answers IS NOT NULL AND reading_result IS NOT NULL))
      ))
    )) OR (listening_interrupted_at IS NOT NULL AND exam_session_id IS NOT NULL
      AND test_slug IN ('term-test-1','term-test-2','mini-test-lesson-5')
      AND exam_delivery<>'answer_sheet'
      AND listening_submitted_at IS NULL AND listening_answers IS NULL AND listening_result IS NULL
      AND ((reading_submitted_at IS NULL AND reading_answers IS NULL AND reading_result IS NULL)
        OR (reading_submitted_at IS NOT NULL AND reading_answers IS NOT NULL AND reading_result IS NOT NULL)))
  );
COMMIT;
