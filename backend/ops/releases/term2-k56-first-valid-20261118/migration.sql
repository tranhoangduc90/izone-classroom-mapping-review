BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '5s';
LOCK TABLE ONLY assessment.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;

-- An interruption-only row keeps all history and receipts. It is not a valid
-- first submission and must not occupy the unique official-result slot.
CREATE OR REPLACE FUNCTION assessment.guard_term2_k56_official_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.test_slug = 'term-test-2-k56' AND OLD.attempt_mode = 'cbt'
      AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NULL AND OLD.generation = NEW.generation THEN
    IF (OLD.listening_submitted_at IS NOT NULL
          AND ROW(OLD.listening_submitted_at, OLD.listening_answers)
              IS DISTINCT FROM ROW(NEW.listening_submitted_at, NEW.listening_answers))
       OR (OLD.reading_submitted_at IS NOT NULL
          AND ROW(OLD.reading_submitted_at, OLD.reading_answers)
              IS DISTINCT FROM ROW(NEW.reading_submitted_at, NEW.reading_answers))
       OR (OLD.writing_submitted_at IS NOT NULL
          AND ROW(OLD.writing_submitted_at, OLD.writing_task_1)
              IS DISTINCT FROM ROW(NEW.writing_submitted_at, NEW.writing_task_1)) THEN
      RAISE EXCEPTION 'TERM2_K56_OFFICIAL_SUBMISSION_IMMUTABLE' USING ERRCODE = 'P5652';
    END IF;
  END IF;

  IF NEW.test_slug <> 'term-test-2-k56' OR NEW.attempt_mode <> 'cbt' OR NEW.superseded_at IS NOT NULL
      OR (NEW.listening_submitted_at IS NULL AND NEW.reading_submitted_at IS NULL AND NEW.writing_submitted_at IS NULL
) THEN
    NEW.term2_official_submission := false;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.test_slug = NEW.test_slug AND OLD.superseded_at IS NULL
      AND ROW(OLD.definition_version, OLD.erp_course_class_id, OLD.erp_student_contact_id, OLD.generation)
          IS NOT DISTINCT FROM ROW(NEW.definition_version, NEW.erp_course_class_id, NEW.erp_student_contact_id, NEW.generation)
      AND (OLD.listening_submitted_at IS NOT NULL OR OLD.reading_submitted_at IS NOT NULL
        OR OLD.writing_submitted_at IS NOT NULL)
      AND (OLD.term2_official_submission OR NOT (
        (OLD.listening_submitted_at IS NULL AND NEW.listening_submitted_at IS NOT NULL)
        OR (OLD.reading_submitted_at IS NULL AND NEW.reading_submitted_at IS NOT NULL)
        OR (OLD.writing_submitted_at IS NULL AND NEW.writing_submitted_at IS NOT NULL)
      )) THEN
    NEW.term2_official_submission := OLD.term2_official_submission;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM assessment.term_test_attempt AS accepted
    WHERE accepted.test_slug = NEW.test_slug AND accepted.attempt_mode = 'cbt'
      AND accepted.erp_course_class_id = NEW.erp_course_class_id
      AND accepted.erp_student_contact_id = NEW.erp_student_contact_id
      AND accepted.id <> NEW.id AND accepted.superseded_at IS NULL
      AND (accepted.listening_submitted_at IS NOT NULL OR accepted.reading_submitted_at IS NOT NULL
        OR accepted.writing_submitted_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'TERM2_K56_FIRST_SUBMISSION_ALREADY_ACCEPTED' USING ERRCODE = 'P5651';
  END IF;

  NEW.term2_official_submission := true;
  RETURN NEW;
END $$;

UPDATE assessment.term_test_attempt SET term2_official_submission=false
WHERE test_slug='term-test-2-k56' AND attempt_mode='cbt' AND superseded_at IS NULL
  AND term2_official_submission AND listening_submitted_at IS NULL
  AND reading_submitted_at IS NULL AND writing_submitted_at IS NULL;
COMMIT;
