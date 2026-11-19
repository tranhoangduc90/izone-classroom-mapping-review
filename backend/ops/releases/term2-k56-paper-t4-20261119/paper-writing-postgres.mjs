import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {paperWritingSql} from './assemble-writing.mjs';

const [servingSqlPath] = process.argv.slice(2);
assert.ok(servingSqlPath,'Pass the captured k56-term-writing-draft.js path.');
const migration = await readFile(new URL('./migration.sql', import.meta.url),'utf8');
const query = paperWritingSql(await readFile(servingSqlPath));
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const c = '10000000-0000-4000-8000-000000000003';
const aSession = '20000000-0000-4000-8000-000000000001';
const bSession = '20000000-0000-4000-8000-000000000002';
const cSession = '20000000-0000-4000-8000-000000000003';

// Output only synthetic SQL for the disposable codex-test-lab database.
process.stdout.write(`CREATE SCHEMA assessment;
CREATE TABLE assessment.term_test_exam_session (
  id uuid PRIMARY KEY, test_slug text NOT NULL DEFAULT 'term-test-2-k56',
  attempt_mode text NOT NULL DEFAULT 'cbt', term2_parallel_entry boolean NOT NULL DEFAULT true,
  erp_course_class_id bigint NOT NULL DEFAULT 81, erp_student_contact_id bigint NOT NULL DEFAULT 101,
  generation bigint NOT NULL DEFAULT 0, superseded_at timestamptz
);
CREATE TABLE assessment.term_test_attempt (
  id uuid PRIMARY KEY, exam_session_id uuid NOT NULL REFERENCES assessment.term_test_exam_session(id),
  test_slug text NOT NULL DEFAULT 'term-test-2-k56', attempt_mode text NOT NULL DEFAULT 'cbt',
  term2_parallel_entry boolean NOT NULL DEFAULT true, term2_official_submission boolean NOT NULL DEFAULT false,
  erp_course_class_id bigint NOT NULL DEFAULT 81, erp_student_contact_id bigint NOT NULL DEFAULT 101,
  generation bigint NOT NULL DEFAULT 0, definition_version int NOT NULL DEFAULT 1,
  mini_definition_snapshot jsonb, superseded_at timestamptz, completed_at timestamptz, updated_at timestamptz,
  writing_outline text NOT NULL DEFAULT '', writing_task_1 text NOT NULL DEFAULT '', writing_task_2 text NOT NULL DEFAULT '',
  writing_draft_revision bigint NOT NULL DEFAULT 0,
  writing_started_at timestamptz, writing_deadline_at timestamptz, writing_updated_at timestamptz, writing_submitted_at timestamptz,
  CONSTRAINT term_test_attempt_writing_order_check CHECK (
    (writing_started_at IS NULL AND writing_updated_at IS NULL AND writing_submitted_at IS NULL)
    OR (completed_at IS NOT NULL AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL
      AND (writing_submitted_at IS NULL OR writing_submitted_at >= writing_started_at))
  )
);
${migration}

INSERT INTO assessment.term_test_exam_session(id,term2_paper_profile_id) VALUES
  ('${aSession}',gen_random_uuid()),('${bSession}',gen_random_uuid());
INSERT INTO assessment.term_test_exam_session(id,erp_student_contact_id) VALUES ('${cSession}',102);
INSERT INTO assessment.term_test_attempt(id,exam_session_id,term2_official_submission,completed_at) VALUES
  ('${a}','${aSession}',true,now());
INSERT INTO assessment.term_test_attempt(id,exam_session_id) VALUES ('${b}','${bSession}');
INSERT INTO assessment.term_test_attempt(id,exam_session_id,erp_student_contact_id,term2_official_submission,completed_at) VALUES
  ('${c}','${cSession}',102,true,now());

PREPARE write_paper(uuid,text,text,text,int,bigint,text,uuid) AS
${query}
DO $test$
DECLARE saved record;
BEGIN
  EXECUTE 'EXECUTE write_paper(''${b}'','''','''',''start'',30,NULL,'''',''${c}'')' INTO saved;
  IF saved.attempt_token IS NOT NULL THEN
    RAISE EXCEPTION 'An unrelated official attempt passed scope checks';
  END IF;
  EXECUTE 'EXECUTE write_paper(''${b}'','''','''',''start'',30,NULL,'''',''${a}'')' INTO STRICT saved;
  IF saved.attempt_token <> '${b}' OR saved.writing_accepted IS DISTINCT FROM true
      OR NOT EXISTS (SELECT FROM assessment.term_test_attempt
        WHERE id='${b}' AND term2_paper_private_writing AND completed_at IS NULL AND writing_submitted_at IS NULL) THEN
    RAISE EXCEPTION 'Second profile did not start a private Writing timer';
  END IF;
  EXECUTE 'EXECUTE write_paper(''${b}'',''Saved draft'','''',''draft'',30,0,''Saved outline'',''${a}'')' INTO STRICT saved;
  EXECUTE 'EXECUTE write_paper(''${b}'',''Stale draft'','''',''submit'',30,0,''Stale outline'',''${a}'')' INTO STRICT saved;
  IF saved.writing_reason <> 'revision_conflict'
      OR EXISTS (SELECT FROM assessment.term_test_attempt WHERE id='${a}' AND writing_submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A stale profile changed the official writing submission';
  END IF;
  UPDATE assessment.term_test_attempt SET writing_deadline_at=clock_timestamp()-interval '1 second' WHERE id='${b}';
  EXECUTE 'EXECUTE write_paper(''${b}'',''Late edit'','''',''submit'',30,1,''Late outline'',''${a}'')' INTO STRICT saved;
  IF saved.attempt_token <> '${a}' OR saved.writing_accepted IS DISTINCT FROM false
      OR saved.writing_reason <> 'deadline_expired' OR saved.writing_submitted_at IS NULL
      OR saved.writing_task_1 <> 'Saved draft' OR saved.writing_outline <> 'Saved outline' THEN
    RAISE EXCEPTION 'The official late-submit result did not use the submitting profile snapshot';
  END IF;
  IF NOT EXISTS (SELECT FROM assessment.term_test_attempt src JOIN assessment.term_test_attempt dst
      ON dst.id='${a}' WHERE src.id='${b}' AND src.writing_submitted_at IS NULL
        AND src.writing_started_at=dst.writing_started_at AND src.writing_deadline_at=dst.writing_deadline_at) THEN
    RAISE EXCEPTION 'The canonical Writing timer did not follow the source profile';
  END IF;
  UPDATE assessment.term_test_attempt SET completed_at=NULL WHERE id='${c}';
  BEGIN
    UPDATE assessment.term_test_attempt SET writing_started_at=now(),writing_updated_at=now() WHERE id='${c}';
    RAISE EXCEPTION 'The pre-existing Writing order check was weakened for an unmarked attempt';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;
SELECT 'term2-k56-paper-writing-sql passed' AS result, version() AS postgres_version;
`);
