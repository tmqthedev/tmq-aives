-- Bump content_version only when approved knowledge or lifecycle status
-- changes. Embedding refreshes, review notes and other bookkeeping writes must
-- not stale a pending revision (save/publish would return REVISION_CONFLICT).
CREATE OR REPLACE FUNCTION bump_question_content_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
    OR NEW.reference_answer IS DISTINCT FROM OLD.reference_answer
    OR NEW.key_points IS DISTINCT FROM OLD.key_points
    OR NEW.rubric_id IS DISTINCT FROM OLD.rubric_id
    OR NEW.bloom_level IS DISTINCT FROM OLD.bloom_level
    OR NEW.language IS DISTINCT FROM OLD.language
    OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
    OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.content_version := OLD.content_version + 1;
  ELSE
    NEW.content_version := OLD.content_version;
  END IF;
  RETURN NEW;
END;
$$;
