-- Dữ liệu nhận vào: lớp demo giả của seed 202608290002 và schema learning V2.
-- Việc chính: bổ sung trạng thái từng phần, checkpoint và insight cấp lớp để demo đọc cùng database thật.
-- Kết quả: dashboard phản ánh đúng những gì màn học viên đã ghi; không chứa dữ liệu học viên thật.
-- Khi lỗi: dừng toàn bộ seed V2; không tạo trạng thái demo nửa vời.

INSERT INTO learning.assignment_block_release (
  assignment_id, block_id, checkpoint, status, release_version, updated_by_email, released_at
)
VALUES
  ('20000000-0000-4000-8000-000000000301','20000000-0000-4000-8000-000000000101',1,'open',1,'progress-log-demo@izone.invalid',now()),
  ('20000000-0000-4000-8000-000000000301','20000000-0000-4000-8000-000000000102',2,'open',1,'progress-log-demo@izone.invalid',now())
ON CONFLICT (assignment_id, block_id) DO UPDATE SET
  status = EXCLUDED.status,
  updated_by_email = EXCLUDED.updated_by_email,
  released_at = EXCLUDED.released_at,
  updated_at = now();

INSERT INTO learning.checkpoint_submission (
  id, attempt_id, assignment_id, form_version_id, student_ref, block_id, checkpoint,
  response_payload, response_hash, completeness, missing_item_version_ids,
  operation_key, idempotency_key, submitted_at
)
VALUES
  ('22000000-0000-4000-8000-000000000401','20000000-0000-4000-8000-000000000401','20000000-0000-4000-8000-000000000301','20000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000101',1,
   '{"20000000-0000-4000-8000-000000000201":"8/10"}'::jsonb,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','complete','[]'::jsonb,'demo:checkpoint:401:1','demo:checkpoint:401:1:v1',now() - interval '2 days'),
  ('22000000-0000-4000-8000-000000000402','20000000-0000-4000-8000-000000000401','20000000-0000-4000-8000-000000000301','20000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000102',2,
   '{"20000000-0000-4000-8000-000000000202":"Em còn nhầm giữa FALSE và NOT GIVEN.","20000000-0000-4000-8000-000000000203":"Em sẽ làm lại 10 câu."}'::jsonb,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','complete','[]'::jsonb,'demo:checkpoint:401:2','demo:checkpoint:401:2:v1',now() - interval '2 days'),
  ('22000000-0000-4000-8000-000000000403','20000000-0000-4000-8000-000000000402','20000000-0000-4000-8000-000000000301','20000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000101',1,
   '{"20000000-0000-4000-8000-000000000201":"5/10"}'::jsonb,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','complete','[]'::jsonb,'demo:checkpoint:402:1','demo:checkpoint:402:1:v1',now() - interval '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning.class_session_insight (
  id, assignment_id, insight_version, category, skill_code, title, summary,
  affected_student_refs, evidence_manifest, status, entity_key, unit_key,
  operation_key, idempotency_key
)
VALUES
  ('22000000-0000-4000-8000-000000000501','20000000-0000-4000-8000-000000000301',1,'recurring_issue','reading',
   'FALSE và NOT GIVEN còn bị nhầm',
   'Hai học viên cần đối chiếu lại câu hỏi với bằng chứng trong bài đọc trước khi chọn đáp án.',
   '["21000000-0000-4000-8000-000000000003","21000000-0000-4000-8000-000000000004"]'::jsonb,
   '{"evidenceIds":["20000000-0000-4000-8000-000000000601","20000000-0000-4000-8000-000000000602"]}'::jsonb,
   'ready_for_review','class:990000567','assignment:20000000-0000-4000-8000-000000000301',
   'demo:class-insight:false-not-given:v1','demo:class-insight:false-not-given:write:v1'),
  ('22000000-0000-4000-8000-000000000502','20000000-0000-4000-8000-000000000301',1,'strength','reading',
   'Học viên đã tự nêu việc tiếp theo',
   'Các phiếu đủ nội dung đều có hành động tiếp theo cụ thể, thuận tiện để giảng viên theo dõi ở buổi sau.',
   '["21000000-0000-4000-8000-000000000003","21000000-0000-4000-8000-000000000005"]'::jsonb,
   '{"evidenceIds":["20000000-0000-4000-8000-000000000601"]}'::jsonb,
   'ready_for_review','class:990000567','assignment:20000000-0000-4000-8000-000000000301',
   'demo:class-insight:next-action:v1','demo:class-insight:next-action:write:v1')
ON CONFLICT (id) DO NOTHING;
