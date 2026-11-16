BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS assessment_k56.journal_term2_cloud_enrollment (
  pilot_id text NOT NULL,
  scope_id text NOT NULL,
  renew_until_ms bigint NOT NULL,
  PRIMARY KEY (pilot_id, scope_id)
);
GRANT SELECT, INSERT ON assessment_k56.journal_term2_cloud_enrollment TO k56_shared_api;
COMMIT;
