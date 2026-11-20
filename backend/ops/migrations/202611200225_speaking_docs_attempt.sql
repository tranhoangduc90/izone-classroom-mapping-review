CREATE SCHEMA IF NOT EXISTS speaking_docs_write;

CREATE TABLE IF NOT EXISTS speaking_docs_write.attempt (
  lane text NOT NULL CHECK (lane IN ('speaking_homework', 'speaking_independent')),
  event_id uuid NOT NULL,
  document_id text NOT NULL,
  tab_id text NOT NULL,
  account_role text NOT NULL CHECK (account_role IN ('primary', 'fallback')),
  revision_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lane, event_id)
);
