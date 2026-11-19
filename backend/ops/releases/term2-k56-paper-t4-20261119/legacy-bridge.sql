BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assessment.term_test_exam_session
  ADD COLUMN term2_paper_legacy_bridge jsonb,
  ADD CONSTRAINT term2_paper_legacy_bridge_scope CHECK (
    term2_paper_legacy_bridge IS NULL OR (
      term2_paper_profile_id IS NOT NULL
      AND jsonb_typeof(term2_paper_legacy_bridge) = 'object'
      AND term2_paper_legacy_bridge ? 'attemptToken'
      AND term2_paper_legacy_bridge ? 'examSessionToken'
    )
  );

COMMIT;
