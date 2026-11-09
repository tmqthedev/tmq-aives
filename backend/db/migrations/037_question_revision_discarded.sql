-- 037 Allow a lecturer to discard a pending revision. The approved question is
-- never touched; the draft row is kept for audit with a terminal status.
DO $$
DECLARE
  status_check TEXT;
BEGIN
  SELECT con.conname INTO status_check
    FROM pg_constraint con
   WHERE con.conrelid = 'question_revision'::regclass
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) LIKE '%PENDING_REVIEW%';
  IF status_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE question_revision DROP CONSTRAINT %I', status_check);
  END IF;
END $$;

ALTER TABLE question_revision
  ADD CONSTRAINT question_revision_status_check
    CHECK (status IN ('PENDING_REVIEW', 'PUBLISHED', 'DISCARDED'));

ALTER TABLE question_revision
  ADD COLUMN IF NOT EXISTS discarded_at TIMESTAMPTZ;
