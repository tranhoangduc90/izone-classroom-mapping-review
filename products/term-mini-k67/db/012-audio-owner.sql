-- Một chủ phát cho phiên K67; không tự hết quyền khi máy đang nghe mất mạng.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE assessment.term_test_audio_incident DROP CONSTRAINT term_test_audio_incident_reason_check;
ALTER TABLE assessment.term_test_audio_incident ADD CONSTRAINT term_test_audio_incident_reason_check CHECK
 (reason IN ('manual','pause','waiting','stalled','error','startup_failed','reload','muted','freeze','lifecycle','output_lost','output_change','media_pause','media_seek'));
ALTER TABLE assessment.term_test_exam_session
 ADD COLUMN audio_owner_protocol integer NOT NULL DEFAULT 0,
 ADD COLUMN audio_owner_id uuid,
 ADD COLUMN audio_owner_page_id uuid,
 ADD COLUMN audio_owner_proof_hash text,
 ADD COLUMN audio_owner_epoch bigint NOT NULL DEFAULT 0;

CREATE FUNCTION assessment.check_audio_owner(s assessment.term_test_exam_session) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF s.audio_owner_protocol=1 AND (s.audio_owner_id IS NULL
   OR coalesce(current_setting('k67.owner_id',true),'') IS DISTINCT FROM s.audio_owner_id::text
   OR coalesce(current_setting('k67.owner_epoch',true),'') IS DISTINCT FROM s.audio_owner_epoch::text
   OR coalesce(current_setting('k67.owner_generation',true),'') IS DISTINCT FROM s.generation::text
   OR encode(sha256(convert_to(coalesce(current_setting('k67.owner_proof',true),''),'UTF8')),'hex') IS DISTINCT FROM s.audio_owner_proof_hash)
 THEN RAISE EXCEPTION 'AUDIO_OWNER_REQUIRED' USING ERRCODE='P6703'; END IF;
END $$;
CREATE FUNCTION assessment.guard_audio_owner_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.generation IS DISTINCT FROM OLD.generation OR (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) THEN
   NEW.audio_owner_id=NULL;NEW.audio_owner_page_id=NULL;NEW.audio_owner_proof_hash=NULL;NEW.audio_owner_epoch=OLD.audio_owner_epoch+1;
 ELSIF ROW(NEW.listening_started_at,NEW.listening_submitted_at,NEW.listening_draft,NEW.listening_draft_revision,
   NEW.listening_audio_checkpoint_seconds,NEW.listening_recovery_seconds,NEW.listening_audio_incident_id,NEW.listening_audio_manifest)
   IS DISTINCT FROM ROW(OLD.listening_started_at,OLD.listening_submitted_at,OLD.listening_draft,OLD.listening_draft_revision,
   OLD.listening_audio_checkpoint_seconds,OLD.listening_recovery_seconds,OLD.listening_audio_incident_id,OLD.listening_audio_manifest)
 THEN PERFORM assessment.check_audio_owner(OLD); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER term_test_audio_owner_session BEFORE UPDATE ON assessment.term_test_exam_session
 FOR EACH ROW EXECUTE FUNCTION assessment.guard_audio_owner_session();
CREATE FUNCTION assessment.guard_audio_owner_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s assessment.term_test_exam_session;
BEGIN
 IF (TG_OP='INSERT' AND NEW.listening_submitted_at IS NOT NULL) OR (TG_OP='UPDATE'
   AND NEW.generation=OLD.generation AND ROW(NEW.listening_answers,NEW.listening_submitted_at)
     IS DISTINCT FROM ROW(OLD.listening_answers,OLD.listening_submitted_at)) THEN
   SELECT * INTO s FROM assessment.term_test_exam_session WHERE id=NEW.exam_session_id
     OR (NEW.exam_session_id IS NULL AND test_slug=NEW.test_slug AND erp_course_class_id=NEW.erp_course_class_id
       AND erp_student_contact_id=NEW.erp_student_contact_id AND superseded_at IS NULL)
     ORDER BY prepared_at DESC LIMIT 1 FOR UPDATE;
   IF FOUND THEN PERFORM assessment.check_audio_owner(s); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER term_test_audio_owner_attempt BEFORE INSERT OR UPDATE ON assessment.term_test_attempt
 FOR EACH ROW EXECUTE FUNCTION assessment.guard_audio_owner_attempt();
COMMIT;
