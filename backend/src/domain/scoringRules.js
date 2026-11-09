// Pure domain logic for grading, weighted scoring, and FLAGGED detection.
//
// Rules from docs/e2e-plan-management.md (Section 4):
// 1. Each main question covers its main turn + follow-up turns.
// 2. Question score = sum(criterion_score / max_score * weight) normalized to 10-point scale.
// 3. Overall viva score = average of main question scores, rounded to 1 decimal place.
// 4. FLAGGED conditions:
//    - Any question evaluation confidence < 0.6
//    - Any turn has status 'FAILED' or missing student answer
//    - LLM returns invalid schema / failure
// 5. Score adjustment: If new_score != old_score, a justification reason is strictly required.

function round1(val) {
  if (val == null || Number.isNaN(Number(val))) return null;
  return Math.round(Number(val) * 10) / 10;
}

function round2(val) {
  if (val == null || Number.isNaN(Number(val))) return null;
  return Math.round(Number(val) * 100) / 100;
}

/**
 * Calculates score for a single question based on criterion evaluations and rubric criteria.
 * @param {Array} criteriaEvaluations - [{ criterion_id, score }]
 * @param {Array} rubricCriteria - [{ criterion_id, weight, max_score }]
 * @returns {number} Score on 10-point scale rounded to 2 decimals
 */
function calculateQuestionScore(criteriaEvaluations = [], rubricCriteria = []) {
  if (!Array.isArray(rubricCriteria) || rubricCriteria.length === 0) {
    return 0;
  }

  const critMap = new Map();
  for (const c of rubricCriteria) {
    critMap.set(Number(c.criterion_id || c.rubric_criterion_id || c.id), {
      weight: Number(c.weight ?? c.weight_percent ?? 0),
      maxScore: Number(c.max_score || c.maxScore || 10),
    });
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (const evalItem of criteriaEvaluations) {
    const cid = Number(evalItem.criterion_id || evalItem.criterionId);
    const crit = critMap.get(cid);
    if (!crit) continue;

    const score = Number(evalItem.score ?? evalItem.final_score ?? evalItem.ai_score ?? 0);
    const maxScore = crit.maxScore > 0 ? crit.maxScore : 10;
    const ratio = Math.max(0, Math.min(1, score / maxScore));

    weightedSum += ratio * crit.weight;
    totalWeight += crit.weight;
  }

  if (totalWeight <= 0) return 0;

  // Scale to 10-point scale: weightedSum is out of totalWeight (which normally sums to 100)
  const normalized = (weightedSum / totalWeight) * 10;
  return round2(normalized);
}

/**
 * Calculates the total viva score as the average of main question scores.
 * @param {Array<number>} questionScores
 * @returns {number} Score rounded to 1 decimal place (e.g. 8.5)
 */
function calculateVivaTotalScore(questionScores = []) {
  const valid = questionScores
    .map(Number)
    .filter((s) => !Number.isNaN(s) && s >= 0);

  if (valid.length === 0) return 0;
  const avg = valid.reduce((acc, v) => acc + v, 0) / valid.length;
  return round1(avg);
}

/**
 * Checks whether an evaluation should be marked as FLAGGED.
 * @param {Object} params
 * @param {Array} params.questionEvaluations
 * @param {Array} params.turns
 * @param {boolean} params.llmFailed
 * @returns {{ isFlagged: boolean, flagReason: string|null }}
 */
function detectFlagReason({ questionEvaluations = [], turns = [], llmFailed = false } = {}) {
  if (llmFailed) {
    return {
      isFlagged: true,
      flagReason: 'AI grading service failure or invalid response format',
    };
  }

  // Check for failed turns or empty student answers
  if (Array.isArray(turns) && turns.length > 0) {
    const failedTurn = turns.find((t) => t.status === 'FAILED');
    if (failedTurn) {
      return {
        isFlagged: true,
        flagReason: `Audio or STT failure on turn ${failedTurn.sequence_no || failedTurn.sequenceNo || 'unknown'}`,
      };
    }
  }

  // A question the AI could not fully grade (e.g. criteria left out).
  if (Array.isArray(questionEvaluations)) {
    const flaggedEval = questionEvaluations.find((qe) => qe && qe.flag_reason);
    if (flaggedEval) {
      return { isFlagged: true, flagReason: flaggedEval.flag_reason };
    }
  }

  // Check question confidence threshold (< 0.6)
  if (Array.isArray(questionEvaluations)) {
    for (const qe of questionEvaluations) {
      const conf = Number(qe.confidence);
      if (!Number.isNaN(conf) && conf < 0.6) {
        return {
          isFlagged: true,
          flagReason: `Low AI confidence (${conf.toFixed(2)} < 0.60) requires lecturer manual review`,
        };
      }
    }
  }

  return { isFlagged: false, flagReason: null };
}

// Hesitation sounds and fillers that carry no answer content on their own.
// Kept short and exact on purpose: an answer is "no answer" only when every
// token is one of these, so a real (even very short) answer is never zeroed.
const FILLER_TOKENS = new Set([
  'a', 'à', 'á', 'ạ', 'ả', 'ã', 'ơ', 'ờ', 'ớ', 'ở', 'ợ', 'ư', 'ừ', 'ừm', 'ừa', 'ưm', 'um', 'umm',
  'uh', 'uhm', 'uhh', 'ah', 'eh', 'er', 'erm', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'ờm', 'ơm', 'ậm',
]);

/**
 * True when the text holds actual answer content: at least one word that is
 * not punctuation, a bracketed STT tag such as "[silence]", or a filler sound.
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function isSubstantiveAnswer(text) {
  const cleaned = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  if (!cleaned) return false;
  return cleaned.split(/\s+/).some((token) => !FILLER_TOKENS.has(token));
}

/**
 * True when the student said nothing usable for a main question across its
 * main turn and all follow-ups (or was never asked it before the deadline).
 * Such a question scores 0 without calling the LLM.
 * @param {Array} turns - qa_turn rows of one assigned question
 * @returns {boolean}
 */
function isUnansweredQuestion(turns = []) {
  if (!Array.isArray(turns) || turns.length === 0) return true;
  return !turns.some((t) => isSubstantiveAnswer(t && (t.answer_text ?? t.answerText)));
}

/**
 * Validates a lecturer score adjustment.
 * @param {Object} params
 * @param {number} params.oldScore
 * @param {number} params.newScore
 * @param {string} params.reason
 */
function assertValidScoreAdjustment({ oldScore, newScore, reason } = {}) {
  const oldNum = Number(oldScore);
  const newNum = Number(newScore);

  if (Number.isNaN(newNum) || newNum < 0) {
    const err = new Error('Score must be a non-negative number.');
    err.statusCode = 400;
    err.code = 'INVALID_SCORE';
    throw err;
  }

  const hasChanged = Number.isNaN(oldNum) || Math.abs(oldNum - newNum) > 0.001;
  if (hasChanged) {
    const trimmed = String(reason || '').trim();
    if (!trimmed) {
      const err = new Error('A justification reason is required when adjusting a score.');
      err.statusCode = 400;
      err.code = 'REASON_REQUIRED';
      throw err;
    }
  }
}

module.exports = {
  round1,
  round2,
  calculateQuestionScore,
  calculateVivaTotalScore,
  detectFlagReason,
  assertValidScoreAdjustment,
  isSubstantiveAnswer,
  isUnansweredQuestion,
};
