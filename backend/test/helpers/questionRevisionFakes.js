const assert = require('node:assert/strict');
const { QuestionService } = require('../../src/services/questionService');

function createRevisionContext() {
  let state = {
    active: { question_id: 1, topic_id: 10, status: 'APPROVED', content_version: 1,
      content: 'Original', reference_answer: 'Original answer', key_points: ['Point'],
      rubric_id: 5, bloom_level: 'REMEMBER', language: 'EN' },
    revision: null,
  };
  const tx = { transaction: true };
  const repository = {
    findById: async () => structuredClone(state.active),
    findByIdForUpdate: async (_id, client) => { assert.equal(client, tx); return structuredClone(state.active); },
    findPendingRevision: async () => state.revision?.status === 'PENDING_REVIEW' ? structuredClone(state.revision) : null,
    findByNormalizedContent: async () => null,
    async savePendingRevision(id, { baseVersion, content, actorId, revision }, client) {
      assert.equal(client, tx);
      state.revision = { question_revision_id: 1, question_id: id, base_version: baseVersion,
        version: (revision?.version ?? 0) + 1, status: 'PENDING_REVIEW', content, created_by: actorId };
      return structuredClone(state.revision);
    },
    async update(_id, patch, client) {
      assert.equal(client, tx);
      const columns = { referenceAnswer: 'reference_answer', keyPoints: 'key_points',
        rubricId: 'rubric_id', bloomLevel: 'bloom_level', reviewedBy: 'reviewed_by',
        reviewedAt: 'reviewed_at', reviewNote: 'review_note' };
      for (const [key, value] of Object.entries(patch)) state.active[columns[key] || key] = value;
      state.active.content_version += 1;
      return structuredClone(state.active);
    },
    async markRevisionPublished(_id, actor, client) {
      assert.equal(client, tx);
      state.revision.status = 'PUBLISHED'; state.revision.reviewed_by = actor;
      return structuredClone(state.revision);
    },
  };
  const service = new QuestionService({ repository,
    db: { async withTransaction(fn) { const old = structuredClone(state); try { return await fn(tx); } catch (e) { state = old; throw e; } } },
    topicRepository: { getById: async () => ({ subject_id: 100 }) },
    rubricRepository: { findById: async (id) => ({ rubric_id: id, subject_id: id === 6 ? 200 : 100 }) },
    subjectScope: { forUser: user => ({ async assert() { if (user.id !== 7) throw Object.assign(new Error('scope'), { statusCode: 403 }); } }) },
  });
  return { service, repository, state: () => state };
}

module.exports = { createRevisionContext };
