BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN mini_paper_profile_id uuid,
  ADD CONSTRAINT mini_paper_profile_scope CHECK (mini_paper_profile_id IS NULL OR (
    test_slug = 'mini-test-k56' AND attempt_mode = 'answer_sheet'
  ));
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN mini_paper_parallel_entry boolean NOT NULL DEFAULT false,
  ADD COLUMN mini_paper_official_submission boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT mini_paper_attempt_scope CHECK (NOT (mini_paper_parallel_entry OR mini_paper_official_submission) OR (
    test_slug = 'mini-test-k56' AND attempt_mode = 'answer_sheet' AND exam_session_id IS NOT NULL
  ));
CREATE UNIQUE INDEX uq_mini_k56_paper_profile ON assessment.term_test_exam_session
  (erp_course_class_id, erp_student_contact_id, mini_paper_profile_id)
  WHERE mini_paper_profile_id IS NOT NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX uq_mini_k56_paper_official ON assessment.term_test_attempt
  (erp_course_class_id, erp_student_contact_id, generation)
  WHERE mini_paper_official_submission AND superseded_at IS NULL;

CREATE FUNCTION assessment.bind_mini_k56_paper_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.mini_paper_parallel_entry := NEW.test_slug = 'mini-test-k56' AND NEW.attempt_mode = 'answer_sheet' AND EXISTS (
    SELECT FROM assessment.term_test_exam_session s
    WHERE s.id = NEW.exam_session_id AND s.mini_paper_profile_id IS NOT NULL AND s.superseded_at IS NULL
      AND ROW(s.test_slug,s.attempt_mode,s.definition_version,s.erp_course_class_id,s.erp_student_contact_id,s.generation)
        = ROW(NEW.test_slug,NEW.attempt_mode,NEW.definition_version,NEW.erp_course_class_id,NEW.erp_student_contact_id,NEW.generation)
  );
  RETURN NEW;
END $$;
CREATE TRIGGER mini_k56_paper_bind BEFORE INSERT OR UPDATE OF exam_session_id, mini_paper_parallel_entry,
  test_slug, attempt_mode, definition_version, erp_course_class_id, erp_student_contact_id, generation
  ON assessment.term_test_attempt FOR EACH ROW EXECUTE FUNCTION assessment.bind_mini_k56_paper_attempt();

CREATE FUNCTION assessment.guard_mini_k56_paper_submission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  accepted uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.test_slug = 'mini-test-k56' AND OLD.attempt_mode = 'answer_sheet'
    AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NULL AND OLD.generation = NEW.generation
    AND ((OLD.listening_submitted_at IS NOT NULL AND ROW(OLD.listening_submitted_at,OLD.listening_answers)
      IS DISTINCT FROM ROW(NEW.listening_submitted_at,NEW.listening_answers))
    OR (OLD.reading_submitted_at IS NOT NULL AND ROW(OLD.reading_submitted_at,OLD.reading_answers)
      IS DISTINCT FROM ROW(NEW.reading_submitted_at,NEW.reading_answers))) THEN
    RAISE EXCEPTION 'MINI_K56_PAPER_SUBMISSION_IMMUTABLE' USING ERRCODE = 'P5666';
  END IF;
  IF NEW.test_slug <> 'mini-test-k56' OR NEW.attempt_mode <> 'answer_sheet' OR NEW.superseded_at IS NOT NULL
    OR (NEW.listening_submitted_at IS NULL AND NEW.reading_submitted_at IS NULL) THEN
    NEW.mini_paper_official_submission := false;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.attempt_mode = NEW.attempt_mode AND OLD.test_slug = NEW.test_slug
    AND OLD.generation = NEW.generation AND OLD.superseded_at IS NULL
    AND ROW(OLD.listening_submitted_at,OLD.reading_submitted_at)
      IS NOT DISTINCT FROM ROW(NEW.listening_submitted_at,NEW.reading_submitted_at) THEN
    NEW.mini_paper_official_submission := OLD.mini_paper_official_submission;
    RETURN NEW;
  END IF;
  SELECT a.id INTO accepted FROM assessment.term_test_attempt a
    WHERE a.test_slug = NEW.test_slug AND a.attempt_mode = 'answer_sheet' AND a.superseded_at IS NULL
      AND a.erp_course_class_id = NEW.erp_course_class_id AND a.erp_student_contact_id = NEW.erp_student_contact_id
      AND a.generation = NEW.generation
      AND (a.listening_submitted_at IS NOT NULL OR a.reading_submitted_at IS NOT NULL)
    ORDER BY a.mini_paper_official_submission DESC, least(a.listening_submitted_at,a.reading_submitted_at), a.id
    LIMIT 1;
  IF accepted IS NOT NULL AND accepted <> NEW.id THEN
    RAISE EXCEPTION 'MINI_K56_PAPER_FIRST_SUBMISSION_ALREADY_ACCEPTED' USING ERRCODE = 'P5665';
  END IF;
  NEW.mini_paper_official_submission := true;
  RETURN NEW;
END $$;
CREATE TRIGGER mini_k56_paper_official BEFORE INSERT OR UPDATE
  ON assessment.term_test_attempt FOR EACH ROW EXECUTE FUNCTION assessment.guard_mini_k56_paper_submission();

DROP INDEX assessment.uq_term_test_exam_session_one_active_student;
CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student ON assessment.term_test_exam_session
  (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE listening_submitted_at IS NULL AND superseded_at IS NULL AND NOT mini_cbt_parallel_entry
    AND NOT term1_parallel_entry AND NOT term2_parallel_entry AND mini_paper_profile_id IS NULL;
DROP INDEX assessment.uq_term_test_attempt_one_active_student;
CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student ON assessment.term_test_attempt
  (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE completed_at IS NULL AND superseded_at IS NULL AND NOT mini_cbt_parallel_entry
    AND NOT term1_parallel_entry AND NOT term2_parallel_entry AND NOT mini_paper_parallel_entry;

COMMIT;
