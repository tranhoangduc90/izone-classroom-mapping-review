-- Phiên làm quen độc lập: không liên kết attempt/đề thật, không phát sinh chấm hoặc đồng bộ.
BEGIN;
CREATE TABLE assessment.k67_readiness_session (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  class_id bigint NOT NULL,
  student_ref uuid NOT NULL,
  pack_version text NOT NULL,
  same_computer boolean,
  same_headphones boolean,
  answers jsonb NOT NULL DEFAULT '{}',
  draft_revision bigint NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  heard_seconds double precision NOT NULL DEFAULT 0 CHECK (heard_seconds >= 0 AND heard_seconds <= 600),
  heard_confirmed boolean,
  cache_state text NOT NULL DEFAULT 'not_checked' CHECK (cache_state IN ('not_checked','saved','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  submitted_at timestamptz
);
CREATE INDEX k67_readiness_expiry ON assessment.k67_readiness_session(expires_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON assessment.k67_readiness_session TO k67_app;
COMMIT;
