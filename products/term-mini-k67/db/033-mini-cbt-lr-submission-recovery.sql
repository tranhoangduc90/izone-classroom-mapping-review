BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE assessment.mini_k67_cbt_journey
  ADD COLUMN IF NOT EXISTS lr_hold_cohort boolean NOT NULL DEFAULT false;

COMMIT;
