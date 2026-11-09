-- 034 Durable, stage-only grading progress (Step 14). Tracks where a
-- GRADE_INTERVIEW job is inside the grading pipeline so lecturer/admin UIs can
-- show a live "stage" and "question i/n" without exposing per-question scores
-- before the whole job finishes. No model reasoning is stored here.
ALTER TABLE viva_result
  ADD COLUMN IF NOT EXISTS grading_stage TEXT,
  ADD COLUMN IF NOT EXISTS grading_current INTEGER,
  ADD COLUMN IF NOT EXISTS grading_total INTEGER,
  ADD COLUMN IF NOT EXISTS grading_updated_at TIMESTAMPTZ;

ALTER TABLE viva_result
  ADD CONSTRAINT viva_result_grading_stage_check
  CHECK (grading_stage IS NULL OR grading_stage IN (
    'QUEUED',
    'PREPARING',
    'SCORING',
    'AGGREGATING',
    'RETRYING',
    'FAILED',
    'AWAITING_REVIEW'
  ));
