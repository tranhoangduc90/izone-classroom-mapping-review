-- Nhận nháp của giảng viên, giữ definition và khóa chấm trong DB riêng của Learning.
-- Revision/hash khóa nội dung đã duyệt; không tạo assignment/roster/điểm danh khi lưu nháp.
-- Migration thêm kho nháp và cổng phát hành chung. Chưa áp dụng production trong task xây dựng.
CREATE TABLE IF NOT EXISTS learning.form_draft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  create_operation_id UUID NOT NULL UNIQUE,
  source_assignment_id UUID REFERENCES learning.form_assignment(id),
  owner_email TEXT NOT NULL,
  erp_course_class_id BIGINT NOT NULL REFERENCES mapping.classroom_course_mapping(erp_course_class_id),
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 100),
  public_definition JSONB NOT NULL CHECK (jsonb_typeof(public_definition)='object'),
  private_definition JSONB NOT NULL CHECK (jsonb_typeof(private_definition)='object'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','approved','published')),
  approved_hash TEXT,
  approved_revision INTEGER,
  approved_by_email TEXT,
  approved_at TIMESTAMPTZ,
  published_assignment_id UUID REFERENCES learning.form_assignment(id),
  publish_operation_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (public_definition->>'formVersionId'=private_definition->>'formVersionId'),
  CHECK ((status IN ('draft','pending_review') AND approved_hash IS NULL AND approved_revision IS NULL
    AND approved_by_email IS NULL AND approved_at IS NULL) OR
    (status IN ('approved','published') AND approved_hash=content_hash AND approved_revision=revision
    AND approved_by_email IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((status='published' AND published_assignment_id IS NOT NULL AND publish_operation_id IS NOT NULL)
    OR (status<>'published' AND published_assignment_id IS NULL AND publish_operation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS form_draft_owner_updated ON learning.form_draft(owner_email,updated_at DESC);
CREATE INDEX IF NOT EXISTS form_draft_review ON learning.form_draft(status,erp_course_class_id,updated_at DESC);

CREATE OR REPLACE FUNCTION learning.protect_published_form_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='published' THEN
    RAISE EXCEPTION 'PUBLISHED_FORM_DRAFT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_published_form_draft ON learning.form_draft;
CREATE TRIGGER protect_published_form_draft BEFORE UPDATE OR DELETE ON learning.form_draft
  FOR EACH ROW EXECUTE FUNCTION learning.protect_published_form_draft();
GRANT SELECT,INSERT,UPDATE ON learning.form_draft TO learning_api;
CREATE TABLE IF NOT EXISTS learning.form_draft_class_lock (
  erp_course_class_id BIGINT PRIMARY KEY REFERENCES mapping.classroom_course_mapping(erp_course_class_id)
);
GRANT SELECT,INSERT,UPDATE ON learning.form_draft_class_lock TO learning_api;
GRANT SELECT ON mapping.reviewer_class_assignment TO learning_api;

-- Quyền xem thử được đọc lại từ tài khoản hiện hành, không dùng quyền cũ trong grant.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='mapping'
    AND table_name='reviewer_account' AND column_name='role') THEN
    GRANT SELECT (role,can_access_all_classes) ON mapping.reviewer_account TO learning_api;
  END IF;
END $$;

-- Mọi đường phát hành, kể cả API thư viện cũ, cùng khóa lớp và kiểm buổi đã có phiếu.
-- Không sửa dữ liệu cũ hoặc chặn thao tác đóng phiếu đã tồn tại.
CREATE OR REPLACE FUNCTION learning.lock_session_assignment_class() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Giữ mã phiếu ổn định để kiểm ở cuối transaction không mất dấu dòng vừa tạo.
  IF TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'ASSIGNMENT_ID_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NEW.status NOT IN ('published','closed') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.erp_course_class_id=NEW.erp_course_class_id AND OLD.session_number=NEW.session_number
      AND OLD.status IN ('published','closed') THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO learning.form_draft_class_lock VALUES (NEW.erp_course_class_id) ON CONFLICT DO NOTHING;
  PERFORM erp_course_class_id FROM learning.form_draft_class_lock
    WHERE erp_course_class_id=NEW.erp_course_class_id FOR UPDATE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lock_session_assignment_class ON learning.form_assignment;
CREATE TRIGGER lock_session_assignment_class BEFORE INSERT OR UPDATE ON learning.form_assignment
  FOR EACH ROW EXECUTE FUNCTION learning.lock_session_assignment_class();

-- Kiểm ở cuối transaction để luồng thay thế được duyệt có thể tạo bản mới rồi retire bản cũ.
-- API publish thường vẫn kiểm ngay; cổng này bảo vệ cả script/đường ghi khác.
CREATE OR REPLACE FUNCTION learning.prevent_duplicate_session_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_assignment learning.form_assignment%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.erp_course_class_id=NEW.erp_course_class_id AND OLD.session_number=NEW.session_number
      AND OLD.status IN ('published','closed') THEN RETURN NULL; END IF;
  END IF;
  SELECT * INTO current_assignment FROM learning.form_assignment WHERE id=NEW.id;
  IF NOT FOUND OR current_assignment.status NOT IN ('published','closed') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM learning.form_assignment WHERE erp_course_class_id=current_assignment.erp_course_class_id
    AND session_number=current_assignment.session_number AND status IN ('published','closed') AND id<>NEW.id) THEN
    RAISE EXCEPTION 'ASSIGNMENT_SESSION_CONFLICT'
      USING ERRCODE='23505',CONSTRAINT='assignment_session_once';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS prevent_duplicate_session_assignment ON learning.form_assignment;
CREATE CONSTRAINT TRIGGER prevent_duplicate_session_assignment AFTER INSERT OR UPDATE ON learning.form_assignment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION learning.prevent_duplicate_session_assignment();

-- Chỉ khóa phiên bản/đáp án phát hành qua luồng nháp mới; phiếu cũ giữ hợp đồng vận hành hiện hành.
CREATE OR REPLACE FUNCTION learning.protect_draft_published_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_version TEXT;
BEGIN
  IF TG_TABLE_NAME='form_version' THEN target_version:=OLD.id::text;
  ELSE target_version:=OLD.form_version_id::text; END IF;
  IF EXISTS (SELECT 1 FROM learning.form_draft WHERE status='published'
    AND public_definition->>'formVersionId'=target_version) THEN
    RAISE EXCEPTION 'PUBLISHED_FORM_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_draft_published_version ON learning.form_version;
CREATE TRIGGER protect_draft_published_version BEFORE UPDATE OR DELETE ON learning.form_version
  FOR EACH ROW EXECUTE FUNCTION learning.protect_draft_published_content();
DROP TRIGGER IF EXISTS protect_draft_published_key ON learning.form_grading_key;
CREATE TRIGGER protect_draft_published_key BEFORE UPDATE OR DELETE ON learning.form_grading_key
  FOR EACH ROW EXECUTE FUNCTION learning.protect_draft_published_content();
