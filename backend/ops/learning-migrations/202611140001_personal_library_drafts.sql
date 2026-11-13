BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE learning.form_draft DROP CONSTRAINT form_draft_scope_target;
ALTER TABLE learning.form_draft ADD CONSTRAINT form_draft_scope_target CHECK (
  (draft_scope='class' AND erp_course_class_id IS NOT NULL AND session_number IS NOT NULL)
  OR (draft_scope='izone' AND erp_course_class_id IS NULL AND session_number IS NULL
      AND source_assignment_id IS NULL AND status<>'published'
      AND COALESCE(public_definition->>'courseCode','') IN ('34','45','56','67'))
  OR (draft_scope='personal' AND erp_course_class_id IS NULL AND session_number IS NULL
      AND source_assignment_id IS NULL AND status<>'published')
);
ALTER TABLE learning.form_draft ADD COLUMN copied_library_entry_id uuid REFERENCES learning.form_library_entry(id);
ALTER TABLE learning.form_draft ADD COLUMN copied_library_revision integer;
ALTER TABLE learning.form_draft ADD COLUMN copied_library_hash text;
ALTER TABLE learning.form_draft ADD COLUMN copied_library_title text;
COMMIT;
