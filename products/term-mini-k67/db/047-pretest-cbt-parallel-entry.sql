BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN pretest_parallel_entry boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT pretest_parallel_entry_session_scope CHECK (
    NOT pretest_parallel_entry OR (test_slug = 'pretest-lesson-16' AND attempt_mode = 'cbt')
  );
ALTER TABLE assessment.term_test_attempt
  ADD COLUMN pretest_parallel_entry boolean NOT NULL DEFAULT false,
  ADD COLUMN pretest_first_submission_guard boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT pretest_parallel_entry_attempt_scope CHECK (
    NOT pretest_parallel_entry OR (test_slug = 'pretest-lesson-16' AND exam_session_id IS NOT NULL)
  );

-- Existing conflicting historical results remain intact. Only new receipts enter this index.
CREATE UNIQUE INDEX uq_pretest_new_official_attempt
  ON assessment.term_test_attempt (definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE pretest_first_submission_guard AND superseded_at IS NULL;

CREATE FUNCTION assessment.guard_pretest_first_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.test_slug = 'pretest-lesson-16' AND OLD.superseded_at IS NULL
      AND NEW.superseded_at IS NULL AND OLD.generation = NEW.generation THEN
    IF (OLD.listening_submitted_at IS NOT NULL
        AND ROW(OLD.listening_submitted_at, OLD.listening_answers)
            IS DISTINCT FROM ROW(NEW.listening_submitted_at, NEW.listening_answers))
      OR (OLD.reading_submitted_at IS NOT NULL
        AND ROW(OLD.reading_submitted_at, OLD.reading_answers)
            IS DISTINCT FROM ROW(NEW.reading_submitted_at, NEW.reading_answers))
 THEN
      RAISE EXCEPTION 'PRETEST_OFFICIAL_SUBMISSION_IMMUTABLE' USING ERRCODE = 'P6762';
    END IF;
  END IF;

  IF NEW.test_slug <> 'pretest-lesson-16' OR NEW.superseded_at IS NOT NULL
      OR (NEW.listening_submitted_at IS NULL AND NEW.reading_submitted_at IS NULL) THEN
    NEW.pretest_first_submission_guard := false;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.test_slug = NEW.test_slug AND OLD.superseded_at IS NULL
      AND ROW(OLD.definition_version, OLD.erp_course_class_id, OLD.erp_student_contact_id, OLD.generation)
          IS NOT DISTINCT FROM ROW(NEW.definition_version, NEW.erp_course_class_id, NEW.erp_student_contact_id, NEW.generation)
      AND (OLD.listening_submitted_at IS NOT NULL OR OLD.reading_submitted_at IS NOT NULL)
      AND (OLD.pretest_first_submission_guard OR NOT (
        (OLD.listening_submitted_at IS NULL AND NEW.listening_submitted_at IS NOT NULL)
        OR (OLD.reading_submitted_at IS NULL AND NEW.reading_submitted_at IS NOT NULL)
      )) THEN
    NEW.pretest_first_submission_guard := OLD.pretest_first_submission_guard;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM assessment.term_test_attempt AS accepted
    WHERE accepted.test_slug = NEW.test_slug
      AND accepted.definition_version = NEW.definition_version
      AND accepted.erp_course_class_id = NEW.erp_course_class_id
      AND accepted.erp_student_contact_id = NEW.erp_student_contact_id
      AND accepted.id <> NEW.id AND accepted.superseded_at IS NULL
      AND (accepted.listening_submitted_at IS NOT NULL OR accepted.reading_submitted_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'PRETEST_FIRST_SUBMISSION_ALREADY_ACCEPTED' USING ERRCODE = 'P6761';
  END IF;

  NEW.pretest_first_submission_guard := true;
  RETURN NEW;
END $$;

CREATE TRIGGER pretest_first_submission_guard
  BEFORE INSERT OR UPDATE ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.guard_pretest_first_submission();

CREATE FUNCTION assessment.bind_pretest_parallel_entry_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.pretest_parallel_entry := NEW.test_slug = 'pretest-lesson-16' AND EXISTS (
    SELECT 1 FROM assessment.term_test_exam_session s
    WHERE s.id = NEW.exam_session_id AND s.pretest_parallel_entry AND s.superseded_at IS NULL
      AND ROW(s.test_slug, s.definition_version, s.erp_course_class_id, s.erp_student_contact_id, s.generation)
        = ROW(NEW.test_slug, NEW.definition_version, NEW.erp_course_class_id, NEW.erp_student_contact_id, NEW.generation)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER pretest_bind_parallel_entry_attempt
  BEFORE INSERT OR UPDATE OF exam_session_id, pretest_parallel_entry, test_slug, definition_version,
    erp_course_class_id, erp_student_contact_id, generation ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.bind_pretest_parallel_entry_attempt();

DROP INDEX assessment.uq_term_test_exam_session_one_active_student;
CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student
  ON assessment.term_test_exam_session (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE listening_submitted_at IS NULL AND superseded_at IS NULL AND NOT term1_parallel_entry AND NOT term2_parallel_entry AND NOT pretest_parallel_entry;

DROP INDEX assessment.uq_term_test_attempt_one_active_student;
CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student
  ON assessment.term_test_attempt (test_slug, definition_version, erp_course_class_id, erp_student_contact_id)
  WHERE completed_at IS NULL AND superseded_at IS NULL AND NOT term1_parallel_entry AND NOT term2_parallel_entry AND NOT pretest_parallel_entry;

CREATE TABLE assessment.pretest_section_continuation (
  LIKE assessment.term1_section_continuation INCLUDING CONSTRAINTS,
  CHECK (section IN ('reading', 'listening')),
  PRIMARY KEY (exam_session_id),
  FOREIGN KEY (exam_session_id) REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE ON assessment.pretest_section_continuation TO k67_app;

CREATE OR REPLACE FUNCTION assessment.check_audio_owner(s assessment.term_test_exam_session) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  continuation text := CASE s.test_slug
    WHEN 'term-test-1' THEN nullif(current_setting('k67.term1_listening_continuation', true), '')
    WHEN 'term-test-2' THEN nullif(current_setting('k67.term2_listening_continuation', true), '')
    WHEN 'pretest-lesson-16' THEN nullif(current_setting('k67.pretest_listening_continuation', true), '')
  END;
  child assessment.term_test_exam_session;
BEGIN
  IF continuation IS NOT NULL THEN
    WITH grants AS (
      SELECT exam_session_id, official_attempt_id, official_generation, section, receipt
        FROM assessment.term1_section_continuation
        WHERE s.test_slug='term-test-1' AND exam_session_id=continuation::uuid
      UNION ALL
      SELECT exam_session_id, official_attempt_id, official_generation, section, receipt
        FROM assessment.term2_section_continuation
        WHERE s.test_slug='term-test-2' AND exam_session_id=continuation::uuid
      UNION ALL
      SELECT exam_session_id, official_attempt_id, official_generation, section, receipt
        FROM assessment.pretest_section_continuation
        WHERE s.test_slug='pretest-lesson-16' AND exam_session_id=continuation::uuid
    )
    SELECT profile.* INTO child FROM grants AS grant_row
      JOIN assessment.term_test_exam_session profile ON profile.id=grant_row.exam_session_id
      JOIN assessment.term_test_attempt official ON official.id=grant_row.official_attempt_id
    WHERE grant_row.section='listening' AND grant_row.receipt IS NULL
      AND official.id=s.attempt_id AND official.exam_session_id=s.id AND official.generation=s.generation
      AND grant_row.official_generation=s.generation AND official.superseded_at IS NULL
      AND profile.superseded_at IS NULL AND profile.listening_started_at IS NOT NULL
      AND ((s.test_slug='term-test-1' AND profile.term1_parallel_entry)
        OR (s.test_slug='term-test-2' AND profile.term2_parallel_entry)
        OR (s.test_slug='pretest-lesson-16' AND profile.pretest_parallel_entry))
      AND ROW(profile.test_slug,profile.definition_version,profile.erp_course_class_id,profile.erp_student_contact_id)
        = ROW(s.test_slug,s.definition_version,s.erp_course_class_id,s.erp_student_contact_id);
    IF FOUND THEN s := child; END IF;
  END IF;

  IF s.audio_owner_protocol=1 AND (s.audio_owner_id IS NULL
    OR coalesce(current_setting('k67.owner_id',true),'') IS DISTINCT FROM s.audio_owner_id::text
    OR coalesce(current_setting('k67.owner_epoch',true),'') IS DISTINCT FROM s.audio_owner_epoch::text
    OR coalesce(current_setting('k67.owner_generation',true),'') IS DISTINCT FROM s.generation::text
    OR encode(sha256(convert_to(coalesce(current_setting('k67.owner_proof',true),''),'UTF8')),'hex') IS DISTINCT FROM s.audio_owner_proof_hash)
  THEN RAISE EXCEPTION 'AUDIO_OWNER_REQUIRED' USING ERRCODE='P6703'; END IF;
END $$;

COMMIT;
