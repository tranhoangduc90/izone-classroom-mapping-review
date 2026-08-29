-- Lớp demo Progress Log: chỉ chứa danh tính và nội dung giả, không liên kết dữ liệu học viên thật.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mapping.classroom_course_mapping
    WHERE erp_course_class_id = 990000567
      AND erp_class_name_snapshot <> '[DEMO] PROGRESS LOG · KHÓA 56'
  ) THEN
    RAISE EXCEPTION 'Class ID 990000567 đã được dùng cho lớp khác; dừng seed demo.';
  END IF;
END $$;

INSERT INTO mapping.classroom_course_mapping (
  erp_course_class_id, erp_class_name_snapshot, status, approved_by, approved_at
) VALUES (990000567, '[DEMO] PROGRESS LOG · KHÓA 56', 'approved', 'progress-log-demo', now())
ON CONFLICT (erp_course_class_id) DO NOTHING;

INSERT INTO mapping.student_mapping_review (
  public_id, erp_course_class_id, erp_student_contact_id, erp_student_code,
  erp_student_name_snapshot, match_method, status, reviewer_email, reviewer_note, decided_at
) VALUES
  ('21000000-0000-4000-8000-000000000001', 990000567, 990000001, 'DEMO-01', 'BẠN TRẢI NGHIỆM 1', 'manual', 'approved', 'progress-log-demo@izone.invalid', 'Dữ liệu giả dành cho demo.', now()),
  ('21000000-0000-4000-8000-000000000002', 990000567, 990000002, 'DEMO-02', 'BẠN TRẢI NGHIỆM 2', 'manual', 'approved', 'progress-log-demo@izone.invalid', 'Dữ liệu giả dành cho demo.', now()),
  ('21000000-0000-4000-8000-000000000003', 990000567, 990000003, 'DEMO-03', 'MINH ANH DEMO', 'manual', 'approved', 'progress-log-demo@izone.invalid', 'Dữ liệu giả dành cho demo.', now()),
  ('21000000-0000-4000-8000-000000000004', 990000567, 990000004, 'DEMO-04', 'MINH ANH DEMO', 'manual', 'approved', 'progress-log-demo@izone.invalid', 'Dữ liệu giả dành cho demo.', now()),
  ('21000000-0000-4000-8000-000000000005', 990000567, 990000005, 'DEMO-05', 'HOÀNG NAM DEMO', 'manual', 'approved', 'progress-log-demo@izone.invalid', 'Dữ liệu giả dành cho demo.', now()),
  ('21000000-0000-4000-8000-000000000006', 990000567, 990000006, 'DEMO-06', 'NGỌC LINH DEMO', 'manual', 'approved', 'progress-log-demo@izone.invalid', 'Dữ liệu giả dành cho demo.', now())
ON CONFLICT (erp_course_class_id, erp_student_contact_id) DO NOTHING;

INSERT INTO mapping.reviewer_class_access (reviewer_email, erp_course_class_id)
SELECT email, 990000567
FROM mapping.reviewer_account
WHERE status = 'active'
ON CONFLICT DO NOTHING;

INSERT INTO learning.form_template (id, title, kind, created_by_email, status)
VALUES ('20000000-0000-4000-8000-000000000001', 'Phiếu điểm danh và ghi nhanh · Demo', 'reflection', 'progress-log-demo@izone.invalid', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.form_version (
  id, template_id, version, public_definition, definition_hash, status,
  created_by_email, approved_by_email, published_at
) VALUES (
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  1,
  $json${
    "schemaVersion":"FormDefinitionV1",
    "formVersionId":"20000000-0000-4000-8000-000000000002",
    "title":"Phiếu điểm danh và ghi nhanh · Demo",
    "kind":"reflection",
    "answerReleasePolicy":"hidden",
    "blocks":[
      {
        "blockId":"20000000-0000-4000-8000-000000000101",
        "checkpoint":1,
        "title":"Sau hoạt động luyện tập",
        "instructions":"Điền ngắn gọn khi giảng viên yêu cầu.",
        "items":[{
          "itemFamilyId":"10000000-0000-4000-8000-000000000004",
          "itemVersionId":"20000000-0000-4000-8000-000000000201",
          "position":1,
          "prompt":"Em làm đúng hoặc hoàn thành được bao nhiêu câu?",
          "helpText":"",
          "interactionType":"short_text",
          "pedagogicalTypeCode":"reflection",
          "layoutType":"plain_prompt",
          "graderType":"none",
          "groupId":null,
          "required":true,
          "maxScore":0,
          "options":[],
          "skillCodes":[],
          "releasePolicy":"inherit"
        }]
      },
      {
        "blockId":"20000000-0000-4000-8000-000000000102",
        "checkpoint":2,
        "title":"Trước khi kết thúc buổi học",
        "instructions":"Điền ngắn gọn khi giảng viên yêu cầu.",
        "items":[
          {
            "itemFamilyId":"10000000-0000-4000-8000-000000000002",
            "itemVersionId":"20000000-0000-4000-8000-000000000202",
            "position":2,
            "prompt":"Điều gì vẫn khiến em chưa chắc hoặc còn vướng?",
            "helpText":"",
            "interactionType":"long_text",
            "pedagogicalTypeCode":"reflection",
            "layoutType":"plain_prompt",
            "graderType":"none",
            "groupId":null,
            "required":true,
            "maxScore":0,
            "options":[],
            "skillCodes":[],
            "releasePolicy":"inherit"
          },
          {
            "itemFamilyId":"10000000-0000-4000-8000-000000000003",
            "itemVersionId":"20000000-0000-4000-8000-000000000203",
            "position":3,
            "prompt":"Việc cụ thể tiếp theo em sẽ làm là gì?",
            "helpText":"",
            "interactionType":"short_text",
            "pedagogicalTypeCode":"reflection",
            "layoutType":"plain_prompt",
            "graderType":"none",
            "groupId":null,
            "required":true,
            "maxScore":0,
            "options":[],
            "skillCodes":[],
            "releasePolicy":"inherit"
          }
        ]
      }
    ]
  }$json$::jsonb,
  '4da86b482773032e8036f1a2de8bf9f008ba3d3c12bce4d09f22e20d815a85cc',
  'published', 'progress-log-demo@izone.invalid', 'progress-log-demo@izone.invalid', now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.form_grading_key (
  form_version_id, grader_version, private_definition, content_hash
) VALUES (
  '20000000-0000-4000-8000-000000000002', 1,
  '{"schemaVersion":"FormGradingKeyV1","formVersionId":"20000000-0000-4000-8000-000000000002","graderVersion":1,"items":{},"groups":{}}'::jsonb,
  '74f84821ef5a2bc031a6abd3869964ddbe9cf47ff9589081a3af1acb475a4ab1'
)
ON CONFLICT (form_version_id) DO NOTHING;

INSERT INTO learning.form_assignment (
  id, public_token, form_version_id, course_code, erp_course_class_id,
  class_name_snapshot, session_number, title, status, created_by_email
) VALUES (
  '20000000-0000-4000-8000-000000000301',
  '20000000-0000-4000-8000-000000000302',
  '20000000-0000-4000-8000-000000000002',
  'DEMO-56', 990000567, '[DEMO] PROGRESS LOG · KHÓA 56', 6,
  'Phiếu điểm danh và ghi nhanh · Demo', 'published', 'progress-log-demo@izone.invalid'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.form_assignment_roster (
  assignment_id, student_ref, erp_student_contact_id, student_name_snapshot, display_discriminator
)
SELECT
  '20000000-0000-4000-8000-000000000301', public_id, erp_student_contact_id,
  erp_student_name_snapshot,
  CASE erp_student_contact_id WHEN 990000003 THEN 'mã 03' WHEN 990000004 THEN 'mã 04' ELSE '' END
FROM mapping.student_mapping_review
WHERE erp_course_class_id = 990000567
ON CONFLICT DO NOTHING;

INSERT INTO learning.attempt (
  id, attempt_token, assignment_id, form_version_id, definition_hash, student_ref,
  client_idempotency_key, status, draft, draft_hash, draft_revision, submitted_at
) VALUES
  (
    '20000000-0000-4000-8000-000000000401', '20000000-0000-4000-8000-000000000411',
    '20000000-0000-4000-8000-000000000301', '20000000-0000-4000-8000-000000000002',
    '4da86b482773032e8036f1a2de8bf9f008ba3d3c12bce4d09f22e20d815a85cc',
    '21000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000421', 'submitted',
    '{"20000000-0000-4000-8000-000000000201":"8/10","20000000-0000-4000-8000-000000000202":"Em còn nhầm giữa FALSE và NOT GIVEN.","20000000-0000-4000-8000-000000000203":"Em sẽ làm lại 10 câu và ghi lý do cho từng đáp án."}'::jsonb,
    '103cbcf49b762a2d491bfcfc1170cdcf70cc4208e68bdeebf81c94cb72507286', 2, now() - interval '2 days'
  ),
  (
    '20000000-0000-4000-8000-000000000402', '20000000-0000-4000-8000-000000000412',
    '20000000-0000-4000-8000-000000000301', '20000000-0000-4000-8000-000000000002',
    '4da86b482773032e8036f1a2de8bf9f008ba3d3c12bce4d09f22e20d815a85cc',
    '21000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000422', 'submitted',
    '{"20000000-0000-4000-8000-000000000201":"5/10"}'::jsonb,
    '91fcba7990280f5cdf08251f218c4f7dcc208a05f71078ba9a5371b0d3bea93f', 1, now() - interval '2 days'
  ),
  (
    '20000000-0000-4000-8000-000000000403', '20000000-0000-4000-8000-000000000413',
    '20000000-0000-4000-8000-000000000301', '20000000-0000-4000-8000-000000000002',
    '4da86b482773032e8036f1a2de8bf9f008ba3d3c12bce4d09f22e20d815a85cc',
    '21000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000423', 'submitted',
    '{"20000000-0000-4000-8000-000000000201":"7/10","20000000-0000-4000-8000-000000000202":"Em cần nghe kỹ phần số nhiều.","20000000-0000-4000-8000-000000000203":"Em sẽ nghe lại đoạn 2 và chép chính tả."}'::jsonb,
    'b0f825a94d4bb093ed3cac77558f5d2db45ffb4aa3da116d06a9bce7ed83a3e8', 2, now() - interval '2 days'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.submission (
  id, attempt_id, assignment_id, form_version_id, student_ref, response_payload,
  response_hash, completeness, grading_status, receipt, submitted_at
) VALUES
  ('20000000-0000-4000-8000-000000000501', '20000000-0000-4000-8000-000000000401', '20000000-0000-4000-8000-000000000301', '20000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000003',
   '{"20000000-0000-4000-8000-000000000201":"8/10","20000000-0000-4000-8000-000000000202":"Em còn nhầm giữa FALSE và NOT GIVEN.","20000000-0000-4000-8000-000000000203":"Em sẽ làm lại 10 câu và ghi lý do cho từng đáp án."}'::jsonb,
   '103cbcf49b762a2d491bfcfc1170cdcf70cc4208e68bdeebf81c94cb72507286', 'complete', 'complete',
   '{"schemaVersion":"SubmissionReceiptV1","completeness":"complete","attendanceStatus":"self_confirmed","gradingStatus":"complete","message":"Đã nhận đủ phiếu.","nextAction":"Làm lại 10 câu và ghi lý do."}'::jsonb, now() - interval '2 days'),
  ('20000000-0000-4000-8000-000000000502', '20000000-0000-4000-8000-000000000402', '20000000-0000-4000-8000-000000000301', '20000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000004',
   '{"20000000-0000-4000-8000-000000000201":"5/10"}'::jsonb,
   '91fcba7990280f5cdf08251f218c4f7dcc208a05f71078ba9a5371b0d3bea93f', 'incomplete', 'complete',
   '{"schemaVersion":"SubmissionReceiptV1","completeness":"incomplete","attendanceStatus":"pending_teacher","gradingStatus":"complete","message":"Phiếu còn thiếu mục bắt buộc.","nextAction":"Nhờ giảng viên xác nhận."}'::jsonb, now() - interval '2 days'),
  ('20000000-0000-4000-8000-000000000503', '20000000-0000-4000-8000-000000000403', '20000000-0000-4000-8000-000000000301', '20000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000005',
   '{"20000000-0000-4000-8000-000000000201":"7/10","20000000-0000-4000-8000-000000000202":"Em cần nghe kỹ phần số nhiều.","20000000-0000-4000-8000-000000000203":"Em sẽ nghe lại đoạn 2 và chép chính tả."}'::jsonb,
   'b0f825a94d4bb093ed3cac77558f5d2db45ffb4aa3da116d06a9bce7ed83a3e8', 'complete', 'complete',
   '{"schemaVersion":"SubmissionReceiptV1","completeness":"complete","attendanceStatus":"self_confirmed","gradingStatus":"complete","message":"Đã nhận đủ phiếu.","nextAction":"Nghe lại đoạn 2."}'::jsonb, now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.response_item (
  submission_id, item_version_id, item_family_id, position, interaction_type,
  pedagogical_type_code, response_value, answer_state
) VALUES
  ('20000000-0000-4000-8000-000000000501','20000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000004',1,'short_text','reflection','"8/10"'::jsonb,'answered'),
  ('20000000-0000-4000-8000-000000000501','20000000-0000-4000-8000-000000000202','10000000-0000-4000-8000-000000000002',2,'long_text','reflection','"Em còn nhầm giữa FALSE và NOT GIVEN."'::jsonb,'answered'),
  ('20000000-0000-4000-8000-000000000501','20000000-0000-4000-8000-000000000203','10000000-0000-4000-8000-000000000003',3,'short_text','reflection','"Em sẽ làm lại 10 câu và ghi lý do cho từng đáp án."'::jsonb,'answered'),
  ('20000000-0000-4000-8000-000000000502','20000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000004',1,'short_text','reflection','"5/10"'::jsonb,'answered'),
  ('20000000-0000-4000-8000-000000000503','20000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000004',1,'short_text','reflection','"7/10"'::jsonb,'answered'),
  ('20000000-0000-4000-8000-000000000503','20000000-0000-4000-8000-000000000202','10000000-0000-4000-8000-000000000002',2,'long_text','reflection','"Em cần nghe kỹ phần số nhiều."'::jsonb,'answered'),
  ('20000000-0000-4000-8000-000000000503','20000000-0000-4000-8000-000000000203','10000000-0000-4000-8000-000000000003',3,'short_text','reflection','"Em sẽ nghe lại đoạn 2 và chép chính tả."'::jsonb,'answered')
ON CONFLICT DO NOTHING;

INSERT INTO learning.attendance_record (
  assignment_id, student_ref, status, source_submission_id, current_reason, decided_by_email
) VALUES
  ('20000000-0000-4000-8000-000000000301','21000000-0000-4000-8000-000000000003','self_confirmed','20000000-0000-4000-8000-000000000501','Nộp đủ trường bắt buộc.',NULL),
  ('20000000-0000-4000-8000-000000000301','21000000-0000-4000-8000-000000000004','pending_teacher','20000000-0000-4000-8000-000000000502','Phiếu còn thiếu mục bắt buộc.',NULL),
  ('20000000-0000-4000-8000-000000000301','21000000-0000-4000-8000-000000000005','teacher_confirmed','20000000-0000-4000-8000-000000000503','Giảng viên xác nhận sau giờ học.','progress-log-demo@izone.invalid')
ON CONFLICT (assignment_id, student_ref) DO NOTHING;

INSERT INTO learning.evidence_event (
  id, source_system, source_record_id, source_revision, entity_key, unit_key,
  operation_key, idempotency_key, organization_key, course_code,
  erp_course_class_id, session_number, student_ref, form_version_id,
  assignment_id, submission_id, visibility, payload, content_hash,
  renderer_version, markdown, occurred_at
) VALUES
  ('20000000-0000-4000-8000-000000000601','progress_form','demo-submission-1',1,'student:demo-03','class:990000567:session:6','demo:evidence:form:1','demo:evidence:form:1:v1','izone','DEMO-56',990000567,6,'21000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000301','20000000-0000-4000-8000-000000000501','analysis_allowed','{"accuracy":"8/10","difficulty":"Nhầm FALSE và NOT GIVEN","nextAction":"Làm lại 10 câu"}'::jsonb,'0e5c076b1f95ecb6f4e486d5bfa884e47ed4745c6e51de5b4aa909accea7ce53','evidence-md-v1','# Progress Log demo\n\n- Kết quả: 8/10\n- Còn vướng: FALSE/NOT GIVEN',now() - interval '2 days'),
  ('20000000-0000-4000-8000-000000000602','term_test','demo-term-test-1',1,'student:demo-03','class:990000567:term:1','demo:evidence:term:1','demo:evidence:term:1:v1','izone','DEMO-56',990000567,5,'21000000-0000-4000-8000-000000000003',NULL,NULL,NULL,'analysis_allowed','{"readingScore":7.0,"typeStats":{"true_false_not_given":{"correct":6,"total":10}}}'::jsonb,'3ec1fbb78bfe51119b4022671e62e0014aaac1d92ed420afa173e90ae1e9aa03','evidence-md-v1','# Term Test demo\n\nReading: 7.0; T/F/NG: 6/10.',now() - interval '8 days'),
  ('20000000-0000-4000-8000-000000000603','homework','demo-homework-1',1,'student:demo-03','class:990000567:homework:5','demo:evidence:homework:1','demo:evidence:homework:1:v1','izone','DEMO-56',990000567,5,'21000000-0000-4000-8000-000000000003',NULL,NULL,NULL,'analysis_allowed','{"completed":true,"accuracy":0.8,"recurringIssue":"false_not_given"}'::jsonb,'88bbe5db72669d6763f1faaaebde2ab00f89be83939c97a7041aadfeeb7cc016','evidence-md-v1','# Homework demo\n\nHoàn thành; độ chính xác 80%.',now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.analysis_run (
  id, student_ref, analysis_kind, operation_key, idempotency_key, prompt_version,
  model_name, input_manifest, status, output_json, output_markdown, completed_at
) VALUES (
  '20000000-0000-4000-8000-000000000701','21000000-0000-4000-8000-000000000003','periodic_report',
  'demo:analysis:student-03:s1-6','demo:analysis:student-03:s1-6:v1','periodic-report-v1','demo-fixture',
  '{"evidenceIds":["20000000-0000-4000-8000-000000000601","20000000-0000-4000-8000-000000000602","20000000-0000-4000-8000-000000000603"]}'::jsonb,
  'complete','{}'::jsonb,'',now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.periodic_report (
  id, student_ref, erp_course_class_id, from_session_number, to_session_number,
  analysis_run_id, status, system_output, system_markdown, approved_by_email, approved_at
) VALUES (
  '20000000-0000-4000-8000-000000000702','21000000-0000-4000-8000-000000000003',990000567,1,6,
  '20000000-0000-4000-8000-000000000701','approved',
  $json${
    "schemaVersion":"PeriodicReportSystemOutputV1",
    "studentRef":"21000000-0000-4000-8000-000000000003",
    "classId":"990000567",
    "fromSessionNumber":1,
    "toSessionNumber":6,
    "evidenceCount":3,
    "progress":[{"text":"Độ chính xác bài tập đã tăng lên 80%; em cũng đã tự chỉ ra đúng điểm còn vướng.","evidenceIds":["20000000-0000-4000-8000-000000000601","20000000-0000-4000-8000-000000000603"]}],
    "recurringIssues":[{"text":"Phân biệt FALSE và NOT GIVEN vẫn là lỗi lặp lại ở bài kiểm tra và phiếu trên lớp.","evidenceIds":["20000000-0000-4000-8000-000000000601","20000000-0000-4000-8000-000000000602"]}],
    "attendance":{"expectedSessions":6,"submittedComplete":5,"submittedIncomplete":1,"missed":0},
    "nextAction":{"text":"Làm lại 10 câu TRUE/FALSE/NOT GIVEN và ghi một dòng bằng chứng cho từng đáp án.","evidenceIds":["20000000-0000-4000-8000-000000000601","20000000-0000-4000-8000-000000000602"]},
    "insufficientData":false,
    "insufficientDataReason":null
  }$json$::jsonb,
  '# Phân tích của hệ thống\n\nEm đã tăng độ chính xác lên 80%. Cần tiếp tục phân biệt FALSE và NOT GIVEN.\n\nViệc tiếp theo: làm lại 10 câu và ghi bằng chứng.',
  'progress-log-demo@izone.invalid', now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.teacher_human_note (report_id, teacher_email, note_text)
VALUES (
  '20000000-0000-4000-8000-000000000702',
  'progress-log-demo@izone.invalid',
  'Cô thấy em đang sửa đúng chỗ rồi. Cứ giữ cách ghi lý do cho từng đáp án nhé!'
)
ON CONFLICT (report_id) DO NOTHING;
