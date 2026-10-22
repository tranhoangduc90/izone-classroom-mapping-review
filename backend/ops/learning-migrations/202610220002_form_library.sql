BEGIN;
-- Kho phiếu giữ bản chụp nội dung/đáp án; sửa nháp hoặc phiếu đã giao không đổi bản chụp.
CREATE TABLE IF NOT EXISTS learning.form_library_entry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL UNIQUE,
 owner_email text NOT NULL,
 sharing_scope text NOT NULL CHECK (sharing_scope IN ('personal','izone')),
 source_draft_id uuid NOT NULL REFERENCES learning.form_draft(id),
 source_revision integer NOT NULL,
 course_code text,
 title text NOT NULL,
 public_definition jsonb NOT NULL,
 private_definition jsonb NOT NULL,
 content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS form_library_owner_scope ON learning.form_library_entry(owner_email,sharing_scope,created_at DESC);
GRANT SELECT,INSERT ON learning.form_library_entry TO learning_api;
COMMIT;
