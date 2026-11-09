const { validateCriterionEvidence } = require('../domain/gradingEvidence');
const { readKnowledgeSnapshot } = require('../interview/knowledgeSnapshot');
// GradingService: Coordinates automated AI scoring via Bedrock Nova Pro and lecturer review.
//
// Rules from docs/e2e-plan-management.md (Section 4):
// - Auto-grading on interview completion (GRADE_INTERVIEW).
// - Calls Nova Pro tool use for each main question against rubric criteria and performance levels.
// - Weighted scoring normalized to 10-point scale, rounded to 1 decimal place.
// - FLAGGED on low confidence (<0.6), turn failures, or LLM schema errors.
// - Lecturer adjustments strictly require a reason.
// - Subject-scoped access for lecturers.
// - Examiner-only / creator-only write permissions (Step 13: F10).

const {
  calculateQuestionScore,
  calculateVivaTotalScore,
  detectFlagReason,
  assertValidScoreAdjustment,
  isUnansweredQuestion,
} = require('../domain/scoringRules');

const NO_ANSWER_MODEL_ID = 'rule:no-answer';

const NO_ANSWER_TEXT = {
  VI: {
    weaknesses: 'Sinh viên không trả lời câu hỏi này.',
    feedback: 'Không có câu trả lời (im lặng hoặc bản ghi rỗng). Hệ thống tự chấm 0 điểm, không dùng AI.',
    justification: 'Không có câu trả lời: 0 điểm.',
  },
  EN: {
    weaknesses: 'The student did not answer this question.',
    feedback: 'No answer was given (silence or empty transcript). Scored 0 automatically, without AI.',
    justification: 'No answer given: 0 points.',
  },
};

function noAnswerEvaluation(assignedQuestion, criteria, language, knowledge) {
  const text = NO_ANSWER_TEXT[String(language || '').toUpperCase()] || NO_ANSWER_TEXT.EN;
  // Key points come from the immutable knowledge snapshot taken at start.
  const keyPoints = Array.isArray(knowledge?.key_points) ? knowledge.key_points : [];
  return {
    assigned_question_id: assignedQuestion.assigned_question_id,
    ai_score: 0,
    final_score: 0,
    confidence: 1,
    strengths: '',
    weaknesses: text.weaknesses,
    missing_points: keyPoints,
    feedback: text.feedback,
    flag_reason: null,
    model_id: NO_ANSWER_MODEL_ID,
    prompt_version: '1.0',
    criteria: criteria.map((c) => ({
      criterion_id: c.rubric_criterion_id,
      ai_level_id: null,
      ai_score: 0,
      ai_justification: text.justification,
      evidence: [],
      final_score: 0,
    })),
  };
}
const { missingCriterionIds } = require('../llm/gradingPrompt');

function notFound(message = 'Resource not found') {
  const err = new Error(message);
  err.statusCode = 404;
  err.code = 'NOT_FOUND';
  return err;
}

function forbidden(message = 'Forbidden') {
  const err = new Error(message);
  err.statusCode = 403;
  err.code = 'FORBIDDEN';
  return err;
}

function badRequest(message = 'Bad request', code = 'VALIDATION_ERROR') {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Examiner-facing progress DTO. Null when grading has not started (e.g. rows
// created before the durable progress columns existed). Never carries scores.
function toProgress(row) {
  if (!row || row.grading_stage == null) return null;
  return {
    stage: row.grading_stage,
    current: row.grading_current != null ? Number(row.grading_current) : null,
    total: row.grading_total != null ? Number(row.grading_total) : null,
    updatedAt: toIso(row.grading_updated_at),
  };
}

class GradingService {
  constructor({
    db,
    vivaResultRepository,
    llmAdapter,
    enqueueJob,
    realtimeBus = null,
    logger = console,
  }) {
    this.realtimeBus = realtimeBus;
    this.db = db;
    this.vivaResultRepo = vivaResultRepository;
    this.llmAdapter = llmAdapter;
    this.enqueueJob = enqueueJob;
    this.logger = logger;
  }

  /**
   * Main background job execution for GRADE_INTERVIEW.
   */
  async gradeInterview({ interviewId }) {
    this.logger.info(`[GradingService] Starting AI grading for interview ${interviewId}`);

    // Find or ensure viva_result row
    let vivaResult = await this.vivaResultRepo.findByInterviewId(interviewId);
    // Queued retries must never overwrite a lecturer's finalized result.
    if (vivaResult?.status === 'FINALIZED') return vivaResult;
    if (!vivaResult) {
      const initRes = await this.db.query(
        'INSERT INTO viva_result (interview_id, status) VALUES ($1, $2) RETURNING *',
        [interviewId, 'AI_SCORING']
      );
      vivaResult = initRes.rows[0];
    } else {
      await this.vivaResultRepo.updateResult(vivaResult.viva_result_id, { status: 'AI_SCORING' });
    }
    await this._publishResult({ ...vivaResult, interview_id: interviewId }, 'status_changed', 'AI_SCORING');
    await this._setGradingProgress({ ...vivaResult, interview_id: interviewId }, { stage: 'PREPARING', status: 'AI_SCORING' });

    // Load interview, exam session, and language
    const ivRes = await this.db.query(
      `SELECT vi.*, es.language AS exam_language, es.title AS session_title
       FROM viva_interview vi
       JOIN exam_session es ON es.exam_session_id = vi.exam_session_id
       WHERE vi.viva_interview_id = $1`,
      [interviewId]
    );
    const interview = ivRes.rows[0];
    if (!interview) {
      throw notFound(`Interview ${interviewId} not found for grading`);
    }

    // Load assigned questions
    const aqRes = await this.db.query(
      `SELECT aq.*
       FROM assigned_question aq
       WHERE aq.interview_id = $1
       ORDER BY aq.order_no ASC`,
      [interviewId]
    );
    const assignedQuestions = aqRes.rows;
    // Missing historical knowledge is terminal content uncertainty, not an LLM
    // retry. Preserve original turns/evaluations and route to specialist review.
    try {
      if (!assignedQuestions.length) readKnowledgeSnapshot(null);
      assignedQuestions.forEach(readKnowledgeSnapshot);
    } catch (error) {
      if (error.code !== 'KNOWLEDGE_SNAPSHOT_MISSING') throw error;
      const adjustments = await this.db.query(
        `SELECT 1 FROM score_adjustment sa
         JOIN criterion_score cs ON cs.criterion_score_id = sa.criterion_score_id
         JOIN question_evaluation qe ON qe.question_evaluation_id = cs.evaluation_id
         WHERE qe.result_id = $1 LIMIT 1`, [vivaResult.viva_result_id],
      );
      const humanReviewed = vivaResult.finalized_by != null || adjustments.rows.length > 0;
      const flagged = await this.vivaResultRepo.updateResult(vivaResult.viva_result_id, {
        status: 'FLAGGED', ai_total_score: null,
        ...(!humanReviewed ? { final_total_score: null } : {}),
        grading_review_reason: 'KNOWLEDGE_SNAPSHOT_MISSING: Original approved knowledge unavailable; manual review required.',
      });
      await this._setGradingProgress({ ...vivaResult, ...flagged, interview_id: interviewId }, { stage: 'AWAITING_REVIEW', status: 'FLAGGED' });
      await this._publishResult({ ...vivaResult, interview_id: interviewId }, 'status_changed', 'FLAGGED');
      return flagged;
    }


    // Load all turns
    const turnsRes = await this.db.query(
      `SELECT * FROM qa_turn WHERE interview_id = $1 ORDER BY sequence_no ASC`,
      [interviewId]
    );
    const allTurns = turnsRes.rows;

    const evaluationsToSave = [];
    const questionScores = [];
    let llmFailed = false;

    for (const aq of assignedQuestions) {
      await this._setGradingProgress({ ...vivaResult, interview_id: interviewId }, {
        stage: 'SCORING',
        current: assignedQuestions.indexOf(aq) + 1,
        total: assignedQuestions.length,
        status: 'AI_SCORING',
      });
      const qTurns = allTurns.filter((t) => t.assigned_question_id === aq.assigned_question_id);
      const history = qTurns.map((t) => ({
        turnType: t.turn_type,
        questionText: t.question_text,
        answerText: t.answer_text,
        status: t.status,
      }));

      const knowledge = readKnowledgeSnapshot(aq);
      const criteria = knowledge.rubric_snapshot.criteria.map(c => ({ ...c, max_score: knowledge.rubric_snapshot.max_score }));

      // No answer at all (silence, empty transcript, only filler sounds, or
      // never asked before the deadline): 0 points, no LLM call. The model
      // otherwise "reads" the reference answer and hands out partial credit.
      if (isUnansweredQuestion(qTurns)) {
        questionScores.push(0);
        evaluationsToSave.push(noAnswerEvaluation(aq, criteria, interview.exam_language, knowledge));
        continue;
      }

      let aiGradingResult = null;
      try {
        aiGradingResult = await this.llmAdapter.gradeQuestion({
          language: interview.exam_language || 'EN',
          mainQuestion: {
            content: knowledge.content,
            bloom_level: knowledge.bloom_level,
            reference_answer: knowledge.reference_answer,
            key_points: knowledge.key_points,
          },
          history,
          rubricCriteria: criteria,
        });
      } catch (err) {
        this.logger.error({ err }, `[GradingService] LLM grading call failed for question ${aq.assigned_question_id}`);
        const name = err && (err.name || err.code);
        const isTransient = [
          'ModelErrorException',
          'ThrottlingException',
          'ServiceUnavailableException',
          'ModelTimeoutException',
          'InternalServerException',
          'ECONNRESET',
          'ETIMEDOUT',
          'ECONNREFUSED',
          'EAI_AGAIN',
          'UND_ERR_CONNECT_TIMEOUT',
        ].includes(name) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err.code);
        if (isTransient) {
          throw err;
        }
        llmFailed = true;
      }

      if (aiGradingResult && Array.isArray(aiGradingResult.criteria_evaluations)) {
        // Model output is untrusted: it may name a criterion or performance
        // level that does not belong to this rubric. Never persist such IDs.
        const byCriterion = new Map(criteria.map((criterion) => [
          Number(criterion.rubric_criterion_id), criterion,
        ]));
        const issues = typeof aiGradingResult.confidence === 'number' && Number.isFinite(aiGradingResult.confidence)
          && aiGradingResult.confidence >= 0 && aiGradingResult.confidence <= 1 ? [] : ['INVALID_CONFIDENCE'];
        const seen = new Set();
        const safeEvaluations = aiGradingResult.criteria_evaluations.flatMap((item) => {
          const criterionId = Number(item?.criterion_id);
          const criterion = byCriterion.get(criterionId);
          if (!criterion || seen.has(criterionId)) {
            issues.push('UNKNOWN_OR_DUPLICATE_CRITERION');
            return [];
          }
          seen.add(criterionId);
          const checked = validateCriterionEvidence(item, { knowledge, history, criterion });
          issues.push(...checked.reasons.map(reason => `${criterionId}:${reason}`));
          const supportedIndices = [...new Set(checked.valid.map(e => e.key_point_index))].join(', ');
          let justification = 'Evidence or score could not be verified; lecturer review required';
          if (!checked.reasons.length) {
            justification = `Transcript evidence supports approved key point indices: ${supportedIndices}`;
            // Unverifiable items are dropped rather than voiding the score, but
            // say so explicitly so a lecturer can see what was ignored.
            if (checked.droppedCount > 0) {
              justification += `; ${checked.droppedCount} unverifiable evidence item(s) ignored (${checked.dropped.join(', ')})`;
            }
          }
          return [{ criterion_id: criterionId, ai_level_id: checked.levelId,
            ai_score: checked.score, evidence: checked.valid,
            // Do not persist free-form model claims as verified conclusions.
            ai_justification: justification,
          }];
        });
        const missing = missingCriterionIds({ criteria_evaluations: safeEvaluations }, criteria);
        if (missing.length) issues.push(`MISSING_CRITERIA:${missing.join(',')}`);
        const qScore = issues.length ? null : calculateQuestionScore(safeEvaluations, criteria);
        if (qScore != null) questionScores.push(qScore);
        const supported = new Set(safeEvaluations.filter(e => e.ai_score != null).flatMap(e => e.evidence.map(proof => proof.key_point_index)));

        evaluationsToSave.push({
          assigned_question_id: aq.assigned_question_id,
          ai_score: qScore,
          final_score: qScore,
          confidence: aiGradingResult.confidence ?? 0.85,
          strengths: knowledge.key_points.filter((_point, index) => supported.has(index)).join('; '),
          weaknesses: '',
          missing_points: knowledge.key_points.filter((_point, index) => !supported.has(index)),
          feedback: issues.length ? 'Unverified grading evidence; lecturer review required.' : 'Evidence-grounded AI suggestion; lecturer approval required.',
          flag_reason: issues.length ? `GRADING_EVIDENCE_INVALID: ${[...new Set(issues)].join('; ')}` : null,
          model_id: 'apac.amazon.nova-pro-v1:0',
          prompt_version: '2.0',
          criteria: [
            ...safeEvaluations.map((ce) => ({
              criterion_id: ce.criterion_id,
              ai_level_id: ce.ai_level_id,
              ai_score: ce.ai_score,
              ai_justification: ce.ai_justification,
              evidence: ce.evidence || [],
              final_score: ce.ai_score,
            })),
            ...missing.map((criterionId) => ({
              criterion_id: criterionId,
              ai_level_id: null,
              ai_score: null,
              ai_justification: 'Not graded by AI; manual grading required',
              evidence: [],
              final_score: null,
            })),
          ],
        });
      } else {
        // Fallback for LLM failure
        evaluationsToSave.push({
          assigned_question_id: aq.assigned_question_id,
          ai_score: null,
          final_score: null,
          confidence: 0,
          strengths: '',
          weaknesses: '',
          missing_points: [],
          feedback: 'AI scoring unavailable; manual grading required.',
          flag_reason: 'AI grading service failure',
          model_id: 'apac.amazon.nova-pro-v1:0',
          prompt_version: '2.0',
          criteria: criteria.map((c) => ({
            criterion_id: c.rubric_criterion_id,
            ai_level_id: null,
            ai_score: null,
            ai_justification: 'Manual grading required',
            evidence: [],
            final_score: null,
          })),
        });
      }
    }

    // Compute viva total score and check flagging
    const incomplete = evaluationsToSave.some(e => e.ai_score == null);
    const vivaTotal = incomplete ? null : calculateVivaTotalScore(questionScores);
    const flagCheck = detectFlagReason({
      questionEvaluations: evaluationsToSave,
      turns: allTurns,
      llmFailed,
    });

    const nextStatus = flagCheck.isFlagged ? 'FLAGGED' : 'AI_SUGGESTED';

    await this._setGradingProgress({ ...vivaResult, interview_id: interviewId }, { stage: 'AGGREGATING', status: 'AI_SCORING' });

    const updated = await this.vivaResultRepo.publishAiGrading(vivaResult.viva_result_id, evaluationsToSave, {
      status: nextStatus,
      grading_review_reason: null,
      ai_total_score: vivaTotal,
      final_total_score: vivaTotal,
    });

    this.logger.info(
      `[GradingService] Interview ${interviewId} graded: status=${nextStatus}, totalScore=${vivaTotal}`
    );
    await this._publishResult({ ...vivaResult, interview_id: interviewId }, 'status_changed', nextStatus);
    await this._setGradingProgress({ ...vivaResult, ...updated, interview_id: interviewId }, { stage: 'AWAITING_REVIEW', status: nextStatus });

    return updated;
  }

  /**
   * List all exam results for a given session with subject scoping.
   * Includes canGrade boolean flag for the requesting user.
   */
  async listSessionResults({ examSessionId, user }) {
    await this._assertSessionAccess(examSessionId, user, { write: false });
    const canGrade = user.role === 'ADMIN'
      || (typeof this.vivaResultRepo.isExaminerOrCreator === 'function'
        ? await this.vivaResultRepo.isExaminerOrCreator(examSessionId, user.id)
        : false);

    const rows = await this.vivaResultRepo.listBySession(examSessionId);
    return rows.map((r) => {
      const scoring = r.status === 'AI_SCORING' || r.status === 'PENDING';
      return {
        ...r,
        ...(scoring ? { ai_total_score: null, final_total_score: null, flag_reason: null } : {}),
        progress: toProgress(r),
        canGrade: Boolean(canGrade),
      };
    });
  }

  /**
   * Get complete result details for lecturer review with subject scoping.
   * Includes canGrade boolean flag for the requesting user.
   */
  async getResultDetail({ resultId, user }) {
    const detail = await this.vivaResultRepo.getFullResultDetail(resultId);
    if (!detail) {
      throw notFound(`Viva result ${resultId} not found`);
    }
    await this._assertSessionAccess(detail.result.exam_session_id, user, { write: false });
    const canGrade = user.role === 'ADMIN'
      || (typeof this.vivaResultRepo.isExaminerOrCreator === 'function'
        ? await this.vivaResultRepo.isExaminerOrCreator(detail.result.exam_session_id, user.id)
        : false);

    const scoring = detail.result.status === 'AI_SCORING' || detail.result.status === 'PENDING';
    return {
      ...detail,
      ...(scoring ? {
        scoreAdjustments: [],
        evaluations: detail.evaluations.map(e => ({ ...e, ai_score: null, final_score: null,
          confidence: null, strengths: '', weaknesses: '', missing_points: [], feedback: '', flag_reason: null,
          criteria: (e.criteria || []).map(c => ({ ...c, ai_score: null, final_score: null,
            ai_justification: '', evidence: [], ai_level_id: null, level_label: null, level_description: null })),
        })),
      } : {}),
      canGrade: Boolean(canGrade),
      result: {
        ...detail.result,
        ...(scoring ? { ai_total_score: null, final_total_score: null, grading_review_reason: null } : {}),
        progress: toProgress(detail.result),
        canGrade: Boolean(canGrade),
      },
    };
  }

  /**
   * Adjust score for a specific criterion with mandatory reason.
   * Strictly restricted to ADMIN, examiners of this exam, or the exam creator.
   */
  async adjustCriterionScore({ criterionScoreId, newScore, reason, user }) {
    const cs = await this.vivaResultRepo.findCriterionScoreById(criterionScoreId);
    if (!cs) {
      throw notFound(`Criterion score ${criterionScoreId} not found`);
    }

    const detail = await this.vivaResultRepo.getFullResultDetail(cs.result_id);
    if (!detail) {
      throw notFound(`Associated viva result not found`);
    }
    await this._assertSessionAccess(detail.result.exam_session_id, user, { write: true });

    if (detail.result.status === 'AI_SCORING') throw badRequest('Wait until grading completes.', 'GRADING_IN_PROGRESS');

    if (detail.result.status === 'FINALIZED') {
      throw badRequest('Cannot adjust scores on a finalized result. Please reopen it first.', 'RESULT_FINALIZED');
    }

    const oldScore = cs.final_score !== null ? Number(cs.final_score) : Number(cs.ai_score);
    assertValidScoreAdjustment({ oldScore, newScore: Number(newScore), reason });

    // Record adjustment history
    await this.vivaResultRepo.insertScoreAdjustment({
      criterionScoreId,
      oldScore,
      newScore: Number(newScore),
      reason: String(reason).trim(),
      adjustedBy: user.id,
    });

    // Update criterion score
    await this.vivaResultRepo.updateCriterionScore(criterionScoreId, {
      finalScore: Number(newScore),
    });

    // Recompute evaluation score
    // Ids come back from Postgres as strings (BIGINT) while the route parses a
    // number, and criterion rows carry the rubric weight/max as
    // criterion_weight / criterion_max_score: normalise both before scoring.
    const evaluationId = Number(cs.question_evaluation_id ?? cs.evaluation_id);
    const ev = detail.evaluations.find((e) => Number(e.question_evaluation_id) === evaluationId);
    if (ev && Array.isArray(ev.criteria)) {
      const updatedCriteria = ev.criteria.map((c) => (
        Number(c.criterion_score_id) === Number(criterionScoreId) ? { ...c, final_score: Number(newScore) } : c
      ));
      const newQuestionScore = calculateQuestionScore(
        updatedCriteria.map((c) => ({ criterion_id: c.criterion_id, score: c.final_score ?? c.ai_score })),
        updatedCriteria.map((c) => ({
          criterion_id: c.criterion_id,
          weight: c.criterion_weight ?? c.weight,
          max_score: c.criterion_max_score ?? c.max_score,
        })),
      );
      await this.vivaResultRepo.updateEvaluationScore(evaluationId, {
        finalScore: newQuestionScore,
      });
    }

    // Recompute viva total score
    const refreshed = await this.vivaResultRepo.getFullResultDetail(cs.result_id);
    const newTotal = calculateVivaTotalScore(
      refreshed.evaluations.map((e) => e.final_score)
    );
    await this.vivaResultRepo.updateResult(cs.result_id, {
      final_total_score: newTotal,
    });

    const adjusted = await this.vivaResultRepo.getFullResultDetail(cs.result_id);
    await this._publishResult(adjusted?.result || detail.result, 'updated', adjusted?.result?.status);
    return adjusted;
  }

  /**
   * Lecturer finalizes the viva exam result.
   * Strictly restricted to ADMIN, examiners of this exam, or the exam creator.
   */
  async finalizeResult({ resultId, user }) {
    const detail = await this.vivaResultRepo.getFullResultDetail(resultId);
    if (!detail) throw notFound(`Viva result ${resultId} not found`);
    await this._assertSessionAccess(detail.result.exam_session_id, user, { write: true });

    if (detail.result.status === 'AI_SCORING') throw badRequest('Wait until grading completes.', 'GRADING_IN_PROGRESS');

    if (detail.result.status === 'FINALIZED') {
      throw badRequest('Result is already finalized.', 'ALREADY_FINALIZED');
    }

    const finalized = await this.vivaResultRepo.updateResult(resultId, {
      status: 'FINALIZED',
      finalized_by: user.id,
      finalized_at: new Date(),
    });
    await this._publishResult(detail.result, 'finalized', 'FINALIZED');
    return finalized;
  }

  /**
   * Lecturer re-opens a finalized result for adjustments.
   * Strictly restricted to ADMIN, examiners of this exam, or the exam creator.
   */
  async reopenResult({ resultId, user }) {
    const detail = await this.vivaResultRepo.getFullResultDetail(resultId);
    if (!detail) throw notFound(`Viva result ${resultId} not found`);
    await this._assertSessionAccess(detail.result.exam_session_id, user, { write: true });

    if (detail.result.status !== 'FINALIZED') {
      throw badRequest('Only finalized results can be reopened.', 'NOT_FINALIZED');
    }

    const hasFlag = detail.evaluations.some((e) => e.flag_reason);
    const targetStatus = hasFlag ? 'FLAGGED' : 'AI_SUGGESTED';

    const reopened = await this.vivaResultRepo.updateResult(resultId, {
      status: targetStatus,
      finalized_by: null,
      finalized_at: null,
    });
    await this._publishResult(detail.result, 'reopened', targetStatus);
    return reopened;
  }

  /**
   * Trigger a regrade of the interview.
   * Strictly restricted to ADMIN, examiners of this exam, or the exam creator.
   */
  async regradeResult({ resultId, user }) {
    const detail = await this.vivaResultRepo.getFullResultDetail(resultId);
    if (!detail) throw notFound(`Viva result ${resultId} not found`);
    await this._assertSessionAccess(detail.result.exam_session_id, user, { write: true });
    if (detail.result.status === 'FINALIZED') {
      throw badRequest('Reopen the finalized result before requesting a regrade.', 'RESULT_FINALIZED');
    }

    await this.vivaResultRepo.updateResult(resultId, {
      status: 'AI_SCORING',
      grading_stage: 'QUEUED',
      grading_current: null,
      grading_total: null,
      grading_updated_at: new Date(),
    });

    if (typeof this.enqueueJob === 'function') {
      await this.enqueueJob('GRADE_INTERVIEW', { interviewId: detail.result.interview_id });
    }

    await this._publishResult(detail.result, 'status_changed', 'AI_SCORING');
    await this._publishProgress({ ...detail.result, status: 'AI_SCORING' }, 'AI_SCORING');
    return { ok: true, status: 'AI_SCORING' };
  }

  // Invalidation only, after the write succeeded. Resolves the owning student
  // and subject (routing-only fields) and never throws.
  async _publishResult(result, action, status) {
    if (!this.realtimeBus || !result) return;
    try {
      let { exam_session_id: examSessionId, student_id: studentId, subject_id: subjectId } = result;
      if (examSessionId == null || studentId == null) {
        const r = await this.db.query(
          `SELECT vi.exam_session_id, vi.student_id, es.subject_id
           FROM viva_interview vi JOIN exam_session es ON es.exam_session_id = vi.exam_session_id
           WHERE vi.viva_interview_id = $1`,
          [result.interview_id],
        );
        ({ exam_session_id: examSessionId, student_id: studentId, subject_id: subjectId } = r.rows[0] || {});
      }
      this.realtimeBus.publish('result', {
        action,
        resultId: result.viva_result_id,
        interviewId: result.interview_id,
        examSessionId,
        subjectId: subjectId ?? null,
        status: status || result.status,
        studentUserId: studentId == null ? null : Number(studentId),
      });
    } catch (err) {
      this.logger?.warn?.({ err }, 'result realtime publish failed');
    }
  }

  // Durable stage write + realtime progress event. Best-effort: a failed
  // progress write must never fail (or retry) the grading job itself.
  async _setGradingProgress(result, { stage, current = null, total = null, status }) {
    if (!result || !result.viva_result_id) return;
    if (typeof this.vivaResultRepo?.updateGradingProgress !== 'function') return;
    try {
      await this.vivaResultRepo.updateGradingProgress(result.viva_result_id, { stage, current, total });
      await this._publishProgress(result, status ?? result.status);
    } catch (err) {
      this.logger?.warn?.({ err, resultId: result.viva_result_id, stage }, 'grading progress write failed');
    }
  }

  // Realtime invalidation for authorized lecturers/admins only. Deliberately
  // omits studentUserId so businessSocket never routes progress to the student.
  async _publishProgress(result, status) {
    if (!this.realtimeBus || !result) return;
    try {
      let { exam_session_id: examSessionId, subject_id: subjectId } = result;
      if (examSessionId == null) {
        const r = await this.db.query(
          `SELECT vi.exam_session_id, es.subject_id
           FROM viva_interview vi JOIN exam_session es ON es.exam_session_id = vi.exam_session_id
           WHERE vi.viva_interview_id = $1`,
          [result.interview_id],
        );
        ({ exam_session_id: examSessionId, subject_id: subjectId } = r.rows[0] || {});
      }
      this.realtimeBus.publish('result', {
        action: 'grading_progress',
        resultId: result.viva_result_id,
        interviewId: result.interview_id,
        examSessionId: examSessionId ?? null,
        subjectId: subjectId ?? null,
        status: status || result.status,
      });
    } catch (err) {
      this.logger?.warn?.({ err }, 'grading progress realtime publish failed');
    }
  }

  // Terminal failure marker for the queue's last attempt: FLAGGED +
  // GRADING_FAILED + stage FAILED so a result never stays AI_SCORING forever.
  async markGradingFailed({ interviewId }) {
    const vivaResult = await this.vivaResultRepo.findByInterviewId(interviewId);
    if (!vivaResult) return null;
    if (vivaResult.status === 'FINALIZED') return vivaResult;
    const updated = await this.vivaResultRepo.updateResult(vivaResult.viva_result_id, {
      status: 'FLAGGED',
      grading_review_reason: 'GRADING_FAILED',
      grading_stage: 'FAILED',
      grading_current: null,
      grading_total: null,
      grading_updated_at: new Date(),
    });
    const next = { ...vivaResult, ...updated, interview_id: interviewId };
    await this._publishProgress(next, 'FLAGGED');
    await this._publishResult(next, 'status_changed', 'FLAGGED');
    return updated;
  }

  // Transient-failure marker set by the handler when the queue will retry.
  async markGradingRetrying({ interviewId }) {
    const vivaResult = await this.vivaResultRepo.findByInterviewId(interviewId);
    if (!vivaResult) return null;
    if (vivaResult.status === 'FINALIZED') return vivaResult;
    if (typeof this.vivaResultRepo?.updateGradingProgress !== 'function') return vivaResult;
    try {
      await this.vivaResultRepo.updateGradingProgress(vivaResult.viva_result_id, { stage: 'RETRYING' });
      await this._publishProgress({ ...vivaResult, interview_id: interviewId }, 'AI_SCORING');
    } catch (err) {
      this.logger?.warn?.({ err, resultId: vivaResult.viva_result_id }, 'grading RETRYING write failed');
    }
    return vivaResult;
  }

  /**
   * Resolve the stored audio key of a turn for playback. Same read scope as
   * the result detail: ADMIN, or a lecturer assigned to the exam's subject.
   */
  async getTurnAudioKey({ turnId, user }) {
    const tRes = await this.db.query(
      `SELECT qt.answer_audio_key, qt.question_audio_key, vi.exam_session_id
       FROM qa_turn qt
       JOIN viva_interview vi ON vi.viva_interview_id = qt.interview_id
       WHERE qt.qa_turn_id = $1
       LIMIT 1`,
      [turnId]
    );
    const turn = tRes.rows[0];
    if (!turn) throw notFound('Turn not found');
    await this._assertSessionAccess(turn.exam_session_id, user, { write: false });

    const key = turn.answer_audio_key || turn.question_audio_key;
    if (!key) throw notFound('No audio recording found for this turn');
    return key;
  }

  async _assertSessionAccess(examSessionId, user, { write = false } = {}) {
    if (user.role === 'ADMIN') return;
    const esRes = await this.db.query(
      `SELECT es.subject_id
       FROM exam_session es
       WHERE es.exam_session_id = $1`,
      [examSessionId]
    );
    const session = esRes.rows[0];
    if (!session) throw notFound(`Exam session ${examSessionId} not found`);

    const subRes = await this.db.query(
      `SELECT 1 FROM subject_lecturer WHERE subject_id = $1 AND lecturer_id = $2`,
      [session.subject_id, user.id]
    );
    if (subRes.rows.length === 0) {
      throw forbidden('You are not authorized to access results for this subject.');
    }

    if (write) {
      const allowed = typeof this.vivaResultRepo.isExaminerOrCreator === 'function'
        ? await this.vivaResultRepo.isExaminerOrCreator(examSessionId, user.id)
        : false;
      if (!allowed) {
        throw forbidden('Only examiners of this exam can grade.');
      }
    }
  }
}

module.exports = {
  GradingService,
};
