-- Link chung giữ riêng cấu hình mở; binding không Docs chỉ hợp lệ khi được đánh dấu rõ.
BEGIN;
CREATE TABLE IF NOT EXISTS listening_practice.shared_lesson (
 code text PRIMARY KEY,
 content_id uuid NOT NULL REFERENCES listening_practice.content(id),
 status text NOT NULL CHECK(status IN ('open','closed'))
);
ALTER TABLE listening_practice.binding ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE listening_practice.binding ALTER COLUMN tab_id DROP NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='listening_practice.binding'::regclass AND conname='listening_binding_document_mode') THEN
  ALTER TABLE listening_practice.binding ADD CONSTRAINT listening_binding_document_mode CHECK(
   (document_id IS NOT NULL AND tab_id IS NOT NULL) OR
   (document_id IS NULL AND tab_id IS NULL AND coalesce(owner_proof->>'mode'='shared',false))
  );
 END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='listening_practice_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON listening_practice.shared_lesson TO listening_practice_app;
 END IF;
END $$;
COMMIT;
