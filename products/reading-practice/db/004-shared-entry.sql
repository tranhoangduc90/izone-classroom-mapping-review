-- Link chung giữ riêng cấu hình mở; binding không Docs chỉ hợp lệ khi được đánh dấu rõ.
BEGIN;
CREATE TABLE IF NOT EXISTS reading_practice.shared_lesson (
 code text PRIMARY KEY,
 content_id uuid NOT NULL REFERENCES reading_practice.content(id),
 status text NOT NULL CHECK(status IN ('open','closed'))
);
ALTER TABLE reading_practice.binding ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE reading_practice.binding ALTER COLUMN tab_id DROP NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reading_practice.binding'::regclass AND conname='reading_binding_document_mode') THEN
  ALTER TABLE reading_practice.binding ADD CONSTRAINT reading_binding_document_mode CHECK(
   (document_id IS NOT NULL AND tab_id IS NOT NULL) OR
   (document_id IS NULL AND tab_id IS NULL AND coalesce(owner_proof->>'mode'='shared',false))
  );
 END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reading_practice_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON reading_practice.shared_lesson TO reading_practice_app;
 END IF;
END $$;
COMMIT;
