-- Additive: durable latest progress, separate roles/queues for the two Speaking stores.
BEGIN;
CREATE TABLE speaking_homework.doc_progress (
  unit_id uuid PRIMARY KEY REFERENCES speaking_homework.access_grant(id),
  document_id text NOT NULL, tab_id text NOT NULL, assignment_code text NOT NULL,
  sequence bigint NOT NULL DEFAULT 1, applied_sequence bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL, last_text text NOT NULL DEFAULT '', last_link text NOT NULL DEFAULT '',
  attempt_text text, attempt_link text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','verified','blocked')),
  attempts integer NOT NULL DEFAULT 0, error_code text,
  available_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
GRANT SELECT,INSERT,UPDATE ON speaking_homework.doc_progress TO speaking_homework_api;
COMMIT;
