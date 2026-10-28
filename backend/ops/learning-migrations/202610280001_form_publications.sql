-- Xuất bản khóa phiên bản trong kho; Giao bài tạo assignment riêng cho từng lớp/buổi.
-- Không đổi trạng thái/hash/ID hoặc khôi phục dữ liệu của các phiếu đã phát theo luồng cũ.
ALTER TABLE learning.form_library_entry ADD COLUMN IF NOT EXISTS approved_by_email TEXT;
ALTER TABLE learning.form_library_entry ADD COLUMN IF NOT EXISTS approval_hash TEXT;
ALTER TABLE learning.form_library_entry ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS learning.form_publication (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL UNIQUE,
  source_draft_id UUID UNIQUE REFERENCES learning.form_draft(id),
  source_assignment_id UUID UNIQUE REFERENCES learning.form_assignment(id),
  source_library_id UUID UNIQUE REFERENCES learning.form_library_entry(id),
  source_content_hash TEXT CHECK(source_content_hash ~ '^[a-f0-9]{64}$'),
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  form_version_id UUID NOT NULL UNIQUE REFERENCES learning.form_version(id),
  owner_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(num_nonnulls(source_draft_id,source_assignment_id,source_library_id)=1)
);
CREATE TABLE IF NOT EXISTS learning.form_delivery (
  operation_id UUID PRIMARY KEY,
  publication_id UUID NOT NULL REFERENCES learning.form_publication(id),
  owner_email TEXT NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  session_number INTEGER NOT NULL CHECK(session_number BETWEEN 1 AND 100),
  assignment_id UUID NOT NULL UNIQUE REFERENCES learning.form_assignment(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning.form_publication_lock(source_key TEXT PRIMARY KEY);
GRANT SELECT,INSERT,UPDATE ON learning.form_publication_lock TO learning_api;
CREATE OR REPLACE FUNCTION learning.protect_form_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FORM_PUBLICATION_IMMUTABLE' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS protect_form_publication ON learning.form_publication;
CREATE TRIGGER protect_form_publication BEFORE UPDATE OR DELETE ON learning.form_publication
  FOR EACH ROW EXECUTE FUNCTION learning.protect_form_publication();
DROP TRIGGER IF EXISTS protect_form_delivery ON learning.form_delivery;
CREATE TRIGGER protect_form_delivery BEFORE UPDATE OR DELETE ON learning.form_delivery
  FOR EACH ROW EXECUTE FUNCTION learning.protect_form_publication();
CREATE OR REPLACE FUNCTION learning.protect_library_published_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM learning.form_publication WHERE source_draft_id=OLD.id
    OR form_version_id::text=OLD.public_definition->>'formVersionId') THEN
    RAISE EXCEPTION 'LIBRARY_PUBLISHED_DRAFT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS protect_library_published_draft ON learning.form_draft;
CREATE TRIGGER protect_library_published_draft BEFORE UPDATE OR DELETE ON learning.form_draft
  FOR EACH ROW EXECUTE FUNCTION learning.protect_library_published_draft();
GRANT SELECT,INSERT ON learning.form_publication,learning.form_delivery TO learning_api;

-- Luồng cũ bảo vệ version/key qua draft.status='published'. Luồng mới không đổi trạng thái đó,
-- vì vậy khóa trực tiếp mọi phiên bản đã có trong form_publication, kể cả chưa giao lớp nào.
CREATE OR REPLACE FUNCTION learning.protect_library_published_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_version UUID;
BEGIN
  IF TG_TABLE_NAME='form_version' THEN target_version:=OLD.id;
  ELSE target_version:=OLD.form_version_id; END IF;
  IF EXISTS(SELECT 1 FROM learning.form_publication WHERE form_version_id=target_version) THEN
    RAISE EXCEPTION 'LIBRARY_PUBLISHED_CONTENT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_library_published_version ON learning.form_version;
CREATE TRIGGER protect_library_published_version BEFORE UPDATE OR DELETE ON learning.form_version
  FOR EACH ROW EXECUTE FUNCTION learning.protect_library_published_content();
DROP TRIGGER IF EXISTS protect_library_published_key ON learning.form_grading_key;
CREATE TRIGGER protect_library_published_key BEFORE UPDATE OR DELETE ON learning.form_grading_key
  FOR EACH ROW EXECUTE FUNCTION learning.protect_library_published_content();
