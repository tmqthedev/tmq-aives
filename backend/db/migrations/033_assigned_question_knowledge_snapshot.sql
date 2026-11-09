-- Old assignments remain NULL: their original approved knowledge is unknown.
-- Do not manufacture historical evidence from today's mutable question bank.
ALTER TABLE assigned_question ADD COLUMN knowledge_snapshot JSONB;
ALTER TABLE assigned_question ADD COLUMN legacy_question_text TEXT;
ALTER TABLE assigned_question ADD COLUMN legacy_prompt_source TEXT;
ALTER TABLE viva_result ADD COLUMN grading_review_reason TEXT;
-- Operational prompts only, never represented as approved grading evidence.
-- Preserve recorded MAIN text; unasked questions use a frozen cutover prompt.
UPDATE assigned_question aq
SET legacy_question_text = COALESCE(
      (SELECT qt.question_text FROM qa_turn qt WHERE qt.assigned_question_id = aq.assigned_question_id
       AND qt.turn_type = 'MAIN' ORDER BY qt.sequence_no LIMIT 1), q.content),
    legacy_prompt_source = CASE WHEN EXISTS (
      SELECT 1 FROM qa_turn qt WHERE qt.assigned_question_id = aq.assigned_question_id AND qt.turn_type = 'MAIN'
    ) THEN 'RECORDED_TURN' ELSE 'BANK_AT_MIGRATION' END
FROM question q WHERE q.question_id = aq.question_id;

ALTER TABLE assigned_question ADD CONSTRAINT assigned_question_snapshot_object
CHECK (knowledge_snapshot IS NULL OR jsonb_typeof(knowledge_snapshot) = 'object');
CREATE FUNCTION protect_assigned_question_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.knowledge_snapshot IS DISTINCT FROM OLD.knowledge_snapshot
    OR NEW.legacy_question_text IS DISTINCT FROM OLD.legacy_question_text
    OR NEW.legacy_prompt_source IS DISTINCT FROM OLD.legacy_prompt_source
    OR NEW.question_id IS DISTINCT FROM OLD.question_id
    OR NEW.interview_id IS DISTINCT FROM OLD.interview_id THEN
    RAISE EXCEPTION 'Assigned question knowledge snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assigned_question_snapshot_immutable BEFORE UPDATE ON assigned_question
FOR EACH ROW EXECUTE FUNCTION protect_assigned_question_snapshot();
