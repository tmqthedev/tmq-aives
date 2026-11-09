-- 032 Student STT dispute: let a student flag a mis-recognized answer so the
-- examiner knows to replay the turn audio. The original audio and transcript
-- are never changed; only the dispute marker/note are stored on qa_turn.
-- (Number 032 was reserved for this; do not edit applied migrations.)
ALTER TABLE qa_turn
  ADD COLUMN IF NOT EXISTS stt_disputed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stt_dispute_note TEXT;
