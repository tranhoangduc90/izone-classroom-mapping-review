-- Ghim định danh audio theo phiên, không lưu file rõ hoặc khóa giải mã trong database.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN listening_audio_manifest jsonb;
ALTER TABLE assessment.term_test_audio_incident DROP CONSTRAINT term_test_audio_incident_reason_check;
ALTER TABLE assessment.term_test_audio_incident ADD CONSTRAINT term_test_audio_incident_reason_check
  CHECK (reason IN ('manual','pause','waiting','stalled','error','startup_failed','reload'));
COMMIT;
