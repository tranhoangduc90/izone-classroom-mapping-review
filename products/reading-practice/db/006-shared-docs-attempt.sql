ALTER TABLE reading_practice.doc_job
 ADD COLUMN IF NOT EXISTS shared_docs_attempt jsonb;
