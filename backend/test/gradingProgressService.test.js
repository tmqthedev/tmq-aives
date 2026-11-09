const test = require('node:test');
const assert = require('node:assert/strict');
const { GradingService } = require('../src/services/gradingService');
const { toStudentResultView } = require('../src/interview/studentResultView');
const { makeGradeInterviewHandler } = require('../src/jobs/handlers');

function createDb() {
  return {
    async query(sql, params = []) {
      if (sql.includes('FROM viva_interview vi JOIN exam_session es')) {
        return { rows: [{ exam_session_id: 10, student_id: 200, subject_id: 1 }] };
      }
      if (sql.includes('FROM viva_interview vi')) {
        return {
          rows: [{
            viva_interview_id: params[0], exam_session_id: 10, student_id: 200,
            exam_language: 'EN', session_title: 'Java OOP Exam',
          }],
        };
      }
      if (sql.includes('FROM assigned_question aq')) {
        return {
          rows: [{
            assigned_question_id: 1, order_no: 1, question_id: 50,
            knowledge_snapshot: {
              snapshot_version: 1, content: 'Explain Encapsulation in OOP.', bloom_level: 'UNDERSTAND',
              reference_answer: 'Data hiding with private fields and public accessors.',
              key_points: ['Data hiding', 'Private fields', 'Getters and setters'],
              rubric_snapshot: { max_score: 10, criteria: [{ rubric_criterion_id: 1, criterion_name: 'Conceptual Clarity',
                weight_percent: 100,
                performance_levels: [{ performance_level_id: 10, criterion_id: 1, label: 'Excellent',
                  min_score: 8, max_score: 10, description: 'Clear and comprehensive' }] }] },
            },
          }],
        };
      }
      if (sql.includes('FROM qa_turn WHERE interview_id')) {
        return {
          rows: [{
            qa_turn_id: 1, interview_id: params[0], assigned_question_id: 1, sequence_no: 1,
            turn_type: 'MAIN', question_text: 'Explain Encapsulation in OOP.',
            answer_text: 'Encapsulation is data hiding where fields are kept private and accessed via public getters and setters.',
            status: 'ANSWERED',
          }],
        };
      }
      return { rows: [] };
    },
    async withTransaction(fn) { return fn(this); },
  };
}

function createRepo(db, overrides = {}) {
  let resultRecord = {
    viva_result_id: 1, interview_id: 100, status: 'PENDING', ...(overrides.result || {}),
  };
  const stages = [];
  return {
    stages,
    async findByInterviewId(id) { return resultRecord.interview_id === id ? resultRecord : null; },
    async findById(id) { return resultRecord.viva_result_id === id ? resultRecord : null; },
    async updateResult(id, fields) { resultRecord = { ...resultRecord, ...fields }; return resultRecord; },
    async updateGradingProgress(id, { stage, current = null, total = null }) {
      stages.push({ stage, current, total });
      resultRecord = {
        ...resultRecord,
        grading_stage: stage,
        grading_current: current,
        grading_total: total,
        grading_updated_at: new Date('2026-11-09T00:00:00.000Z'),
      };
      return resultRecord;
    },
    async publishAiGrading(resultId, evals, fields) { resultRecord = { ...resultRecord, ...fields }; return resultRecord; },
    async listBySession() { return [{ ...resultRecord }]; },
    async getFullResultDetail() {
      return {
        result: { ...resultRecord, exam_session_id: 10 },
        evaluations: [{
          question_evaluation_id: 1, assigned_question_id: 1, ai_score: 7, final_score: 7,
          criteria: [{ criterion_score_id: 1, criterion_id: 1, ai_score: 7, final_score: 7 }],
        }],
        scoreAdjustments: [],
      };
    },
    async isExaminerOrCreator() { return true; },
    getRecord() { return resultRecord; },
  };
}

function createRealtimeBus() {
  const events = [];
  return { events, publish(entity, payload) { events.push({ entity, payload }); } };
}

function validLlm() {
  return {
    async gradeQuestion() {
      return {
        criteria_evaluations: [{
          criterion_id: 1, ai_level_id: 10, ai_score: 8.5,
          evidence: [{ quote: 'Encapsulation is data hiding', key_point_index: 0, reference_quote: 'Data hiding' }],
        }],
        confidence: 0.9,
      };
    },
  };
}

test('gradeInterview writes the stage sequence PREPARING -> SCORING -> AGGREGATING -> AWAITING_REVIEW', async () => {
  const db = createDb();
  const repo = createRepo(db);
  const service = new GradingService({
    db, vivaResultRepository: repo, llmAdapter: validLlm(), enqueueJob: async () => {}, logger: { info() {}, warn() {}, error() {} },
  });

  const result = await service.gradeInterview({ interviewId: 100 });
  assert.equal(result.status, 'AI_SUGGESTED');
  assert.deepEqual(repo.stages.map(s => s.stage), ['PREPARING', 'SCORING', 'AGGREGATING', 'AWAITING_REVIEW']);
  assert.deepEqual(repo.stages[1], { stage: 'SCORING', current: 1, total: 1 });
});

test('markGradingFailed sets FLAGGED + GRADING_FAILED + FAILED and publishes progress without studentUserId', async () => {
  const db = createDb();
  const repo = createRepo(db);
  const bus = createRealtimeBus();
  const service = new GradingService({
    db, vivaResultRepository: repo, llmAdapter: validLlm(), enqueueJob: async () => {},
    realtimeBus: bus, logger: { info() {}, warn() {}, error() {} },
  });

  const updated = await service.markGradingFailed({ interviewId: 100 });
  assert.equal(updated.status, 'FLAGGED');
  assert.equal(updated.grading_review_reason, 'GRADING_FAILED');
  assert.equal(updated.grading_stage, 'FAILED');

  const progressEvent = bus.events.find(e => e.entity === 'result' && e.payload.action === 'grading_progress');
  assert.ok(progressEvent);
  assert.equal(progressEvent.payload.status, 'FLAGGED');
  assert.equal(progressEvent.payload.resultId, 1);
  assert.equal(progressEvent.payload.examSessionId, 10);
  assert.equal('studentUserId' in progressEvent.payload, false);
});

test('markGradingRetrying writes the RETRYING stage', async () => {
  const db = createDb();
  const repo = createRepo(db);
  const service = new GradingService({
    db, vivaResultRepository: repo, llmAdapter: validLlm(), enqueueJob: async () => {}, logger: { info() {}, warn() {}, error() {} },
  });

  await service.markGradingRetrying({ interviewId: 100 });
  assert.equal(repo.getRecord().grading_stage, 'RETRYING');
  assert.equal(repo.stages.at(-1).stage, 'RETRYING');
});

test('GRADE_INTERVIEW handler marks FLAGGED/FAILED on the last attempt and rethrows', async () => {
  const calls = { failed: [], retrying: [] };
  const gradingService = {
    async gradeInterview() { throw new Error('boom'); },
    async markGradingFailed(args) { calls.failed.push(args); },
    async markGradingRetrying(args) { calls.retrying.push(args); },
  };
  const handler = makeGradeInterviewHandler(gradingService, { info() {}, warn() {}, error() {} }, { jobMaxAttempts: 3 });
  const job = { background_job_id: 1, payload: { interviewId: '100' }, max_attempts: 3, attempts: 3 };

  await assert.rejects(handler(job), /boom/);
  assert.equal(calls.failed.length, 1);
  assert.equal(calls.failed[0].interviewId, 100);
  assert.equal(calls.retrying.length, 0);
});

test('GRADE_INTERVIEW handler marks RETRYING on an earlier attempt and rethrows', async () => {
  const calls = { failed: [], retrying: [] };
  const gradingService = {
    async gradeInterview() { throw new Error('boom'); },
    async markGradingFailed(args) { calls.failed.push(args); },
    async markGradingRetrying(args) { calls.retrying.push(args); },
  };
  const handler = makeGradeInterviewHandler(gradingService, { info() {}, warn() {}, error() {} }, { jobMaxAttempts: 3 });
  const job = { background_job_id: 1, payload: { interviewId: '100' }, max_attempts: 3, attempts: 2 };

  await assert.rejects(handler(job), /boom/);
  assert.equal(calls.retrying.length, 1);
  assert.equal(calls.retrying[0].interviewId, 100);
  assert.equal(calls.failed.length, 0);
});

test('examiner payload hides scores but exposes progress while PENDING/AI_SCORING', async () => {
  for (const status of ['PENDING', 'AI_SCORING']) {
    const db = createDb();
    const repo = createRepo(db, {
      result: {
        status, ai_total_score: 7, final_total_score: 7,
        grading_stage: status === 'PENDING' ? 'QUEUED' : 'SCORING',
        grading_current: status === 'PENDING' ? null : 2,
        grading_total: status === 'PENDING' ? null : 5,
        grading_updated_at: new Date('2026-11-09T00:00:00.000Z'),
      },
    });
    const service = new GradingService({ db, vivaResultRepository: repo, llmAdapter: validLlm(), enqueueJob: async () => {} });
    const admin = { id: 1, role: 'ADMIN' };

    const list = await service.listSessionResults({ examSessionId: 10, user: admin });
    assert.equal(list[0].ai_total_score, null);
    assert.equal(list[0].final_total_score, null);
    assert.equal(list[0].flag_reason ?? null, null);
    assert.equal(list[0].progress.stage, status === 'PENDING' ? 'QUEUED' : 'SCORING');

    const detail = await service.getResultDetail({ resultId: 1, user: admin });
    assert.equal(detail.result.ai_total_score, null);
    assert.equal(detail.result.final_total_score, null);
    assert.equal(detail.result.progress.stage, status === 'PENDING' ? 'QUEUED' : 'SCORING');
    assert.equal(detail.evaluations[0].ai_score, null);
    assert.equal(detail.evaluations[0].criteria[0].ai_score, null);
  }
});

test('student result view never includes progress or grading columns', () => {
  const view = toStudentResultView({
    result: {
      viva_result_id: 1, exam_session_id: 10, session_title: 'Java OOP Exam',
      subject_code: 'SWD392', subject_name: 'Software Design', topic_name: 'OOP',
      finalized_at: new Date('2026-11-09T00:00:00.000Z'),
      final_total_score: 8, ai_total_score: 8,
      grading_stage: 'AWAITING_REVIEW', grading_current: 1, grading_total: 1,
      progress: { stage: 'AWAITING_REVIEW', current: 1, total: 1 },
    },
    evaluations: [],
  });

  assert.ok(view);
  assert.equal('progress' in view, false);
  assert.equal('grading_stage' in view, false);
  assert.equal('grading_current' in view, false);
  assert.equal('grading_total' in view, false);
  assert.equal(view.totalScore, 8);
});
