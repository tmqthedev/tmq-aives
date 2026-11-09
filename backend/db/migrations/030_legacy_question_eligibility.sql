-- Re-review incomplete legacy approvals; preserve content, review history and
-- historical assigned-question references. Never invent missing grading data.
UPDATE question
SET status = 'PENDING_REVIEW'
WHERE status = 'APPROVED'
  AND NOT (
    rubric_id IS NOT NULL
    AND COALESCE(reference_answer, '') ~ '[^[:space:]]'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(key_points) = 'array' THEN key_points ELSE '[]'::jsonb END
      ) AS kp(value)
      WHERE jsonb_typeof(kp.value) = 'string'
        AND (kp.value #>> '{}') ~ '[^[:space:]]'
    )
  );
