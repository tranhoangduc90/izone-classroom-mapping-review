BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE assessment.term2_section_continuation (
  LIKE assessment.term1_section_continuation INCLUDING CONSTRAINTS,
  PRIMARY KEY (exam_session_id),
  FOREIGN KEY (exam_session_id) REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE ON assessment.term2_section_continuation TO k67_app;

CREATE OR REPLACE FUNCTION assessment.check_audio_owner(s assessment.term_test_exam_session) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  continuation text := CASE s.test_slug
    WHEN 'term-test-1' THEN nullif(current_setting('k67.term1_listening_continuation', true), '')
    WHEN 'term-test-2' THEN nullif(current_setting('k67.term2_listening_continuation', true), '')
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
    )
    SELECT profile.* INTO child FROM grants AS grant_row
      JOIN assessment.term_test_exam_session profile ON profile.id=grant_row.exam_session_id
      JOIN assessment.term_test_attempt official ON official.id=grant_row.official_attempt_id
    WHERE grant_row.section='listening' AND grant_row.receipt IS NULL
      AND official.id=s.attempt_id AND official.exam_session_id=s.id AND official.generation=s.generation
      AND grant_row.official_generation=s.generation AND official.superseded_at IS NULL
      AND profile.superseded_at IS NULL AND profile.listening_started_at IS NOT NULL
      AND ((s.test_slug='term-test-1' AND profile.term1_parallel_entry)
        OR (s.test_slug='term-test-2' AND profile.term2_parallel_entry))
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
