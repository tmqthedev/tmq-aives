const test = require('node:test');
const assert = require('node:assert/strict');
const { GradingService } = require('../src/services/gradingService');

function createMockDb() {
  const state = {
    vivaResults: new Map(),
    evaluations: new Map(),
    criterionScores: new Map(),
    adjustments: [],
  };

  return {
    state,
    async query(sql, params = []) {
      const s = sql.trim();
      if (s.startsWith('INSERT INTO viva_result')) {
        const id = state.vivaResults.size + 1;
        const row = { viva_result_id: id, interview_id: params[0], status: params[1] };
        state.vivaResults.set(id, row);
        return { rows: [row] };
      }
      if (s.includes('FROM viva_interview vi')) {
        return {
          rows: [
            {
              viva_interview_id: params[0],
              exam_session_id: 10,
              student_id: 200,
              exam_language: 'EN',
              session_title: 'Java OOP Exam',
            },
          ],
        };
      }
      if (s.includes('FROM assigned_question aq')) {
        return {
          rows: [
            {
              assigned_question_id: 1,
              order_no: 1,
              question_id: 50,
              knowledge_snapshot: {
                snapshot_version: 1, content: 'Explain Encapsulation in OOP.', bloom_level: 'UNDERSTAND',
                reference_answer: 'Data hiding with private fields and public accessors.',
                key_points: ['Data hiding', 'Private fields', 'Getters and setters'], rubric_id: 5,
                rubric_snapshot: { rubric_id: 5, max_score: 10, criteria: [{ rubric_criterion_id: 1, rubric_id: 5,
                  criterion_name: 'Conceptual Clarity', weight_percent: 100,
                  performance_levels: [{ performance_level_id: 10, criterion_id: 1, label: 'Excellent',
                    min_score: 8, max_score: 10, description: 'Clear and comprehensive' }] }] },
              },
              question_content: 'Explain Encapsulation in OOP.',
              bloom_level: 'UNDERSTAND',
              reference_answer: 'Data hiding with private fields and public accessors.',
              key_points: ['Data hiding', 'Private fields', 'Getters and setters'],
              rubric_id: 5,
            },
          ],
        };
      }
      if (s.includes('FROM qa_turn WHERE interview_id')) {
        return {
          rows: [
            {
              qa_turn_id: 1,
              interview_id: params[0],
              assigned_question_id: 1,
              sequence_no: 1,
              turn_type: 'MAIN',
              question_text: 'Explain Encapsulation in OOP.',
              answer_text: 'Encapsulation is data hiding where fields are kept private and accessed via public getters and setters.',
              status: 'ANSWERED',
            },
          ],
        };
      }
      if (s.includes('FROM rubric_criterion rc')) {
        return {
          rows: [
            {
              rubric_criterion_id: 1,
              rubric_id: 5,
              criterion_name: 'Conceptual Clarity',
              weight_percent: 100,
            },
          ],
        };
      }
      if (s.includes('FROM performance_level')) {
        return {
          rows: [
            {
              performance_level_id: 10,
              criterion_id: 1,
              label: 'Excellent',
              min_score: 8,
              max_score: 10,
              description: 'Clear and comprehensive',
            },
          ],
        };
      }
      if (s.includes('FROM subject_lecturer')) {
        // params: [subjectId, lecturerId]
        if (params[1] === 999) return { rows: [] }; // unassigned
        return { rows: [{ subject_id: params[0], lecturer_id: params[1] }] };
      }
      if (s.includes('FROM exam_session es')) {
        return { rows: [{ subject_id: 1 }] };
      }
      return { rows: [] };
    },
    async withTransaction(fn) {
      return fn({
        query: async (sql, params = []) => {
          if (sql.includes('INSERT INTO question_evaluation')) {
            const id = state.evaluations.size + 1;
            const row = {
              question_evaluation_id: id,
              result_id: params[0],
              assigned_question_id: params[1],
              ai_score: params[2],
              final_score: params[3],
              confidence: params[4],
            };
            state.evaluations.set(id, row);
            return { rows: [row] };
          }
          if (sql.includes('INSERT INTO criterion_score')) {
            const id = state.criterionScores.size + 1;
            const row = {
              criterion_score_id: id,
              evaluation_id: params[0],
              criterion_id: params[1],
              ai_level_id: params[2],
              ai_score: params[3],
              final_score: params[6],
            };
            state.criterionScores.set(id, row);
            return { rows: [row] };
          }
          return { rows: [] };
        },
      });
    },
  };
}

function createMockRepo(db) {
  let resultRecord = { viva_result_id: 1, interview_id: 100, status: 'PENDING' };
  return {
    async findByInterviewId(interviewId) {
      return resultRecord.interview_id === interviewId ? resultRecord : null;
    },
    async updateResult(id, fields) {
      resultRecord = { ...resultRecord, ...fields };
      return resultRecord;
    },
    async publishAiGrading(resultId, evals, fields) {
      await this.saveEvaluationsAndCriteria(resultId, evals);
      return this.updateResult(resultId, fields);
    },
    async saveEvaluationsAndCriteria(resultId, evals) {
      return db.withTransaction(async (client) => {
        for (const ev of evals) {
          const res = await client.query('INSERT INTO question_evaluation', [
            resultId,
            ev.assigned_question_id,
            ev.ai_score,
            ev.final_score,
            ev.confidence,
          ]);
          for (const cs of (ev.criteria || [])) {
            await client.query('INSERT INTO criterion_score', [
              res.rows[0].question_evaluation_id,
              cs.criterion_id,
              cs.ai_level_id,
              cs.ai_score,
              '',
              '[]',
              cs.final_score,
            ]);
          }
        }
      });
    },
    async findCriterionScoreById(id) {
      return {
        criterion_score_id: id,
        evaluation_id: 1,
        result_id: 1,
        ai_score: 8.5,
        final_score: 8.5,
        question_evaluation_id: 1,
      };
    },
    async insertScoreAdjustment(adj) {
      db.state.adjustments.push(adj);
      return adj;
    },
    async updateCriterionScore(id, { finalScore }) {
      return { criterion_score_id: id, final_score: finalScore };
    },
    async updateEvaluationScore(id, { finalScore }) {
      return { question_evaluation_id: id, final_score: finalScore };
    },
    async getFullResultDetail(id) {
      return {
        result: { ...resultRecord, exam_session_id: 10 },
        evaluations: [
          {
            question_evaluation_id: 1,
            final_score: 8.5,
            criteria: [{ criterion_score_id: 1, criterion_id: 1, final_score: 8.5, weight: 100, max_score: 10 }],
          },
        ],
        scoreAdjustments: db.state.adjustments,
      };
    },
    async listBySession(sessionId) {
      return [resultRecord];
    },
    async isExaminerOrCreator(sessionId, userId) {
      return userId !== 999;
    },
  };
}

test('gradeInterview scores interview via LLM and transitions to AI_SUGGESTED', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const mockLlm = {
    async gradeQuestion() {
      return {
        criteria_evaluations: [
          {
            criterion_id: 1,
            ai_level_id: 10,
            ai_score: 8.5,
            ai_justification: 'Well explained',
            evidence: [{ quote: 'Encapsulation is data hiding', key_point_index: 0, reference_quote: 'Data hiding' }],
          },
        ],
        strengths: 'Clear definitions',
        weaknesses: '',
        missing_points: [],
        feedback: 'Good work',
        confidence: 0.90,
      };
    },
  };

  const service = new GradingService({
    db,
    vivaResultRepository: repo,
    llmAdapter: mockLlm,
    enqueueJob: async () => {},
  });

  const res = await service.gradeInterview({ interviewId: 100 });
  assert.equal(res.status, 'AI_SUGGESTED');
  assert.equal(res.ai_total_score, 8.5);
  assert.equal(res.final_total_score, 8.5);
});

test('gradeInterview marks FLAGGED when AI confidence < 0.6', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const mockLlm = {
    async gradeQuestion() {
      return {
        criteria_evaluations: [{ criterion_id: 1, ai_score: 5.0 }],
        confidence: 0.45,
      };
    },
  };

  const service = new GradingService({
    db,
    vivaResultRepository: repo,
    llmAdapter: mockLlm,
    enqueueJob: async () => {},
  });

  const res = await service.gradeInterview({ interviewId: 100 });
  assert.equal(res.status, 'FLAGGED');
});

test('gradeInterview rejects invented performance levels without storing invalid foreign keys', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const service = new GradingService({ db, vivaResultRepository: repo,
    llmAdapter: { async gradeQuestion() { return {
      criteria_evaluations: [{ criterion_id: 1, ai_level_id: 9999, ai_score: 8,
        ai_justification: 'Explanation is clear' }], confidence: 0.9,
    }; } }, enqueueJob: async () => {} });
  const result = await service.gradeInterview({ interviewId: 100 });
  assert.equal(result.status, 'FLAGGED');
  assert.equal([...db.state.criterionScores.values()][0].ai_level_id, null);
  assert.equal(result.ai_total_score, null);
});

test('adjustCriterionScore records adjustment history and requires a reason', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const service = new GradingService({
    db,
    vivaResultRepository: repo,
    llmAdapter: {},
    enqueueJob: async () => {},
  });

  // Fails without reason
  await assert.rejects(
    () => service.adjustCriterionScore({
      criterionScoreId: 1,
      newScore: 9.5,
      reason: '',
      user: { id: 2, role: 'LECTURER' },
    }),
    (err) => err.code === 'REASON_REQUIRED'
  );

  // Succeeds with reason
  const updated = await service.adjustCriterionScore({
    criterionScoreId: 1,
    newScore: 9.5,
    reason: 'Student provided brilliant extra context',
    user: { id: 2, role: 'LECTURER' },
  });

  assert.equal(db.state.adjustments.length, 1);
  assert.equal(db.state.adjustments[0].newScore, 9.5);
  assert.equal(db.state.adjustments[0].reason, 'Student provided brilliant extra context');
});

test('finalize and reopen transitions result state', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const service = new GradingService({
    db,
    vivaResultRepository: repo,
    llmAdapter: {},
    enqueueJob: async () => {},
  });

  const finalized = await service.finalizeResult({ resultId: 1, user: { id: 2, role: 'LECTURER' } });
  assert.equal(finalized.status, 'FINALIZED');
  assert.equal(finalized.finalized_by, 2);

  const reopened = await service.reopenResult({ resultId: 1, user: { id: 2, role: 'LECTURER' } });
  assert.equal(reopened.status, 'AI_SUGGESTED');
  assert.equal(reopened.finalized_by, null);
});

test('assertSessionAccess forbids access for out-of-scope lecturer', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const service = new GradingService({
    db,
    vivaResultRepository: repo,
    llmAdapter: {},
    enqueueJob: async () => {},
  });

  await assert.rejects(
    () => service.listSessionResults({ examSessionId: 10, user: { id: 999, role: 'LECTURER' } }),
    (err) => err.code === 'FORBIDDEN'
  );
});

test('gradeInterview flags a question whose criteria the AI left out', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const mockLlm = {
    async gradeQuestion() {
      // Rubric criterion 1 is missing from the AI output.
      return { criteria_evaluations: [], confidence: 0.9, strengths: '', weaknesses: '', missing_points: [], feedback: '' };
    },
  };
  const service = new GradingService({ db, vivaResultRepository: repo, llmAdapter: mockLlm, enqueueJob: async () => {} });

  const res = await service.gradeInterview({ interviewId: 100 });
  assert.equal(res.status, 'FLAGGED');
  const rows = [...db.state.criterionScores.values()];
  assert.ok(rows.some((r) => Number(r.criterion_id) === 1 && r.ai_score == null));
});

test('gradeInterview rethrows transient errors so JobQueue can retry', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  const mockLlm = {
    async gradeQuestion() {
      const err = new Error('Rate exceeded');
      err.name = 'ThrottlingException';
      throw err;
    },
  };
  const service = new GradingService({ db, vivaResultRepository: repo, llmAdapter: mockLlm, enqueueJob: async () => {} });

  await assert.rejects(
    () => service.gradeInterview({ interviewId: 100 }),
    /Rate exceeded/
  );
});


test('grading and repeat grading use frozen assigned knowledge and never query mutable bank/rubric tables', async () => {
  const db = createMockDb();
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    assert.doesNotMatch(sql, /JOIN question |FROM rubric_criterion|FROM performance_level/);
    return query(sql, params);
  };
  const inputs = [];
  const service = new GradingService({ db, vivaResultRepository: createMockRepo(db), logger: { info() {}, error() {} },
    llmAdapter: { async gradeQuestion(input) { inputs.push(structuredClone(input)); return {
      criteria_evaluations: [{ criterion_id: 1, ai_level_id: 10, ai_score: 8, evidence: [] }], confidence: 0.9,
    }; } },
  });
  await service.gradeInterview({ interviewId: 100 });
  await service.gradeInterview({ interviewId: 100 });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(inputs[0].mainQuestion.reference_answer, 'Data hiding with private fields and public accessors.');
  assert.equal(inputs[0].rubricCriteria[0].performance_levels[0].performance_level_id, 10);
});

test('missing historical snapshot flags manual review without LLM calls or destroying existing evaluations', async () => {
  const db = createMockDb();
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    const result = await query(sql, params);
    if (sql.includes('FROM assigned_question aq')) result.rows.forEach(row => { row.knowledge_snapshot = null; });
    return result;
  };
  const repo = createMockRepo(db);
  repo.saveEvaluationsAndCriteria = async () => { throw new Error('must preserve historical evaluations'); };
  const service = new GradingService({ db, vivaResultRepository: repo, logger: { info() {} },
    llmAdapter: { gradeQuestion() { throw new Error('must not call LLM'); } },
  });
  const result = await service.gradeInterview({ interviewId: 100 });
  assert.equal(result.status, 'FLAGGED');
  assert.equal(result.ai_total_score, null);
  assert.match(result.grading_review_reason, /KNOWLEDGE_SNAPSHOT_MISSING/);
});


test('legacy regrade clears stale AI-derived total but preserves manually adjusted total and evaluations', async () => {
  for (const manual of [false, true]) {
    const db = createMockDb();
    const query = db.query.bind(db);
    db.query = async (sql, params) => {
      if (sql.includes('FROM score_adjustment sa')) return { rows: manual ? [{ exists: 1 }] : [] };
      const result = await query(sql, params);
      if (sql.includes('FROM assigned_question aq')) result.rows.forEach(row => { row.knowledge_snapshot = null; });
      return result;
    };
    const repo = createMockRepo(db);
    await repo.updateResult(1, { status: 'AI_SUGGESTED', ai_total_score: 8, final_total_score: 8 });
    repo.saveEvaluationsAndCriteria = async () => { throw new Error('must preserve evaluations'); };
    const service = new GradingService({ db, vivaResultRepository: repo, logger: { info() {} }, llmAdapter: {} });
    const result = await service.gradeInterview({ interviewId: 100 });
    assert.equal(result.status, 'FLAGGED');
    assert.equal(result.ai_total_score, null);
    assert.equal(result.final_total_score, manual ? 8 : null);
  }
});

test('queued AI grading never overwrites an already finalized lecturer result', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  await repo.updateResult(1, { status: 'FINALIZED', finalized_by: 7, final_total_score: 9 });
  db.query = async () => { throw new Error('finalized result must not be graded'); };
  const service = new GradingService({ db, vivaResultRepository: repo, logger: { info() {} }, llmAdapter: {} });
  const result = await service.gradeInterview({ interviewId: 100 });
  assert.equal(result.status, 'FINALIZED');
  assert.equal(result.final_total_score, 9);
});


test('malformed snapshot evidence routes grading to manual review before calling the LLM', async () => {
  for (const patch of [{ reference_answer: ' ' }, { key_points: [42, {}, ' '] },
    { rubric_snapshot: { criteria: [] } }, { snapshot_version: 99 }]) {
    const db = createMockDb();
    const query = db.query.bind(db);
    db.query = async (sql, params) => {
      const result = await query(sql, params);
      if (sql.includes('FROM assigned_question aq')) result.rows.forEach(row => Object.assign(row.knowledge_snapshot, patch));
      return result;
    };
    const service = new GradingService({ db, vivaResultRepository: createMockRepo(db), logger: { info() {} },
      llmAdapter: { gradeQuestion() { throw new Error('invalid evidence must not reach LLM'); } },
    });
    const result = await service.gradeInterview({ interviewId: 100 });
    assert.equal(result.status, 'FLAGGED');
    assert.equal(result.ai_total_score, null);
    assert.match(result.grading_review_reason, /KNOWLEDGE_SNAPSHOT_MISSING/);
  }
});


test('fabricated and material-only grading evidence yields FLAGGED with no credited scores', async () => {
  for (const quote of ['Invented student claim', 'Material-only explanation']) {
    const db = createMockDb();
    const repo = createMockRepo(db);
    const query = db.query.bind(db);
    db.query = async (sql, params) => {
      const result = await query(sql, params);
      if (sql.includes('FROM assigned_question aq')) result.rows[0].knowledge_snapshot.source_refs_snapshot = [{ content: quote }];
      return result;
    };
    const service = new GradingService({ db, vivaResultRepository: repo, logger: { info() {}, error() {} },
      llmAdapter: { async gradeQuestion() { return {
        criteria_evaluations: [{ criterion_id: 1, ai_level_id: 10, ai_score: 9,
          evidence: [{ quote, key_point_index: 0, reference_quote: 'Data hiding' }] }], confidence: 0.9,
      }; } },
    });
    const result = await service.gradeInterview({ interviewId: 100 });
    assert.equal(result.status, 'FLAGGED');
    assert.equal(result.ai_total_score, null);
    assert.equal(result.final_total_score, null);
    assert.equal([...db.state.criterionScores.values()][0].ai_score, null);
  }
});

test('old scores remain stored but hidden while the whole grading job is in progress', async () => {
  const db = createMockDb();
  const repo = createMockRepo(db);
  await repo.updateResult(1, { status: 'AI_SUGGESTED', ai_total_score: 7, final_total_score: 7 });
  let resume;
  let entered;
  const blocked = new Promise(resolve => { resume = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let published = false;
  const publish = repo.publishAiGrading.bind(repo);
  repo.publishAiGrading = async (...args) => { published = true; return publish(...args); };
  const service = new GradingService({ db, vivaResultRepository: repo, logger: { info() {}, error() {} },
    llmAdapter: { async gradeQuestion() {
      entered(); await blocked;
      return { criteria_evaluations: [{ criterion_id: 1, ai_level_id: 10, ai_score: 8,
        evidence: [{ quote: 'Encapsulation is data hiding', key_point_index: 0, reference_quote: 'Data hiding' }] }], confidence: 0.9 };
    } },
  });
  const job = service.gradeInterview({ interviewId: 100 });
  await started;
  assert.equal((await repo.findByInterviewId(100)).ai_total_score, 7);
  assert.equal(published, false);
  const user = { id: 2, role: 'LECTURER' };
  const list = await service.listSessionResults({ examSessionId: 10, user });
  assert.equal(list[0].ai_total_score, null);
  assert.equal(list[0].final_total_score, null);
  const detail = await service.getResultDetail({ resultId: 1, user });
  assert.equal(detail.result.final_total_score, null);
  assert.equal(detail.evaluations[0].final_score, null);
  assert.equal(detail.evaluations[0].criteria[0].final_score, null);
  assert.deepEqual(detail.scoreAdjustments, []);
  await assert.rejects(service.finalizeResult({ resultId: 1, user }), { code: 'GRADING_IN_PROGRESS' });
  resume();
  const result = await job;
  assert.equal(published, true);
  assert.equal(result.status, 'AI_SUGGESTED');
  assert.equal(result.ai_total_score, 8);
});
