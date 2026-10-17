BEGIN;
ALTER TABLE reading_practice.teacher_session ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz;
ALTER TABLE reading_practice.teacher_session ADD COLUMN IF NOT EXISTS remembered boolean NOT NULL DEFAULT false;
UPDATE reading_practice.teacher_session SET absolute_expires_at=expires_at WHERE absolute_expires_at IS NULL;
ALTER TABLE reading_practice.teacher_session ALTER COLUMN absolute_expires_at SET NOT NULL;
ALTER TABLE reading_practice.teacher_session ALTER COLUMN absolute_expires_at SET DEFAULT (now()+interval '1 hour');
COMMIT;
