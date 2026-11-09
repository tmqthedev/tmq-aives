function readKnowledgeSnapshot(assigned) {
  let snapshot = assigned && assigned.knowledge_snapshot;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
  }
  const nonblank = value => typeof value === 'string' && value.trim() !== '';
  const criteria = snapshot?.rubric_snapshot?.criteria;
  if (!snapshot || snapshot.snapshot_version !== 1 || !nonblank(snapshot.content)
    || !nonblank(snapshot.reference_answer)
    || !Array.isArray(snapshot.key_points) || !snapshot.key_points.some(nonblank)
    || !Array.isArray(criteria) || criteria.length === 0
    || criteria.some(criterion => !criterion || typeof criterion !== 'object' || Array.isArray(criterion))) {
    const error = new Error('Original assigned-question knowledge is unavailable; specialist review is required.');
    error.statusCode = 409;
    error.code = 'KNOWLEDGE_SNAPSHOT_MISSING';
    throw error;
  }
  return snapshot;
}
// Legacy continuation gets only frozen operational text, never reference data.
function readInterviewQuestion(assigned) {
  if (assigned?.knowledge_snapshot != null) return readKnowledgeSnapshot(assigned);
  if (assigned?.legacy_question_text) return {
    question_id: assigned.question_id, content: assigned.legacy_question_text,
    snapshot_version: 0, legacy_operational_only: true, source: 'MANUAL',
    rubric_snapshot: { criteria: [] }, source_refs_snapshot: [], key_points: [],
  };
  return readKnowledgeSnapshot(assigned);
}
module.exports = { readKnowledgeSnapshot, readInterviewQuestion };
