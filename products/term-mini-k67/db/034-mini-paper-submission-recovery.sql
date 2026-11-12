BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE assessment.mini_k67_paper_offline_run
  ADD COLUMN IF NOT EXISTS lr_hold_cohort boolean NOT NULL DEFAULT false;

COMMIT;
