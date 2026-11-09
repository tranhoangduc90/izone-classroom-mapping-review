-- Xác nhận của chủ nháp chỉ cho phép một phiên bản được giao vào đúng lớp và buổi.
CREATE TABLE IF NOT EXISTS learning.class_draft_delivery (
  operation_id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES learning.form_draft(id),
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  draft_hash text NOT NULL CHECK (draft_hash ~ '^[a-f0-9]{64}$'),
  form_version_id uuid NOT NULL UNIQUE REFERENCES learning.form_version(id) DEFERRABLE INITIALLY DEFERRED,
  owner_email text NOT NULL,
  erp_course_class_id bigint NOT NULL,
  session_number integer NOT NULL CHECK (session_number BETWEEN 1 AND 100),
  portal_session_id bigint NOT NULL,
  starts_at text NOT NULL CHECK (starts_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON learning.class_draft_delivery TO learning_api;

DROP TRIGGER IF EXISTS protect_class_draft_delivery ON learning.class_draft_delivery;
CREATE TRIGGER protect_class_draft_delivery BEFORE UPDATE OR DELETE ON learning.class_draft_delivery
  FOR EACH ROW EXECUTE FUNCTION learning.protect_form_publication();

CREATE OR REPLACE FUNCTION learning.enforce_scored_form_second_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_scored_item boolean;
BEGIN
  IF NEW.status <> 'published' THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.public_definition -> 'blocks', '[]'::jsonb)) AS block,
                  jsonb_array_elements(COALESCE(block -> 'items', '[]'::jsonb)) AS item
    WHERE COALESCE((item ->> 'maxScore')::numeric, 0) > 0
       OR COALESCE(item ->> 'graderType', 'none') <> 'none'
  ) INTO has_scored_item;
  IF has_scored_item AND (NEW.approved_by_email IS NULL OR (
    NEW.approved_by_email = NEW.created_by_email
    AND NOT EXISTS (
      SELECT 1 FROM learning.course_content_authority AS authority
      WHERE lower(trim(authority.reviewer_email)) = lower(trim(NEW.created_by_email))
        AND authority.course_code = lower(trim(COALESCE(NEW.public_definition ->> 'courseCode', '')))
        AND authority.can_self_approve_scored_forms = true AND authority.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM learning.class_draft_delivery AS delivery JOIN learning.form_draft AS draft ON draft.id=delivery.draft_id
      WHERE delivery.form_version_id=NEW.id AND lower(delivery.owner_email)=lower(NEW.created_by_email)
        AND lower(draft.owner_email)=lower(delivery.owner_email)
        AND draft.revision=delivery.draft_revision AND draft.content_hash=delivery.draft_hash
    )
  )) THEN
    RAISE EXCEPTION 'FORM_SECOND_APPROVAL_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION learning.guard_class_draft_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scoped learning.class_draft_delivery%ROWTYPE;
  target_version uuid;
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME IN ('form_version','form_grading_key') THEN
    IF TG_TABLE_NAME='form_version' THEN target_version:=OLD.id;
    ELSE target_version:=OLD.form_version_id; END IF;
  ELSE
    target_version:=NEW.form_version_id;
  END IF;
  IF TG_TABLE_NAME='form_assignment' AND TG_OP='UPDATE' THEN
    IF NEW.form_version_id IS DISTINCT FROM OLD.form_version_id
      AND EXISTS (SELECT 1 FROM learning.class_draft_delivery WHERE form_version_id=OLD.form_version_id) THEN
      RAISE EXCEPTION 'CLASS_DRAFT_DELIVERY_TARGET_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO scoped FROM learning.class_draft_delivery WHERE form_version_id=target_version;
  IF FOUND THEN
    IF TG_TABLE_NAME='form_assignment' THEN
      IF NEW.erp_course_class_id IS DISTINCT FROM scoped.erp_course_class_id OR NEW.session_number IS DISTINCT FROM scoped.session_number
        OR lower(NEW.created_by_email) IS DISTINCT FROM lower(scoped.owner_email) THEN
        RAISE EXCEPTION 'CLASS_DRAFT_DELIVERY_TARGET_MISMATCH' USING ERRCODE='23514';
      END IF;
      IF TG_OP='INSERT' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(scoped.form_version_id::text, 0));
        IF EXISTS (SELECT 1 FROM learning.form_assignment WHERE form_version_id=scoped.form_version_id) THEN
          RAISE EXCEPTION 'CLASS_DRAFT_DELIVERY_TARGET_MISMATCH' USING ERRCODE='23514';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'CLASS_DRAFT_DELIVERY_CONTENT_SCOPED' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guard_class_draft_assignment ON learning.form_assignment;
CREATE TRIGGER guard_class_draft_assignment BEFORE INSERT OR UPDATE OF form_version_id,erp_course_class_id,session_number,created_by_email
  ON learning.form_assignment FOR EACH ROW EXECUTE FUNCTION learning.guard_class_draft_delivery();
DROP TRIGGER IF EXISTS guard_class_draft_publication ON learning.form_publication;
CREATE TRIGGER guard_class_draft_publication BEFORE INSERT ON learning.form_publication
  FOR EACH ROW EXECUTE FUNCTION learning.guard_class_draft_delivery();
DROP TRIGGER IF EXISTS guard_class_draft_version ON learning.form_version;
CREATE TRIGGER guard_class_draft_version BEFORE UPDATE OR DELETE ON learning.form_version
  FOR EACH ROW EXECUTE FUNCTION learning.guard_class_draft_delivery();
DROP TRIGGER IF EXISTS guard_class_draft_key ON learning.form_grading_key;
CREATE TRIGGER guard_class_draft_key BEFORE UPDATE OR DELETE ON learning.form_grading_key
  FOR EACH ROW EXECUTE FUNCTION learning.guard_class_draft_delivery();
