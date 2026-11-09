const assert = require('node:assert/strict');

// This helper only authorizes synthetic rows from the exact marked run/job.
// Generated live banks must remain subject to normal human review.
async function approveSyntheticSmokeQuestions({
  db, questionService, run, jobId, topicId, lecturerId, rubricId, scenario,
}) {
  assert.match(run, /^AI-SMOKE-\d+$/);
  assert.equal(typeof scenario, 'string');
  assert.ok(scenario.trim());
  const { rows } = await db.query(
    `SELECT q.question_id FROM question q
     JOIN question_generation_job j ON j.question_generation_job_id = q.generation_job_id
     JOIN topic t ON t.topic_id = q.topic_id
     JOIN subject s ON s.subject_id = t.subject_id
     WHERE q.generation_job_id = $1 AND q.topic_id = $2 AND q.created_by = $3
       AND j.requested_by = $3 AND j.topic_id = $2 AND s.code = $4
       AND q.status = 'PENDING_REVIEW'
     ORDER BY q.question_id`,
    [jobId, topicId, lecturerId, run],
  );
  assert.ok(rows.length > 0, 'No pending synthetic questions matched the smoke run, job and owner.');
  const user = { id: lecturerId, role: 'LECTURER' };
  // Both the answer and each point are verbatim synthetic source statements,
  // avoiding invented answers for generated questions or edits to live data.
  const referenceAnswer = scenario.trim();
  const keyPoints = referenceAnswer.split(/(?<=[.!?])\s+/u).filter(Boolean);
  for (const { question_id: id } of rows) {
    await questionService.updateQuestion(id, { rubricId, referenceAnswer, keyPoints }, user);
    await questionService.approve(id, { reviewedBy: lecturerId, user });
  }
  return rows.map(row => row.question_id);
}

module.exports = { approveSyntheticSmokeQuestions };
