BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS assessment.journal_k67_pilot_enrollment (
  pilot_id text NOT NULL,
  scope_id text NOT NULL,
  renew_until_ms bigint NOT NULL,
  PRIMARY KEY (pilot_id, scope_id)
);
GRANT SELECT, INSERT ON assessment.journal_k67_pilot_enrollment TO k67_app;
COMMIT;
