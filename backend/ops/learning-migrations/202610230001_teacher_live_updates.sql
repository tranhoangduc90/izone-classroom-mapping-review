BEGIN;
-- Nhận thay đổi đã ghi trong cùng transaction; chỉ giữ mã và phiên bản, không sao chép bài/đáp án.
CREATE TABLE learning.assignment_live_revision (
  assignment_id uuid PRIMARY KEY REFERENCES learning.form_assignment(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  transaction_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE learning.assignment_live_change (
  assignment_id uuid NOT NULL REFERENCES learning.form_assignment(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('dashboard','drafts','analytics')),
  student_ref uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  revision bigint NOT NULL,
  PRIMARY KEY (assignment_id,scope,student_ref)
);
CREATE INDEX assignment_live_change_since ON learning.assignment_live_change(assignment_id,revision);
-- Phiếu đã tồn tại cũng có mốc 0 ngay khi nâng cấp; không đợi lần nộp đầu mới tạo hàng FK.
INSERT INTO learning.assignment_live_revision(assignment_id,revision) SELECT id,0 FROM learning.form_assignment;
GRANT SELECT ON learning.assignment_live_revision,learning.assignment_live_change TO learning_api;

CREATE FUNCTION learning.record_live_change(target uuid, student uuid, scopes text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,learning AS $$
DECLARE next_revision bigint; scope_name text; current_transaction bigint := txid_current(); first_change boolean := false;
BEGIN
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM learning.form_assignment WHERE id=target) THEN RETURN; END IF;
  -- Một lần nộp có nhiều writer; chỉ tăng mốc một lần/phiếu/transaction.
  -- Transaction khác vẫn phải chờ hàng revision rồi tăng mốc mới, không mất thay đổi.
  SELECT revision INTO next_revision FROM learning.assignment_live_revision
    WHERE assignment_id=target AND transaction_id=current_transaction;
  IF NOT FOUND THEN
    INSERT INTO learning.assignment_live_revision(assignment_id,revision,transaction_id) VALUES(target,1,current_transaction)
      ON CONFLICT(assignment_id) DO UPDATE SET revision=assignment_live_revision.revision+1,
        transaction_id=EXCLUDED.transaction_id,updated_at=clock_timestamp()
      RETURNING revision INTO next_revision;
    first_change=true;
  END IF;
  FOREACH scope_name IN ARRAY scopes LOOP
    INSERT INTO learning.assignment_live_change(assignment_id,scope,student_ref,revision)
      VALUES(target,scope_name,COALESCE(student,'00000000-0000-0000-0000-000000000000'::uuid),next_revision)
      ON CONFLICT(assignment_id,scope,student_ref) DO UPDATE SET revision=EXCLUDED.revision
      WHERE assignment_live_change.revision IS DISTINCT FROM EXCLUDED.revision;
  END LOOP;
  -- PostgreSQL chỉ giao NOTIFY sau commit; rollback không tạo cập nhật giả.
  IF first_change THEN
    PERFORM pg_notify('learning_teacher_live',json_build_object('assignmentId',target)::text);
  END IF;
END $$;
REVOKE ALL ON FUNCTION learning.record_live_change(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION learning.capture_live_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,learning AS $$
DECLARE current_row jsonb; previous_row jsonb; target uuid; student uuid; scopes text[]; linked record;
BEGIN
  IF TG_OP='DELETE' THEN current_row=to_jsonb(OLD); ELSE current_row=to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' THEN
    previous_row=to_jsonb(OLD);
    IF current_row IS NOT DISTINCT FROM previous_row THEN RETURN NULL; END IF;
  END IF;
  scopes=string_to_array(TG_ARGV[0],',');
  student=NULLIF(current_row->>'student_ref','')::uuid;
  target=NULLIF(current_row->>'assignment_id','')::uuid;
  IF TG_TABLE_NAME='form_assignment' THEN target=(current_row->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='attempt' AND TG_OP='UPDATE' AND current_row->>'status'=previous_row->>'status'
     AND current_row->>'draft_revision' IS DISTINCT FROM previous_row->>'draft_revision' THEN scopes=ARRAY['drafts']; END IF;
  IF TG_TABLE_NAME='outbox_job' THEN
    IF current_row->>'job_type'<>'sync_portal_attendance' THEN RETURN NULL; END IF;
    target=NULLIF(current_row->'payload'->>'assignmentId','')::uuid;
    student=NULLIF(current_row->'payload'->>'studentRef','')::uuid;
  END IF;
  IF target IS NULL AND current_row ? 'grading_run_id' THEN
    SELECT submission.assignment_id,submission.student_ref INTO target,student
    FROM learning.grading_run AS run JOIN learning.submission ON submission.id=run.submission_id
    WHERE run.id=(current_row->>'grading_run_id')::uuid;
  ELSIF target IS NULL AND current_row ? 'submission_id' THEN
    SELECT assignment_id,student_ref INTO target,student FROM learning.submission WHERE id=(current_row->>'submission_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='student_session_comment' THEN
    FOR linked IN SELECT id FROM learning.form_assignment
      WHERE erp_course_class_id=(current_row->>'erp_course_class_id')::bigint
        AND session_number=(current_row->>'session_number')::int ORDER BY id LOOP
      PERFORM learning.record_live_change(linked.id,student,scopes);
    END LOOP;
  ELSE
    PERFORM learning.record_live_change(target,student,scopes);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION learning.capture_live_change() FROM PUBLIC;

-- Inventory writer: bản cũ, chấm bất đồng bộ, Portal và nhận xét đều đi qua trigger của bảng nguồn.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('form_assignment','dashboard,drafts,analytics'),
    ('form_assignment_roster','dashboard,drafts,analytics'),
    ('attempt','dashboard,drafts'),
    ('checkpoint_submission','dashboard,drafts'),
    ('submission','dashboard,drafts,analytics'),
    ('response_item','drafts,analytics'),
    ('grading_run','dashboard,drafts,analytics'),
    ('grading_result_item','dashboard,drafts,analytics'),
    ('assignment_block_release','dashboard'),
    ('attendance_record','dashboard'),
    ('outbox_job','dashboard'),
    ('teacher_session_feedback','dashboard,drafts'),
    ('student_session_comment','dashboard,drafts'),
    ('class_session_insight','dashboard')
  ) AS inventory(table_name,scopes) LOOP
    IF to_regclass('learning.'||item.table_name) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER teacher_live_change AFTER INSERT OR UPDATE OR DELETE ON learning.%I FOR EACH ROW EXECUTE FUNCTION learning.capture_live_change(%L)',item.table_name,item.scopes);
    END IF;
  END LOOP;
END $$;
COMMIT;
