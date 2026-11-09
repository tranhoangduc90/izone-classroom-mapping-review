ALTER TABLE learning.form_draft ADD COLUMN draft_scope text NOT NULL DEFAULT 'class';
ALTER TABLE learning.form_draft ALTER COLUMN erp_course_class_id DROP NOT NULL;
ALTER TABLE learning.form_draft ALTER COLUMN session_number DROP NOT NULL;
ALTER TABLE learning.form_draft ADD CONSTRAINT form_draft_scope_target CHECK (
  (draft_scope='class' AND erp_course_class_id IS NOT NULL AND session_number IS NOT NULL)
  OR (draft_scope='izone' AND erp_course_class_id IS NULL AND session_number IS NULL
      AND source_assignment_id IS NULL AND status<>'published'
      AND COALESCE(public_definition->>'courseCode','') IN ('34','45','56','67'))
);
CREATE INDEX form_draft_shared_course_queue ON learning.form_draft
  ((public_definition->>'courseCode'),status,updated_at DESC) WHERE draft_scope='izone';
