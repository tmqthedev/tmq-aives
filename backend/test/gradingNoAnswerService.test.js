const test = require('node:test');
const assert = require('node:assert/strict');
const { GradingService } = require('../src/services/gradingService');
const { isSubstantiveAnswer, isUnansweredQuestion } = require('../src/domain/scoringRules');

// Two main questions (assigned 1 and 2), one criterion each, lowest level 4-6.
function buildService({ turns, language = 'VI', llmScore = 6 }) {
  const saved = [];
  let result = { viva_result_id: 1, interview_id: 100, status: 'PENDING' };
  const llmCalls = [];
  const db = {
    async query(sql, params = []) {
      if (sql.includes('FROM viva_interview vi')) {
        return { rows: [{ viva_interview_id: params[0], exam_language: language }] };
      }
      if (sql.includes('FROM assigned_question aq')) {
        return {
          rows: [1, 2].map((id) => ({
            assigned_question_id: id,
            question_content: `Question ${id}`,
            key_points: [`Point ${id}`],
            rubric_id: 5,
            knowledge_snapshot: {
              snapshot_version: 1, content: `Question ${id}`, bloom_level: 'UNDERSTAND',
              reference_answer: 'Đóng gói là che giấu dữ liệu', key_points: ['che giấu dữ liệu'], rubric_id: 5,
              rubric_snapshot: { rubric_id: 5, max_score: 10, criteria: [{ rubric_criterion_id: 1, rubric_id: 5,
                criterion_name: 'Accuracy', weight_percent: 100,
                performance_levels: [{ performance_level_id: 10, criterion_id: 1, label: 'Low',
                  min_score: 4, max_score: 6, description: 'Lowest level' }] }] },
            },
          })),
        };
      }
      if (sql.includes('FROM qa_turn')) return { rows: turns };
      if (sql.includes('FROM rubric_criterion rc')) {
        return { rows: [{ rubric_criterion_id: 1, weight_percent: 100, max_score: 10 }] };
      }
      if (sql.includes('FROM performance_level')) {
        return { rows: [{ performance_level_id: 10, min_score: 4, max_score: 6 }] };
      }
      return { rows: [] };
    },
  };
  const repo = {
    async findByInterviewId() { return result; },
    async updateResult(_id, fields) { result = { ...result, ...fields }; return result; },
    async saveEvaluationsAndCriteria(_id, evals) { saved.push(...evals); },
    async publishAiGrading(id, evals, fields) {
      await this.saveEvaluationsAndCriteria(id, evals);
      return this.updateResult(id, fields);
    },
  };
  const llmAdapter = {
    async gradeQuestion(input) {
      llmCalls.push(input);
      return {
        criteria_evaluations: [{ criterion_id: 1, ai_level_id: 10, ai_score: llmScore, ai_justification: 'ok',
          // Satisfies the evidence gate for the Vietnamese answer used below.
          evidence: [{ quote: 'che giấu dữ liệu', key_point_index: 0, reference_quote: 'che giấu dữ liệu' }] }],
        confidence: 0.9,
      };
    },
  };
  const service = new GradingService({
    db, vivaResultRepository: repo, llmAdapter, enqueueJob: async () => {},
    logger: { info() {}, error() {} },
  });
  return { service, saved, llmCalls };
}

const turn = (assignedId, answer, extra = {}) => ({
  assigned_question_id: assignedId, turn_type: 'MAIN', question_text: 'Q', answer_text: answer, status: 'ANSWERED', ...extra,
});

test('isSubstantiveAnswer ignores empty text, punctuation, STT tags and filler sounds', () => {
  for (const text of [null, '', '   ', '...', '[silence]', '(no speech)', 'ờ... ừm', 'Uh, um.']) {
    assert.equal(isSubstantiveAnswer(text), false, JSON.stringify(text));
  }
  for (const text of ['Có', 'OOP', '42', 'ừ em nghĩ là đóng gói']) {
    assert.equal(isSubstantiveAnswer(text), true, JSON.stringify(text));
  }
  assert.equal(isUnansweredQuestion([]), true);
  assert.equal(isUnansweredQuestion([{ answer_text: '' }, { answer_text: 'Đóng gói dữ liệu' }]), false);
});

test('a silent interview scores 0 without calling the LLM', async () => {
  const { service, saved, llmCalls } = buildService({ turns: [turn(1, ''), turn(2, '  ừm ')] });
  const res = await service.gradeInterview({ interviewId: 100 });

  assert.equal(llmCalls.length, 0);
  assert.equal(res.ai_total_score, 0);
  assert.equal(res.final_total_score, 0);
  assert.equal(res.status, 'AI_SUGGESTED');
  assert.equal(saved.length, 2);
  for (const ev of saved) {
    assert.equal(ev.ai_score, 0);
    assert.equal(ev.model_id, 'rule:no-answer');
    assert.match(ev.feedback, /Không có câu trả lời/);
    assert.deepEqual(ev.criteria.map((c) => [c.ai_score, c.final_score, c.ai_level_id]), [[0, 0, null]]);
  }
});

test('only answered questions go to the LLM; unanswered ones count as 0 in the mean', async () => {
  const { service, saved, llmCalls } = buildService({
    turns: [turn(1, 'Đóng gói là che giấu dữ liệu'), turn(2, '')],
    llmScore: 6,
  });
  const res = await service.gradeInterview({ interviewId: 100 });

  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0].mainQuestion.content, 'Question 1');
  assert.deepEqual(saved.map((e) => e.ai_score), [6, 0]);
  assert.equal(res.ai_total_score, 3);
});

test('a question never asked before the deadline scores 0 and uses the exam language', async () => {
  const { service, saved, llmCalls } = buildService({ turns: [turn(1, 'Encapsulation hides data')], language: 'EN' });
  await service.gradeInterview({ interviewId: 100 });

  assert.equal(llmCalls.length, 1);
  assert.equal(saved[1].ai_score, 0);
  assert.match(saved[1].feedback, /No answer was given/);
});

test('a follow-up answer is enough for the question to be graded by the LLM', async () => {
  const { service, llmCalls } = buildService({
    turns: [turn(1, ''), turn(1, 'Dùng private field', { turn_type: 'FOLLOW_UP' }), turn(2, 'Kế thừa')],
  });
  await service.gradeInterview({ interviewId: 100 });
  assert.equal(llmCalls.length, 2);
});
