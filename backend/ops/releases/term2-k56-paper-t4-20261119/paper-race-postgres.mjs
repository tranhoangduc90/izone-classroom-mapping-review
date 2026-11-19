import {readFile} from 'node:fs/promises';

const releases = new URL('../',import.meta.url);
const parallel = await readFile(new URL('term2-k56-parallel-entry-20261117/parallel-attempts.sql',releases),'utf8');
const first = await readFile(new URL('term2-k56-first-valid-20261118/migration.sql',releases),'utf8');
const paper = await readFile(new URL('./migration.sql',import.meta.url),'utf8');

process.stdout.write(`CREATE EXTENSION dblink;
CREATE SCHEMA assessment;
CREATE TABLE assessment.term_test_exam_session (
  id uuid PRIMARY KEY,test_slug text NOT NULL DEFAULT 'term-test-2-k56',
  attempt_mode text NOT NULL DEFAULT 'cbt',definition_version integer NOT NULL DEFAULT 1,
  erp_course_class_id bigint NOT NULL DEFAULT 81,erp_student_contact_id bigint NOT NULL,
  generation bigint NOT NULL DEFAULT 0,superseded_at timestamptz,listening_submitted_at timestamptz
);
CREATE TABLE assessment.term_test_attempt (
  id uuid PRIMARY KEY,exam_session_id uuid REFERENCES assessment.term_test_exam_session(id),
  test_slug text NOT NULL DEFAULT 'term-test-2-k56',attempt_mode text NOT NULL DEFAULT 'cbt',
  definition_version integer NOT NULL DEFAULT 1,erp_course_class_id bigint NOT NULL DEFAULT 81,erp_student_contact_id bigint NOT NULL,
  generation bigint NOT NULL DEFAULT 0,superseded_at timestamptz,completed_at timestamptz,
  listening_submitted_at timestamptz,listening_interrupted_at timestamptz,listening_answers jsonb,
  reading_submitted_at timestamptz,reading_answers jsonb,
  writing_started_at timestamptz,writing_updated_at timestamptz,writing_submitted_at timestamptz,writing_task_1 text,
  CONSTRAINT term_test_attempt_writing_order_check CHECK (
    (writing_started_at IS NULL AND writing_updated_at IS NULL AND writing_submitted_at IS NULL)
    OR (completed_at IS NOT NULL AND writing_started_at IS NOT NULL AND writing_updated_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student
  ON assessment.term_test_exam_session(test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
  WHERE listening_submitted_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student
  ON assessment.term_test_attempt(test_slug,definition_version,erp_course_class_id,erp_student_contact_id)
  WHERE completed_at IS NULL AND superseded_at IS NULL;
${parallel}
${first}
${paper}

-- Only this small adapter simulates the API's transaction sequence.
-- The actual data guards and indexes above come from the release files.
CREATE TABLE assessment.race_result (
  source_id uuid NOT NULL,official_id uuid NOT NULL,skill text NOT NULL,
  PRIMARY KEY (official_id,skill)
);
CREATE FUNCTION assessment.check_seal(from_id uuid,skill text,answer text) RETURNS text
LANGUAGE plpgsql AS $check$
DECLARE
  source assessment.term_test_attempt%ROWTYPE;
  target assessment.term_test_attempt%ROWTYPE;
BEGIN
  SELECT * INTO STRICT source FROM assessment.term_test_attempt WHERE id=from_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'k56:' || source.test_slug || ':' || source.erp_course_class_id || ':' || source.erp_student_contact_id,0));
  SELECT * INTO STRICT source FROM assessment.term_test_attempt WHERE id=from_id FOR UPDATE;
  SELECT * INTO target FROM assessment.term_test_attempt
    WHERE term2_official_submission AND superseded_at IS NULL
      AND erp_course_class_id=source.erp_course_class_id AND erp_student_contact_id=source.erp_student_contact_id
      AND generation=source.generation FOR UPDATE;
  IF NOT FOUND THEN target := source; END IF;
  IF skill='reading' THEN
    IF target.reading_submitted_at IS NOT NULL THEN RETURN 'already_accepted'; END IF;
    UPDATE assessment.term_test_attempt SET reading_answers=jsonb_build_object('1',answer),
      reading_submitted_at=clock_timestamp() WHERE id=target.id;
  ELSIF skill='listening' THEN
    IF target.listening_submitted_at IS NOT NULL THEN RETURN 'already_accepted'; END IF;
    UPDATE assessment.term_test_attempt SET listening_answers=jsonb_build_object('1',answer),
      listening_submitted_at=clock_timestamp() WHERE id=target.id;
  ELSE RAISE EXCEPTION 'Unexpected skill';
  END IF;
  INSERT INTO assessment.race_result VALUES(from_id,target.id,skill);
  RETURN 'accepted';
END
$check$;

SELECT dblink_connect('paper_a','dbname=lab user=lab host=127.0.0.1 application_name=paper_race_a');
SELECT dblink_connect('paper_b','dbname=lab user=lab host=127.0.0.1 application_name=paper_race_b');

CREATE FUNCTION assessment.await_race_wait() RETURNS void LANGUAGE plpgsql AS $wait$
BEGIN
  FOR i IN 1..220 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS (SELECT FROM pg_stat_activity WHERE application_name='paper_race_b'
        AND datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory') THEN
      RETURN;
    END IF;
    PERFORM pg_sleep(0.02);
  END LOOP;
  RAISE EXCEPTION 'The second PostgreSQL connection did not wait for the identity lock';
END
$wait$;

INSERT INTO assessment.term_test_exam_session(id,erp_student_contact_id,term2_parallel_entry,term2_paper_profile_id)
SELECT ('20000000-0000-4000-8000-00000000000' || i)::uuid, CASE WHEN i<=2 THEN 102 ELSE 103 END,
       true,gen_random_uuid() FROM generate_series(1,4) i;
INSERT INTO assessment.term_test_attempt(id,exam_session_id,erp_student_contact_id)
SELECT ('10000000-0000-4000-8000-00000000000' || i)::uuid,
       ('20000000-0000-4000-8000-00000000000' || i)::uuid,CASE WHEN i<=2 THEN 102 ELSE 103 END
FROM generate_series(1,4) i;

DO $race$
DECLARE
  a uuid := '10000000-0000-4000-8000-000000000001';
  b uuid := '10000000-0000-4000-8000-000000000002';
  c uuid := '10000000-0000-4000-8000-000000000003';
  d uuid := '10000000-0000-4000-8000-000000000004';
  opened text;
  seen text;
BEGIN
  PERFORM dblink_exec('paper_a','BEGIN');
  SELECT status INTO STRICT opened FROM dblink('paper_a',format(
    'SELECT assessment.check_seal(%L,%L,%L)',a,'reading','first')) AS result(status text);
  IF opened <> 'accepted' THEN RAISE EXCEPTION 'First request failed'; END IF;
  IF EXISTS (SELECT FROM assessment.race_result) THEN RAISE EXCEPTION 'Uncommitted receipt visible'; END IF;
  PERFORM dblink_send_query('paper_b',format('SELECT assessment.check_seal(%L,%L,%L)',b,'reading','second'));
  PERFORM assessment.await_race_wait();
  PERFORM dblink_exec('paper_a','COMMIT');
  SELECT status INTO STRICT seen FROM dblink_get_result('paper_b') AS result(status text);
  PERFORM 1 FROM dblink_get_result('paper_b') AS result(status text);
  IF seen <> 'already_accepted' OR EXISTS (SELECT FROM assessment.race_result WHERE source_id=b)
    OR (SELECT reading_answers->>'1' FROM assessment.term_test_attempt WHERE id=a)<>'first' THEN
    RAISE EXCEPTION 'Same-skill race did not protect the first payload';
  END IF;
  BEGIN
    UPDATE assessment.term_test_attempt SET reading_answers='{"1":"overwrite"}' WHERE id=a;
    RAISE EXCEPTION 'Direct overwrite did not hit the deployed immutable-result guard';
  EXCEPTION WHEN SQLSTATE 'P5652' THEN NULL;
  END;
  BEGIN
    UPDATE assessment.term_test_attempt SET reading_submitted_at=now(),reading_answers='{"1":"second"}' WHERE id=b;
    RAISE EXCEPTION 'Direct duplicate did not hit the deployed first-result guard';
  EXCEPTION WHEN SQLSTATE 'P5651' THEN NULL;
  END;

  PERFORM dblink_exec('paper_a','BEGIN');
  SELECT status INTO STRICT opened FROM dblink('paper_a',format(
    'SELECT assessment.check_seal(%L,%L,%L)',c,'listening','heard')) AS result(status text);
  IF opened <> 'accepted' THEN RAISE EXCEPTION 'First Listening request failed'; END IF;
  PERFORM dblink_send_query('paper_b',format('SELECT assessment.check_seal(%L,%L,%L)',d,'reading','read'));
  PERFORM assessment.await_race_wait();
  PERFORM dblink_exec('paper_a','COMMIT');
  SELECT status INTO STRICT seen FROM dblink_get_result('paper_b') AS result(status text);
  PERFORM 1 FROM dblink_get_result('paper_b') AS result(status text);
  IF seen <> 'accepted'
    OR NOT EXISTS (SELECT FROM assessment.race_result WHERE source_id=d AND official_id=c AND skill='reading')
    OR NOT EXISTS (SELECT FROM assessment.term_test_attempt WHERE id=c AND term2_official_submission
      AND listening_answers->>'1'='heard' AND reading_answers->>'1'='read')
    OR EXISTS (SELECT FROM assessment.term_test_attempt WHERE id=d AND reading_submitted_at IS NOT NULL)
    OR (SELECT count(*) FROM assessment.term_test_attempt WHERE term2_official_submission)<>2 THEN
    RAISE EXCEPTION 'Different-skill race did not preserve a single result for each student';
  END IF;
END
$race$;
SELECT dblink_disconnect('paper_a');
SELECT dblink_disconnect('paper_b');
SELECT 'term2-k56-paper-postgres-race passed' AS result,version() AS postgres_version;
`);
