-- Separate review drafts from the active approved bank. No historical rows are rewritten.
ALTER TABLE question ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;

-- All writers, including legacy approval/archive paths, invalidate stale drafts.
CREATE FUNCTION bump_question_content_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_version := OLD.content_version + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER question_content_version_update BEFORE UPDATE ON question
FOR EACH ROW EXECUTE FUNCTION bump_question_content_version();

CREATE TABLE question_revision (
  question_revision_id SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES question(question_id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW', 'PUBLISHED')),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_by INTEGER REFERENCES app_user(app_user_id),
  updated_by INTEGER REFERENCES app_user(app_user_id),
  reviewed_by INTEGER REFERENCES app_user(app_user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX question_revision_one_pending ON question_revision(question_id)
WHERE status = 'PENDING_REVIEW';
