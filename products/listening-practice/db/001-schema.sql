-- Kho Reading riêng: giữ bài cá nhân và chốt lượt trong một giao dịch khóa hàng.
CREATE SCHEMA IF NOT EXISTS listening_practice;
CREATE TABLE IF NOT EXISTS listening_practice.content (
 id uuid PRIMARY KEY, code text NOT NULL, version text NOT NULL, digest text NOT NULL,
 definition jsonb NOT NULL, answer_key jsonb NOT NULL, explanations jsonb NOT NULL,
 total_ms integer NOT NULL CHECK(total_ms=579207), UNIQUE(code,version)
);
CREATE TABLE IF NOT EXISTS listening_practice.assignment (
 id uuid PRIMARY KEY, class_id text NOT NULL, class_code text NOT NULL,
 content_id uuid NOT NULL REFERENCES listening_practice.content(id),
 status text NOT NULL CHECK(status IN ('draft','open','closed')),
 source_course_id text, source_work_id text, UNIQUE(class_id,content_id)
);
CREATE TABLE IF NOT EXISTS listening_practice.binding (
 id uuid PRIMARY KEY, assignment_id uuid NOT NULL REFERENCES listening_practice.assignment(id),
 student_ref uuid NOT NULL, document_id text UNIQUE NOT NULL, tab_id text NOT NULL,
 entry_hash text UNIQUE NOT NULL, owner_proof jsonb NOT NULL, cta_verified_at timestamptz,
 last_doc_sequence integer NOT NULL DEFAULT 0, last_doc_text text NOT NULL DEFAULT '',
 last_doc_link text NOT NULL DEFAULT '', UNIQUE(assignment_id,student_ref)
);
CREATE TABLE IF NOT EXISTS listening_practice.student_session (
 token_hash text PRIMARY KEY, binding_id uuid NOT NULL REFERENCES listening_practice.binding(id),
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS listening_practice.teacher_session (
 token_hash text PRIMARY KEY, email text NOT NULL, google_subject text NOT NULL,
 expires_at timestamptz NOT NULL,
 absolute_expires_at timestamptz NOT NULL DEFAULT (now()+interval '1 hour'),
 remembered boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS listening_practice.work (
 binding_id uuid PRIMARY KEY REFERENCES listening_practice.binding(id), state jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS listening_practice.operation (
 binding_id uuid NOT NULL REFERENCES listening_practice.binding(id), operation_id uuid NOT NULL,
 fingerprint text NOT NULL, response jsonb NOT NULL, PRIMARY KEY(binding_id,operation_id)
);
CREATE TABLE IF NOT EXISTS listening_practice.doc_job (
 id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES listening_practice.binding(id),
 sequence integer NOT NULL, kind text NOT NULL CHECK(kind IN ('cta','status')),
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','processing','verified','blocked')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid, lease_until timestamptz, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
 UNIQUE(binding_id,sequence)
);
CREATE INDEX IF NOT EXISTS reading_doc_due ON listening_practice.doc_job(status,available_at);
