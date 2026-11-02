-- Nháp riêng theo tài khoản. Dòng rỗng sau gửi giữ revision để tránh ghi đè ABA.
CREATE TABLE IF NOT EXISTS learning.teacher_session_comment_draft (
  teacher_email TEXT NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 100),
  note_text TEXT CHECK (note_text IS NULL OR char_length(note_text) BETWEEN 1 AND 1000),
  revision INTEGER NOT NULL CHECK (revision > 0),
  base_comment_revision INTEGER NOT NULL CHECK (base_comment_revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (teacher_email, erp_course_class_id, student_ref, session_number)
);
CREATE TABLE IF NOT EXISTS learning.teacher_session_comment_draft_operation (
  operation_id UUID PRIMARY KEY,
  teacher_email TEXT NOT NULL,
  erp_course_class_id BIGINT NOT NULL,
  student_ref UUID NOT NULL,
  session_number INTEGER NOT NULL,
  note_text TEXT NOT NULL,
  revision INTEGER NOT NULL,
  base_comment_revision INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION learning.guard_comment_session_plan() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS (SELECT 1 FROM learning.student_session_comment
    WHERE erp_course_class_id=NEW.erp_course_class_id AND session_number>NEW.total_sessions)
    OR EXISTS (SELECT 1 FROM learning.teacher_session_comment_draft
    WHERE erp_course_class_id=NEW.erp_course_class_id AND session_number>NEW.total_sessions AND note_text IS NOT NULL) THEN
    RAISE EXCEPTION 'Kế hoạch phải giữ các buổi đã có nhận xét hoặc nháp.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='learning_api') THEN
  GRANT SELECT,INSERT ON learning.teacher_session_comment_draft TO learning_api;
  GRANT UPDATE (note_text,revision,base_comment_revision,updated_at) ON learning.teacher_session_comment_draft TO learning_api;
  GRANT SELECT,INSERT ON learning.teacher_session_comment_draft_operation TO learning_api;
END IF; END $$;
