-- Bổ sung dữ liệu, chưa đổi hạn link cũ. Chỉ backfill sau khi mọi API đọc được NULL.
ALTER TABLE learning.student_progress_access ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE learning.student_progress_access ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
ALTER TABLE learning.student_progress_access ADD COLUMN IF NOT EXISTS token_key_version TEXT;
CREATE TABLE IF NOT EXISTS learning.student_progress_link_operation (
  operation_id UUID PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  actor_email TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('resolve','rotate','revoke')),
  access_id UUID REFERENCES learning.student_progress_access(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning.student_session_comment (
  erp_course_class_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 100),
  note_text TEXT NOT NULL CHECK (char_length(note_text) BETWEEN 1 AND 1000),
  visibility TEXT NOT NULL CHECK (visibility IN ('visible','hidden')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  author_display_name TEXT NOT NULL,
  updated_by_email TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (erp_course_class_id,student_ref,session_number)
);
CREATE TABLE IF NOT EXISTS learning.student_session_comment_revision (
  operation_id UUID PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  session_number INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('publish','edit','hide')),
  note_text TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('visible','hidden')),
  author_display_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (erp_course_class_id,student_ref,session_number,revision),
  FOREIGN KEY (erp_course_class_id,student_ref,session_number)
    REFERENCES learning.student_session_comment(erp_course_class_id,student_ref,session_number)
);
CREATE INDEX IF NOT EXISTS session_comment_class_visibility
  ON learning.student_session_comment (erp_course_class_id,visibility,student_ref);
-- Không thu ngắn kế hoạch làm mất buổi đã có nhận xét, kể cả nhận xét đang ẩn.
CREATE OR REPLACE FUNCTION learning.guard_comment_session_plan() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS (SELECT 1 FROM learning.student_session_comment
    WHERE erp_course_class_id=NEW.erp_course_class_id AND session_number>NEW.total_sessions) THEN
    RAISE EXCEPTION 'Kế hoạch phải giữ các buổi đã có nhận xét.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_comment_sessions ON learning.class_journey_plan;
CREATE TRIGGER preserve_comment_sessions BEFORE INSERT OR UPDATE ON learning.class_journey_plan
  FOR EACH ROW EXECUTE FUNCTION learning.guard_comment_session_plan();
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='learning_api') THEN
  GRANT SELECT,INSERT ON learning.student_progress_link_operation TO learning_api;
  GRANT SELECT,INSERT,UPDATE ON learning.student_session_comment TO learning_api;
  GRANT SELECT,INSERT ON learning.student_session_comment_revision TO learning_api;
END IF; END $$;
