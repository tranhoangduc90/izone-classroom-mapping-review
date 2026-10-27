-- Allow metadata pinning in the lobby. All active Listening writes stay guarded.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION assessment.guard_audio_owner_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.generation IS DISTINCT FROM OLD.generation OR (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) THEN
   NEW.audio_owner_id=NULL;NEW.audio_owner_page_id=NULL;NEW.audio_owner_proof_hash=NULL;NEW.audio_owner_epoch=OLD.audio_owner_epoch+1;
 ELSIF ROW(NEW.listening_started_at,NEW.listening_submitted_at,NEW.listening_draft,NEW.listening_draft_revision,
   NEW.listening_audio_checkpoint_seconds,NEW.listening_recovery_seconds,NEW.listening_audio_incident_id)
   IS DISTINCT FROM ROW(OLD.listening_started_at,OLD.listening_submitted_at,OLD.listening_draft,OLD.listening_draft_revision,
   OLD.listening_audio_checkpoint_seconds,OLD.listening_recovery_seconds,OLD.listening_audio_incident_id)
   OR (OLD.listening_started_at IS NOT NULL AND NEW.listening_audio_manifest IS DISTINCT FROM OLD.listening_audio_manifest)
 THEN PERFORM assessment.check_audio_owner(OLD); END IF;
 RETURN NEW;
END $$;
COMMIT;
