-- Một phiếu trong kho có nhiều revision nội bộ; không sửa draft/version đã xuất bản.
CREATE TABLE IF NOT EXISTS learning.form_worksheet (
 id uuid PRIMARY KEY REFERENCES learning.form_draft(id),
 owner_email text NOT NULL,
 current_draft_id uuid NOT NULL UNIQUE REFERENCES learning.form_draft(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning.form_worksheet_revision (
 draft_id uuid PRIMARY KEY REFERENCES learning.form_draft(id),
 worksheet_id uuid NOT NULL REFERENCES learning.form_worksheet(id),
 parent_draft_id uuid REFERENCES learning.form_draft(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS form_worksheet_revision_root ON learning.form_worksheet_revision(worksheet_id);
GRANT SELECT,INSERT,UPDATE ON learning.form_worksheet TO learning_api;
GRANT SELECT,INSERT ON learning.form_worksheet_revision TO learning_api;

-- Nguồn là thuộc tính của lần giao; không suy lại theo tab đang xem hoặc trạng thái kho sau này.
CREATE TABLE IF NOT EXISTS learning.form_assignment_origin (
 assignment_id uuid PRIMARY KEY REFERENCES learning.form_assignment(id),
 source_scope text NOT NULL CHECK(source_scope IN ('personal','izone')),
 source_library_id uuid REFERENCES learning.form_library_entry(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT ON learning.form_assignment_origin TO learning_api;
DROP TRIGGER IF EXISTS protect_form_assignment_origin ON learning.form_assignment_origin;
CREATE TRIGGER protect_form_assignment_origin BEFORE UPDATE OR DELETE ON learning.form_assignment_origin
 FOR EACH ROW EXECUTE FUNCTION learning.protect_form_publication();
DROP TRIGGER IF EXISTS protect_form_worksheet_revision ON learning.form_worksheet_revision;
CREATE TRIGGER protect_form_worksheet_revision BEFORE UPDATE OR DELETE ON learning.form_worksheet_revision
 FOR EACH ROW EXECUTE FUNCTION learning.protect_form_publication();
-- Chỉ bổ sung nguồn cũ có quan hệ đã ghi; giữ nguyên nội dung, ID và hash của assignment.
INSERT INTO learning.form_assignment_origin(assignment_id,source_scope,source_library_id)
 SELECT delivery.assignment_id,CASE WHEN p.source_draft_id IS NOT NULL THEN 'personal' ELSE entry.sharing_scope END,entry.id
 FROM learning.form_delivery delivery JOIN learning.form_publication p ON p.id=delivery.publication_id
 LEFT JOIN learning.form_library_entry entry ON entry.id=p.source_library_id
 WHERE p.source_draft_id IS NOT NULL OR entry.id IS NOT NULL
 ON CONFLICT(assignment_id) DO NOTHING;
INSERT INTO learning.form_assignment_origin(assignment_id,source_scope)
 SELECT published_assignment_id,'personal' FROM learning.form_draft
 WHERE published_assignment_id IS NOT NULL
 ON CONFLICT(assignment_id) DO NOTHING;
