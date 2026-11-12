BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE assessment.test_definition
  DROP CONSTRAINT test_definition_slug_check,
  ADD CONSTRAINT test_definition_slug_check CHECK (
    slug ~ '^(term-test-[1-9][0-9]*|mini-test-[a-z0-9-]+|pretest-lesson-16)$'
  );

-- Extend only the existing interruption scope. Preserve all snapshot requirements from 028.
DO $migration$
DECLARE
  definition text := (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname = 'term_test_attempt_section_snapshot_check'
      AND conrelid = 'assessment.term_test_attempt'::regclass);
  old_scope text := $old$ARRAY['term-test-1'::text, 'term-test-2'::text, 'mini-test-lesson-5'::text]$old$;
  new_scope text := $new$ARRAY['term-test-1'::text, 'term-test-2'::text, 'mini-test-lesson-5'::text, 'pretest-lesson-16'::text]$new$;
BEGIN
  IF definition IS NULL THEN
    RAISE EXCEPTION 'Missing K67 attempt section snapshot constraint';
  END IF;
  IF strpos(definition, new_scope) = 0 THEN
    IF length(definition) - length(replace(definition, old_scope, '')) <> length(old_scope) THEN
      RAISE EXCEPTION 'Unexpected K67 interruption scope';
    END IF;
    ALTER TABLE assessment.term_test_attempt DROP CONSTRAINT term_test_attempt_section_snapshot_check;
    EXECUTE 'ALTER TABLE assessment.term_test_attempt ADD CONSTRAINT term_test_attempt_section_snapshot_check '
      || replace(definition, old_scope, new_scope);
  END IF;
END $migration$;

-- NULL leaves the existing definitions alone. The Pretest opens only for listed ERP classes.
ALTER TABLE assessment.test_definition ADD COLUMN IF NOT EXISTS open_class_ids jsonb;
ALTER TABLE assessment.test_definition
  DROP CONSTRAINT IF EXISTS pretest_open_class_ids_check,
  ADD CONSTRAINT pretest_open_class_ids_check CHECK (
    open_class_ids IS NULL OR (slug = 'pretest-lesson-16' AND jsonb_typeof(open_class_ids) = 'array')
  );

-- Giữ cùng khóa giao dịch và cùng trigger với các lượt Term hiện hành.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('assessment.guard_term_k67_cbt_journey()'::regprocedure);
  old_scope text := $old$IF NEW.test_slug NOT IN ('term-test-1','term-test-2') THEN RETURN NEW; END IF;$old$;
  new_scope text := $new$IF NEW.test_slug NOT IN ('term-test-1','term-test-2','pretest-lesson-16') THEN RETURN NEW; END IF;$new$;
BEGIN
  IF strpos(definition, new_scope) = 0 THEN
    IF length(definition) - length(replace(definition, old_scope, '')) <> length(old_scope) THEN
      RAISE EXCEPTION 'Unexpected K67 CBT journey guard definition';
    END IF;
    EXECUTE replace(definition, old_scope, new_scope);
  END IF;
END $migration$;

DO $migration$
DECLARE
  definition text := pg_get_functiondef('assessment.reset_demo_term_test_student(text,text,uuid)'::regprocedure);
  old_scope text := $old$trim(p_test_slug) NOT IN ('term-test-1', 'term-test-2', 'mini-test-lesson-5')$old$;
  new_scope text := $new$trim(p_test_slug) NOT IN ('term-test-1', 'term-test-2', 'mini-test-lesson-5', 'pretest-lesson-16')$new$;
BEGIN
  IF strpos(definition, new_scope) = 0 THEN
    IF length(definition) - length(replace(definition, old_scope, '')) <> length(old_scope)
      OR strpos(definition, $check$IF upper(trim(p_class_code)) <> 'CODEXDEMO806'$check$) = 0 THEN
      RAISE EXCEPTION 'Unexpected K67 demo reset scope';
    END IF;
    EXECUTE replace(definition, old_scope, new_scope);
  END IF;
END $migration$;

COMMIT;
