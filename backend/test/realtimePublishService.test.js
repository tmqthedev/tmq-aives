const test = require('node:test');
const assert = require('node:assert/strict');
const { QuestionService } = require('../src/services/questionService');
const { GradingService } = require('../src/services/gradingService');
const { InterviewService } = require('../src/services/interviewService');

function bus() {
  const events = [];
  return { events, publish: (entity, payload) => events.push({ entity, ...payload }) };
}
const quiet = { warn() {}, info() {}, error() {} };

// --- questions ---------------------------------------------------------------
function questionService(realtimeBus, { failUpdate = false } = {}) {
  const row = {
    question_id: 1, topic_id: 1, status: 'PENDING_REVIEW', rubric_id: 5,
    reference_answer: 'ans', key_points: ['kp'],
  };
  const repository = {
    findById: async () => ({ ...row }),
    updateStatusFields: async (id, f) => {
      if (failUpdate) throw new Error('db down');
      return { ...row, status: f.status };
    },
    deleteById: async () => ({ ...row }),
  };
  return new QuestionService({
    repository,
    realtimeBus,
    logger: quiet,
    topicRepository: { getById: async () => ({ topic_id: 1, subject_id: 7 }) },
    rubricRepository: { findById: async () => ({ rubric_id: 5, subject_id: 7 }) },
  });
}

test('question approve publishes after the write with subject scope', async () => {
  const b = bus();
  await questionService(b).approve(1, { reviewedBy: 3 });
  assert.deepEqual(b.events.map((e) => [e.entity, e.action, e.questionId, e.subjectId, e.status]),
    [['question', 'status_changed', 1, 7, 'APPROVED']]);
});

test('question write failure publishes nothing; publish failure does not fail the write', async () => {
  const b = bus();
  await assert.rejects(() => questionService(b, { failUpdate: true }).approve(1, {}));
  assert.equal(b.events.length, 0);
  const broken = { publish() { throw new Error('bus down'); } };
  const q = await questionService(broken).approve(1, {});
  assert.equal(q.status, 'APPROVED');
});

test('question delete publishes deleted', async () => {
  const b = bus();
  await questionService(b).deleteQuestion(1);
  assert.equal(b.events[0].action, 'deleted');
});

// --- results -----------------------------------------------------------------
function gradingService(realtimeBus, status) {
  const result = {
    viva_result_id: 9, interview_id: 5, status, exam_session_id: 1, student_id: 20, subject_id: 7,
  };
  const vivaResultRepository = {
    getFullResultDetail: async () => ({ result, evaluations: [] }),
    updateResult: async (id, patch) => ({ ...result, ...patch }),
  };
  return new GradingService({
    db: {}, vivaResultRepository, realtimeBus, logger: quiet, enqueueJob: async () => {},
  });
}

test('finalize and reopen publish result events routed to the owning student', async () => {
  const b = bus();
  const admin = { id: 1, role: 'ADMIN' };
  await gradingService(b, 'AI_SUGGESTED').finalizeResult({ resultId: 9, user: admin });
  await gradingService(b, 'FINALIZED').reopenResult({ resultId: 9, user: admin });
  assert.deepEqual(b.events.map((e) => [e.entity, e.action, e.status, e.studentUserId, e.subjectId]), [
    ['result', 'finalized', 'FINALIZED', 20, 7],
    ['result', 'reopened', 'AI_SUGGESTED', 20, 7],
  ]);
});

test('rejected grading actions publish nothing', async () => {
  const b = bus();
  const admin = { id: 1, role: 'ADMIN' };
  await assert.rejects(() => gradingService(b, 'AI_SCORING').finalizeResult({ resultId: 9, user: admin }));
  await assert.rejects(() => gradingService(b, 'AI_SUGGESTED').reopenResult({ resultId: 9, user: admin }));
  assert.equal(b.events.length, 0);
});

test('regrade publishes AI_SCORING status change', async () => {
  const b = bus();
  await gradingService(b, 'FLAGGED').regradeResult({ resultId: 9, user: { id: 1, role: 'ADMIN' } });
  assert.equal(b.events[0].status, 'AI_SCORING');
});

// --- interviews --------------------------------------------------------------
test('interview completion publishes once, only when this call ended it, without answer text', async () => {
  const b = bus();
  const ended = {
    viva_interview_id: 5, exam_session_id: 1, student_id: 20, status: 'COMPLETED',
  };
  let first = true;
  const service = new InterviewService({
    realtimeBus: b,
    logger: quiet,
    db: { withTransaction: async (fn) => fn({}) },
    examSessionRepository: { findById: async () => ({ exam_session_id: 1, subject_id: 7 }) },
    vivaInterviewRepository: {
      completeIfActive: async () => { const r = first ? ended : null; first = false; return r; },
      findById: async () => ended,
    },
    qaTurnRepository: { markOpenTurnsUnanswered: async () => {}, listByInterview: async () => [] },
    transcriptRepository: { upsert: async () => {} },
    vivaResultRepository: { createPendingIfAbsent: async () => {} },
    sessionContextStore: { update: async () => {} },
    enqueueJob: async () => {},
  });
  const iv = { viva_interview_id: 5, exam_session_id: 1, student_id: 20 };
  await service._endInterview(iv, 'DEADLINE_REACHED');
  await service._endInterview(iv, 'DEADLINE_REACHED');
  assert.equal(b.events.length, 1);
  assert.deepEqual(b.events[0], {
    entity: 'interview', action: 'completed', interviewId: 5, examSessionId: 1, subjectId: 7,
    status: 'COMPLETED', studentUserId: 20,
  });
});
