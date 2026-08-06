-- Chạy sau khi quản trị viên đã tạo role LOGIN tên mapping_review_api bằng mật khẩu riêng.
-- File này không tạo role và không chứa mật khẩu.

GRANT CONNECT ON DATABASE mapping_db TO mapping_review_api;
GRANT USAGE ON SCHEMA mapping TO mapping_review_api;

GRANT SELECT ON mapping.classroom_course_mapping TO mapping_review_api;
GRANT SELECT ON mapping.classroom_roster_snapshot TO mapping_review_api;
GRANT SELECT, UPDATE ON mapping.student_mapping_review TO mapping_review_api;
GRANT SELECT, INSERT, UPDATE ON mapping.student_identity_mapping TO mapping_review_api;
GRANT SELECT, INSERT ON mapping.mapping_decision_event TO mapping_review_api;
GRANT SELECT, UPDATE ON mapping.reviewer_account TO mapping_review_api;
GRANT SELECT ON mapping.reviewer_class_access TO mapping_review_api;

GRANT USAGE, SELECT ON SEQUENCE mapping.mapping_decision_event_id_seq TO mapping_review_api;
GRANT USAGE, SELECT ON SEQUENCE mapping.student_identity_mapping_id_seq TO mapping_review_api;

GRANT USAGE ON SCHEMA assessment TO mapping_review_api;
GRANT SELECT ON assessment.test_definition, assessment.term_test_roster TO mapping_review_api;
GRANT SELECT, INSERT, UPDATE ON assessment.term_test_attempt TO mapping_review_api;
