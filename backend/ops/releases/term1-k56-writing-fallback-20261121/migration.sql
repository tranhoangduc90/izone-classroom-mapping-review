-- Prototype for the isolated K56 release fixture. The deployment schema is
-- resolved separately. Keep terminal Writing data readable after grant expiry.
BEGIN;
SET LOCAL lock_timeout = '200ms';
SET LOCAL statement_timeout = '2s';
LOCK TABLE ONLY assessment.term_test_attempt IN ACCESS EXCLUSIVE MODE NOWAIT;

ALTER TABLE assessment.term_test_attempt
  ADD COLUMN term1_writing_fallback_grant_id uuid;

CREATE FUNCTION assessment.verify_term1_writing_fallback_grant() RETURNS trigger
LANGUAGE plpgsql
AS $grant$
BEGIN
  IF NEW.writing_started_at IS NULL AND NEW.writing_updated_at IS NULL
    AND NEW.writing_submitted_at IS NULL THEN
    NEW.term1_writing_fallback_grant_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.term1_writing_fallback_grant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.term1_writing_fallback_grant_id IS NOT DISTINCT FROM OLD.term1_writing_fallback_grant_id
      AND NEW.id = OLD.id
      AND NEW.generation = OLD.generation
      AND NEW.exam_session_id IS NOT DISTINCT FROM OLD.exam_session_id
      AND NEW.erp_course_class_id IS NOT DISTINCT FROM OLD.erp_course_class_id
      AND NEW.test_slug = OLD.test_slug
      AND NEW.attempt_mode = OLD.attempt_mode THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.test_slug IS DISTINCT FROM 'term-test-1-k56'
    OR NEW.attempt_mode IS DISTINCT FROM 'cbt'
    OR NOT EXISTS (
      SELECT 1 FROM assessment.term1_skill_grant AS linked_grant
      WHERE linked_grant.id = NEW.term1_writing_fallback_grant_id
        AND linked_grant.attempt_id = NEW.id
        AND linked_grant.session_id = NEW.exam_session_id
        AND linked_grant.generation = NEW.generation
        AND linked_grant.class_id = NEW.erp_course_class_id
        AND linked_grant.section = 'writing'
        AND linked_grant.bound_at IS NOT NULL
        AND linked_grant.revoked_at IS NULL
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'TERM1_WRITING_FALLBACK_GRANT_SCOPE_INVALID';
  END IF;
  RETURN NEW;
END
$grant$;

CREATE TRIGGER term1_writing_fallback_grant_scope
  BEFORE INSERT OR UPDATE OF term1_writing_fallback_grant_id, id, test_slug, attempt_mode,
    generation, exam_session_id, erp_course_class_id, writing_started_at, writing_updated_at, writing_submitted_at
  ON assessment.term_test_attempt
  FOR EACH ROW EXECUTE FUNCTION assessment.verify_term1_writing_fallback_grant();

DO $migration$
DECLARE
  previous_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous_check
    FROM pg_constraint
    WHERE conrelid = 'assessment.term_test_attempt'::regclass
      AND conname = 'term_test_attempt_writing_order_check' AND contype = 'c' AND convalidated;

  ALTER TABLE assessment.term_test_attempt DROP CONSTRAINT term_test_attempt_writing_order_check;
  EXECUTE format('ALTER TABLE assessment.term_test_attempt
    ADD CONSTRAINT term_test_attempt_writing_order_check CHECK ((%s) OR (
      term1_writing_fallback_grant_id IS NOT NULL
      AND test_slug = %L AND attempt_mode = %L
      AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL
      AND writing_deadline_at IS NOT NULL AND writing_deadline_at > writing_started_at
      AND (writing_submitted_at IS NULL OR writing_submitted_at >= writing_started_at)
    )) NOT VALID', previous_check, 'term-test-1-k56', 'cbt');
END
$migration$;

COMMIT;
