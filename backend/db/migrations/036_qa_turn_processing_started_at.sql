-- 036 Crash recovery for a turn left in PROCESSING (e.g. the backend died while
-- transcribing/grading an answer). The read paths release a PROCESSING turn
-- whose claim is older than TURN_PROCESSING_STALE_SEC back to ANSWERING. Rows
-- claimed before this migration have NULL and are treated as stale.
ALTER TABLE qa_turn
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
