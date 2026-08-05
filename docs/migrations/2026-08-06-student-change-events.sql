BEGIN;

ALTER TABLE mapping.class_change_event
  DROP CONSTRAINT IF EXISTS class_change_event_change_type_check;

ALTER TABLE mapping.class_change_event
  ADD CONSTRAINT class_change_event_change_type_check
  CHECK (change_type IN (
    'lark_class_added_to_view',
    'lark_class_removed_from_view',
    'erp_class_source_missing',
    'erp_class_source_restored',
    'classroom_class_source_missing',
    'classroom_class_source_restored',
    'classroom_student_added',
    'classroom_student_removed',
    'classroom_student_returned',
    'classroom_student_profile_changed',
    'erp_student_added_to_source',
    'erp_registration_flagged',
    'erp_registration_status_changed',
    'erp_student_missing_from_source',
    'erp_student_returned_to_source'
  ));

COMMIT;
