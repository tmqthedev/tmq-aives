// Data access layer for viva_result, question_evaluation, criterion_score,
// and score_adjustment (Step 8: AI Grading & Lecturer Review).

class VivaResultRepository {
  constructor(options = {}) {
    this.db = options && options.db ? options.db : options;
  }

  async findByInterviewId(interviewId, tx) {
    const db = tx || this.db;
    const res = await db.query(
      'SELECT * FROM viva_result WHERE interview_id = $1 LIMIT 1',
      [interviewId]
    );
    return res.rows[0] || null;
  }

  async createPendingIfAbsent(interviewId, tx) {
    const db = tx || this.db;
    const query = `
      INSERT INTO viva_result (interview_id, status, grading_stage, grading_updated_at)
      VALUES ($1, 'PENDING', 'QUEUED', now())
      ON CONFLICT (interview_id) DO UPDATE SET interview_id = EXCLUDED.interview_id
      RETURNING *
    `;
    const res = await db.query(query, [interviewId]);
    return res.rows[0];
  }

  async findById(vivaResultId) {
    const res = await this.db.query(
      'SELECT * FROM viva_result WHERE viva_result_id = $1 LIMIT 1',
      [vivaResultId]
    );
    return res.rows[0] || null;
  }

  async listBySession(examSessionId) {
    const query = `
      SELECT vr.viva_result_id, vr.interview_id, vr.status, vr.ai_total_score, vr.final_total_score,
             vr.finalized_by, vr.finalized_at,
             vr.grading_stage, vr.grading_current, vr.grading_total, vr.grading_updated_at,
             vi.exam_session_id, vi.student_id, vi.started_at, vi.ended_at,
             u.full_name AS student_name, u.code AS student_code, u.email AS student_email,
             (SELECT qe.flag_reason FROM question_evaluation qe WHERE qe.result_id = vr.viva_result_id AND qe.flag_reason IS NOT NULL LIMIT 1) AS flag_reason
      FROM viva_result vr
      JOIN viva_interview vi ON vi.viva_interview_id = vr.interview_id
      JOIN app_user u ON u.app_user_id = vi.student_id
      WHERE vi.exam_session_id = $1
      ORDER BY vi.started_at DESC NULLS LAST
    `;
    const res = await this.db.query(query, [examSessionId]);
    return res.rows;
  }

  async updateResult(vivaResultId, fields = {}, client = this.db) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.findById(vivaResultId);

    const setClauses = [];
    const values = [];
    keys.forEach((key, idx) => {
      setClauses.push(`${key} = $${idx + 1}`);
      values.push(fields[key]);
    });
    values.push(vivaResultId);

    const query = `
      UPDATE viva_result
      SET ${setClauses.join(', ')}
      WHERE viva_result_id = $${values.length}
      RETURNING *
    `;
    const res = await client.query(query, values);
    return res.rows[0] || null;
  }

  async updateGradingProgress(vivaResultId, { stage, current = null, total = null }) {
    return this.updateResult(vivaResultId, {
      grading_stage: stage,
      grading_current: current,
      grading_total: total,
      grading_updated_at: new Date(),
    });
  }

  async saveEvaluationsAndCriteria(resultId, evaluations = [], transaction) {
    const save = async (client) => {
      // Clear previous evaluations if regrading
      await client.query('DELETE FROM question_evaluation WHERE result_id = $1', [resultId]);

      const savedEvals = [];
      for (const ev of evaluations) {
        const evalRes = await client.query(
          `INSERT INTO question_evaluation
             (result_id, assigned_question_id, ai_score, final_score, confidence,
              strengths, weaknesses, missing_points, feedback, flag_reason, model_id, prompt_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            resultId,
            ev.assigned_question_id || ev.assignedQuestionId,
            ev.ai_score,
            ev.final_score ?? ev.ai_score,
            ev.confidence,
            ev.strengths,
            ev.weaknesses,
            JSON.stringify(ev.missing_points || []),
            ev.feedback,
            ev.flag_reason || null,
            ev.model_id || 'apac.amazon.nova-pro-v1:0',
            ev.prompt_version || '1.0',
          ]
        );
        const savedEval = evalRes.rows[0];

        const savedCriteria = [];
        for (const cs of (ev.criteria || [])) {
          const critRes = await client.query(
            `INSERT INTO criterion_score
               (evaluation_id, criterion_id, ai_level_id, ai_score, ai_justification, evidence, final_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              savedEval.question_evaluation_id,
              cs.criterion_id,
              cs.ai_level_id || null,
              cs.ai_score,
              cs.ai_justification || '',
              JSON.stringify(cs.evidence || []),
              cs.final_score ?? cs.ai_score,
            ]
          );
          savedCriteria.push(critRes.rows[0]);
        }

        savedEval.criteria = savedCriteria;
        savedEvals.push(savedEval);
      }
      return savedEvals;
    };
    return transaction ? save(transaction) : this.db.withTransaction(save);
  }

  async publishAiGrading(resultId, evaluations, fields) {
    return this.db.withTransaction(async client => {
      const current = await client.query('SELECT * FROM viva_result WHERE viva_result_id = $1 FOR UPDATE', [resultId]);
      if (current.rows[0]?.status === 'FINALIZED') return current.rows[0];
      if (!current.rows[0]) throw new Error('Grading result disappeared before publication.');
      await this.saveEvaluationsAndCriteria(resultId, evaluations, client);
      return this.updateResult(resultId, fields, client);
    });
  }

  async findCriterionScoreById(criterionScoreId) {
    const query = `
      SELECT cs.*, qe.result_id, qe.assigned_question_id, qe.question_evaluation_id
      FROM criterion_score cs
      JOIN question_evaluation qe ON qe.question_evaluation_id = cs.evaluation_id
      WHERE cs.criterion_score_id = $1
      LIMIT 1
    `;
    const res = await this.db.query(query, [criterionScoreId]);
    return res.rows[0] || null;
  }

  async updateCriterionScore(criterionScoreId, { finalScore }) {
    const res = await this.db.query(
      `UPDATE criterion_score
       SET final_score = $1
       WHERE criterion_score_id = $2
       RETURNING *`,
      [finalScore, criterionScoreId]
    );
    return res.rows[0] || null;
  }

  async updateEvaluationScore(questionEvaluationId, { finalScore }) {
    const res = await this.db.query(
      `UPDATE question_evaluation
       SET final_score = $1
       WHERE question_evaluation_id = $2
       RETURNING *`,
      [finalScore, questionEvaluationId]
    );
    return res.rows[0] || null;
  }

  async insertScoreAdjustment({ criterionScoreId, oldScore, newScore, reason, adjustedBy }) {
    const res = await this.db.query(
      `INSERT INTO score_adjustment
         (criterion_score_id, old_score, new_score, reason, adjusted_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [criterionScoreId, oldScore, newScore, reason, adjustedBy]
    );
    return res.rows[0] || null;
  }

  async getFullResultDetail(vivaResultId) {
    const resultRes = await this.db.query(
      `SELECT vr.*,
              vi.exam_session_id, vi.student_id, vi.started_at, vi.ended_at, vi.status AS interview_status,
              u.full_name AS student_name, u.code AS student_code, u.email AS student_email,
              es.title AS session_title, es.subject_id, es.topic_id, es.language AS exam_language,
              s.name AS subject_name,
              t.name AS topic_name,
              examiner.full_name AS finalized_by_name
       FROM viva_result vr
       JOIN viva_interview vi ON vi.viva_interview_id = vr.interview_id
       JOIN app_user u ON u.app_user_id = vi.student_id
       JOIN exam_session es ON es.exam_session_id = vi.exam_session_id
       LEFT JOIN subject s ON s.subject_id = es.subject_id
       LEFT JOIN topic t ON t.topic_id = es.topic_id
       LEFT JOIN app_user examiner ON examiner.app_user_id = vr.finalized_by
       WHERE vr.viva_result_id = $1
       LIMIT 1`,
      [vivaResultId]
    );
    const result = resultRes.rows[0];
    if (!result) return null;

    // Load question evaluations
    const evalsRes = await this.db.query(
      `SELECT qe.*,
              aq.order_no, aq.question_id,
              aq.knowledge_snapshot, aq.legacy_prompt_source,
              COALESCE(aq.knowledge_snapshot->>'content', aq.legacy_question_text) AS question_content,
              aq.knowledge_snapshot->>'bloom_level' AS bloom_level,
              aq.knowledge_snapshot->>'reference_answer' AS reference_answer,
              aq.knowledge_snapshot->'key_points' AS key_points,
              aq.knowledge_snapshot->'rationale' AS question_rationale
       FROM question_evaluation qe
       LEFT JOIN assigned_question aq ON aq.assigned_question_id = qe.assigned_question_id
       WHERE qe.result_id = $1
       ORDER BY aq.order_no ASC NULLS LAST`,
      [vivaResultId]
    );
    const evaluations = evalsRes.rows;

    // Load criteria for each evaluation
    for (const ev of evaluations) {
      const critRes = await this.db.query(
        `SELECT cs.* FROM criterion_score cs
         WHERE cs.evaluation_id = $1 ORDER BY cs.criterion_score_id`,
        [ev.question_evaluation_id]
      );
      const snapshot = ev.knowledge_snapshot;
      const frozenCriteria = snapshot?.rubric_snapshot?.criteria || [];
      ev.criteria = critRes.rows.map(cs => {
        const criterion = frozenCriteria.find(c => Number(c.rubric_criterion_id) === Number(cs.criterion_id));
        const level = criterion?.performance_levels?.find(l => Number(l.performance_level_id) === Number(cs.ai_level_id));
        return { ...cs,
          criterion_name: criterion?.criterion_name ?? null,
          criterion_weight: criterion?.weight_percent ?? null,
          criterion_max_score: snapshot?.rubric_snapshot?.max_score ?? null,
          level_label: level?.label ?? null, level_description: level?.description ?? null,
        };
      });

      // Load turns for this assigned question
      const turnsRes = await this.db.query(
        `SELECT qt.*
         FROM qa_turn qt
         WHERE qt.interview_id = $1 AND qt.assigned_question_id = $2
         ORDER BY qt.sequence_no ASC`,
        [result.interview_id, ev.assigned_question_id]
      );
      // Examiner turn view: surface the student's STT dispute so the lecturer
      // knows to replay the turn audio. Raw columns stay, camelCase fields are
      // added for the grading UI.
      ev.turns = turnsRes.rows.map((turn) => ({
        ...turn,
        sttDisputed: turn.stt_disputed_at != null,
        sttDisputeNote: turn.stt_dispute_note ?? null,
        sttDisputedAt: turn.stt_disputed_at == null
          ? null
          : (turn.stt_disputed_at instanceof Date
            ? turn.stt_disputed_at.toISOString()
            : new Date(turn.stt_disputed_at).toISOString()),
      }));
    }

    // Load adjustments history
    const adjRes = await this.db.query(
      `SELECT sa.*, cs.criterion_id, qe.assigned_question_id, u.full_name AS adjusted_by_name
       FROM score_adjustment sa
       JOIN criterion_score cs ON cs.criterion_score_id = sa.criterion_score_id
       JOIN question_evaluation qe ON qe.question_evaluation_id = cs.evaluation_id
       LEFT JOIN app_user u ON u.app_user_id = sa.adjusted_by
       WHERE qe.result_id = $1
       ORDER BY sa.adjusted_at DESC`,
      [vivaResultId]
    );

    return {
      result,
      evaluations,
      scoreAdjustments: adjRes.rows.map(row => {
        const ev = evaluations.find(e => e.assigned_question_id === row.assigned_question_id);
        const criterion = ev?.knowledge_snapshot?.rubric_snapshot?.criteria?.find(c => Number(c.rubric_criterion_id) === Number(row.criterion_id));
        return { ...row, criterion_name: criterion?.criterion_name ?? null };
      }),
    };
  }

  async isExaminerOrCreator(examSessionId, userId, tx) {
    const db = tx || this.db;
    const query = `
      SELECT 1 FROM exam_session es
      WHERE es.exam_session_id = $1
        AND (
          es.created_by = $2
          OR EXISTS (
            SELECT 1 FROM exam_session_examiner ese
            WHERE ese.exam_session_id = es.exam_session_id AND ese.lecturer_id = $2
          )
        )
      LIMIT 1
    `;
    const res = await db.query(query, [examSessionId, userId]);
    return res.rows.length > 0;
  }

  async listFinalizedForStudent(studentId, tx) {
    const db = tx || this.db;
    const query = `
      SELECT vr.viva_result_id, vr.interview_id, vr.status, vr.ai_total_score, vr.final_total_score,
             vr.finalized_at,
             vi.exam_session_id, vi.student_id,
             es.title AS session_title,
             s.subject_id, s.code AS subject_code, s.name AS subject_name,
             t.topic_id, t.name AS topic_name
      FROM viva_result vr
      JOIN viva_interview vi ON vi.viva_interview_id = vr.interview_id
      JOIN exam_session es ON es.exam_session_id = vi.exam_session_id
      LEFT JOIN subject s ON s.subject_id = es.subject_id
      LEFT JOIN topic t ON t.topic_id = es.topic_id
      WHERE vi.student_id = $1
        AND vr.status = 'FINALIZED'
      ORDER BY vr.finalized_at DESC NULLS LAST, vr.viva_result_id DESC
    `;
    const res = await db.query(query, [studentId]);
    return res.rows;
  }

  async findFinalizedForStudent(vivaResultId, studentId, tx) {
    const db = tx || this.db;
    const resultRes = await db.query(
      `SELECT vr.viva_result_id, vr.interview_id, vr.status, vr.ai_total_score, vr.final_total_score,
              vr.finalized_at,
              vi.exam_session_id, vi.student_id,
              es.title AS session_title,
              s.subject_id, s.code AS subject_code, s.name AS subject_name,
              t.topic_id, t.name AS topic_name
       FROM viva_result vr
       JOIN viva_interview vi ON vi.viva_interview_id = vr.interview_id
       JOIN exam_session es ON es.exam_session_id = vi.exam_session_id
       LEFT JOIN subject s ON s.subject_id = es.subject_id
       LEFT JOIN topic t ON t.topic_id = es.topic_id
       WHERE vr.viva_result_id = $1
         AND vi.student_id = $2
         AND vr.status = 'FINALIZED'
       LIMIT 1`,
      [vivaResultId, studentId]
    );
    const result = resultRes.rows[0];
    if (!result) return null;

    // Load question evaluations
    const evalsRes = await db.query(
      `SELECT qe.question_evaluation_id, qe.ai_score, qe.final_score,
              aq.order_no, aq.knowledge_snapshot AS internal_snapshot,
              COALESCE(aq.knowledge_snapshot->>'content', aq.legacy_question_text) AS question_content
       FROM question_evaluation qe
       LEFT JOIN assigned_question aq ON aq.assigned_question_id = qe.assigned_question_id
       WHERE qe.result_id = $1
       ORDER BY aq.order_no ASC NULLS LAST`,
      [vivaResultId]
    );
    const evaluations = evalsRes.rows;

    for (const ev of evaluations) {
      const critRes = await db.query(
        `SELECT cs.criterion_score_id, cs.criterion_id, cs.ai_score, cs.final_score
         FROM criterion_score cs WHERE cs.evaluation_id = $1 ORDER BY cs.criterion_score_id`,
        [ev.question_evaluation_id]
      );
      const rubric = ev.internal_snapshot?.rubric_snapshot;
      ev.criteria = critRes.rows.map(cs => {
        const criterion = rubric?.criteria?.find(c => Number(c.rubric_criterion_id) === Number(cs.criterion_id));
        return { criterion_score_id: cs.criterion_score_id, ai_score: cs.ai_score, final_score: cs.final_score,
          criterion_name: criterion?.criterion_name ?? null,
          criterion_weight: criterion?.weight_percent ?? null, criterion_max_score: rubric?.max_score ?? null,
        };
      });
      // Explicitly discard the internal evidence before returning student DTOs.
      delete ev.internal_snapshot;
    }

    return {
      result,
      evaluations,
    };
  }
}

module.exports = {
  VivaResultRepository,
};
