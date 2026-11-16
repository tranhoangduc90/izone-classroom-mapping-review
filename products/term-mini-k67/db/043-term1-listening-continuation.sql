BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE assessment.term1_listening_continuation (
  exam_session_id uuid PRIMARY KEY REFERENCES assessment.term_test_exam_session(id) ON DELETE CASCADE,
  official_attempt_id uuid NOT NULL,
  official_generation bigint NOT NULL,
  operation_id uuid,
  payload_hash text,
  receipt jsonb,
  CHECK ((operation_id IS NULL AND payload_hash IS NULL AND receipt IS NULL)
      OR (operation_id IS NOT NULL AND payload_hash IS NOT NULL AND receipt IS NOT NULL))
);
GRANT SELECT, INSERT, UPDATE ON assessment.term1_listening_continuation TO k67_app;

-- The native commit may write the official row from a different, independently
-- authorized Listening session. Only a current grant for this row and generation
-- can substitute the session used by the existing owner check.
CREATE OR REPLACE FUNCTION assessment.check_audio_owner(s assessment.term_test_exam_session) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  continuation text := nullif(current_setting('k67.term1_listening_continuation', true), '');
  child assessment.term_test_exam_session;
BEGIN
  IF continuation IS NOT NULL AND s.test_slug = 'term-test-1' THEN
    SELECT profile.* INTO child FROM assessment.term1_listening_continuation grant_row
      JOIN assessment.term_test_exam_session profile ON profile.id=grant_row.exam_session_id
      JOIN assessment.term_test_attempt official ON official.id=grant_row.official_attempt_id
    WHERE profile.id::text=continuation AND grant_row.receipt IS NULL
      AND official.id=s.attempt_id AND official.exam_session_id=s.id AND official.generation=s.generation
      AND grant_row.official_generation=s.generation AND official.superseded_at IS NULL
      AND profile.superseded_at IS NULL AND profile.listening_started_at IS NOT NULL
      AND profile.term1_parallel_entry AND ROW(profile.test_slug,profile.definition_version,
        profile.erp_course_class_id,profile.erp_student_contact_id)
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
