// Deterministic mock LLM adapter for offline/test generation. Produces exactly
// `requestedCount` drafts with no network call. Each draft i cites chunks[i % n]
// and copies that chunk's first ~15 words verbatim into citations[0].excerpt so
// it passes the grounding/excerpt-substring validation by construction. The
// bloom_level walks the requested distribution (expanded to a flat list) and
// falls back to a round-robin over the Bloom enum when no distribution is given.

const { normalizeForMatch } = require('../interview/groundingValidator');

const BLOOM_LEVELS = ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE'];

// Generic follow-up wording per exam language. Deliberately names no key point
// so it can never leak the expected answer.
const MOCK_FOLLOW_UP_QUESTIONS = {
  VI: 'Bạn có thể giải thích rõ hơn và bổ sung phần còn thiếu trong câu trả lời của mình không?',
  EN: 'Could you elaborate further and cover what is still missing from your answer?',
};

// Expand a { REMEMBER: 2, APPLY: 1 } distribution into a flat ['REMEMBER',
// 'REMEMBER', 'APPLY'] list the drafts can walk in order. Unknown/zero keys are
// skipped. Returns null when there is nothing usable so the caller round-robins.
function expandDistribution(bloomDistribution) {
  if (!bloomDistribution || typeof bloomDistribution !== 'object') return null;
  const flat = [];
  for (const level of BLOOM_LEVELS) {
    const n = Number(bloomDistribution[level]);
    if (Number.isInteger(n) && n > 0) {
      for (let i = 0; i < n; i += 1) flat.push(level);
    }
  }
  return flat.length > 0 ? flat : null;
}

function firstWords(text, count) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .join(' ');
}

class MockLlmAdapter {
  async generateQuestions({
    language = 'en',
    topic = {},
    bloomDistribution = null,
    requestedCount = 0,
    chunks = [],
  } = {}) {
    const topicName = (topic && topic.name) || 'the topic';
    const n = Array.isArray(chunks) ? chunks.length : 0;
    if (n === 0 || requestedCount <= 0) return [];

    const bloomPlan = expandDistribution(bloomDistribution);
    const drafts = [];
    for (let i = 0; i < requestedCount; i += 1) {
      const chunk = chunks[i % n];
      const bloomLevel = bloomPlan
        ? bloomPlan[i % bloomPlan.length]
        : BLOOM_LEVELS[i % BLOOM_LEVELS.length];
      const excerpt = firstWords(chunk.content, 15);
      drafts.push({
        content: `[${language}] Regarding ${topicName}: question ${i + 1} grounded in the source material.`,
        bloom_level: bloomLevel,
        reference_answer: `A model answer for question ${i + 1} about ${topicName}.`,
        key_points: [
          `Key point A for question ${i + 1}`,
          `Key point B for question ${i + 1}`,
          `Key point C for question ${i + 1}`,
        ],
        citations: [{ chunk_id: chunk.chunk_id, excerpt }],
        purpose: `Assess understanding of ${topicName} (draft ${i + 1}).`,
        synthesis: `Synthesized from source chunk ${chunk.chunk_id}.`,
      });
    }
    return drafts;
  }

  // Deterministic follow-up decision (Step 6). A key point counts as covered
  // when its normalized text occurs in the latest answer. Missing points with
  // follow-ups left -> ASK_FOLLOW_UP (INCOMPLETE) with grounding built from
  // verbatim data so it passes groundingValidator by construction; otherwise
  // NEXT_MAIN_QUESTION.
  async decideFollowUp({
    language = 'EN',
    mainQuestion = {},
    rubricCriteria = [],
    sourceChunks = [],
    history = [],
    followUpsUsed = 0,
    maxFollowUps = 0,
  } = {}) {
    const keyPoints = Array.isArray(mainQuestion.keyPoints) ? mainQuestion.keyPoints.map(String) : [];
    const latest = history.length > 0 ? String(history[history.length - 1].answerText ?? '') : '';
    const answerNorm = normalizeForMatch(latest);
    const covered = keyPoints.filter((kp) => {
      const norm = normalizeForMatch(kp);
      return norm !== '' && answerNorm.includes(norm);
    });
    const missing = keyPoints.filter((kp) => !covered.includes(kp));

    if (missing.length > 0 && followUpsUsed < maxFollowUps) {
      const grounding = [];
      const quote = firstWords(latest, 12);
      if (quote !== '') grounding.push({ type: 'STUDENT_QUOTE', ref: null, text: quote });
      grounding.push({ type: 'KEY_POINT', ref: null, text: missing[0] });
      const chunk = Array.isArray(sourceChunks) && sourceChunks.length > 0 ? sourceChunks[0] : null;
      if (chunk) {
        const excerpt = firstWords(chunk.content, 10);
        if (excerpt !== '') grounding.push({ type: 'SOURCE_EXCERPT', ref: chunk.chunkId, text: excerpt });
      }
      const lang = String(language || '').toUpperCase() === 'VI' ? 'VI' : 'EN';
      return {
        next_action: 'ASK_FOLLOW_UP',
        follow_up_reason: 'INCOMPLETE',
        covered_key_points: covered,
        missing_key_points: missing,
        follow_up_question: MOCK_FOLLOW_UP_QUESTIONS[lang],
        rationale: {
          why: `The answer does not cover: ${missing.join('; ')}.`,
          purpose: 'Give the student a chance to complete the missing key points.',
          target_key_points: missing,
          target_criteria: (Array.isArray(rubricCriteria) ? rubricCriteria : []).map(String),
          grounding,
          synthesis: `Covered ${covered.length} of ${keyPoints.length} key points.`,
        },
      };
    }

    return {
      next_action: 'NEXT_MAIN_QUESTION',
      follow_up_reason: null,
      covered_key_points: covered,
      missing_key_points: missing,
      follow_up_question: null,
      rationale: {
        why: missing.length === 0 ? 'All key points are covered.' : 'No follow-ups remain.',
        purpose: 'Move on to the next main question.',
        target_key_points: [],
        target_criteria: [],
        grounding: [],
        synthesis: `Covered ${covered.length} of ${keyPoints.length} key points.`,
      },
    };
  }

  // Deterministic question grading (Step 8). Evaluates student answers against
  // rubric criteria and performance levels based on covered key points.
  async gradeQuestion({
    language = 'EN',
    mainQuestion = {},
    rubricCriteria = [],
    history = [],
  } = {}) {
    const rawKeyPoints = mainQuestion.key_points || mainQuestion.keyPoints || [];
    const keyPoints = Array.isArray(rawKeyPoints) ? rawKeyPoints.map(String) : [];

    const fullAnswerText = (history || [])
      .map((h) => String(h.answerText || h.answer_text || ''))
      .join(' ');
    const answerNorm = normalizeForMatch(fullAnswerText);

    const covered = keyPoints.filter((kp) => {
      const norm = normalizeForMatch(kp);
      return norm !== '' && answerNorm.includes(norm);
    });
    const missing = keyPoints.filter((kp) => !covered.includes(kp));

    const ratio = keyPoints.length > 0 ? covered.length / keyPoints.length : (answerNorm.length > 0 ? 0.8 : 0);
    const confidence = answerNorm.length > 0 ? 0.92 : 0.40;

    const criteriaEvals = (rubricCriteria || []).map((crit) => {
      const cid = crit.criterion_id || crit.rubric_criterion_id || crit.id;
      const maxScore = Number(crit.max_score || crit.maxScore || 10);
      const levels = (crit.performance_levels || crit.performanceLevels || []).slice();

      // Sort levels by minScore ascending
      levels.sort((a, b) => Number(a.min_score ?? a.minScore ?? 0) - Number(b.min_score ?? b.minScore ?? 0));

      let chosenLevel = null;
      let score = Math.round(ratio * maxScore * 10) / 10;

      if (levels.length > 0) {
        if (ratio >= 0.75) {
          chosenLevel = levels[levels.length - 1]; // Top level
        } else if (ratio >= 0.4 && levels.length >= 2) {
          chosenLevel = levels[Math.floor(levels.length / 2)]; // Mid level
        } else {
          chosenLevel = levels[0]; // Lowest level
        }

        const minS = Number(chosenLevel.min_score ?? chosenLevel.minScore ?? 0);
        const maxS = Number(chosenLevel.max_score ?? chosenLevel.maxScore ?? maxScore);
        score = Math.round((minS + (maxS - minS) * 0.8) * 10) / 10;
      }

      const reference = mainQuestion.reference_answer || mainQuestion.referenceAnswer || '';
      const evidence = covered.flatMap(point => {
        const turn = history.find(h => normalizeForMatch(h.answerText || h.answer_text || '').includes(normalizeForMatch(point)));
        return turn ? [{ quote: String(turn.answerText || turn.answer_text), key_point_index: keyPoints.indexOf(point), reference_quote: reference }] : [];
      });

      return {
        criterion_id: cid,
        ai_level_id: chosenLevel ? (chosenLevel.performance_level_id || chosenLevel.id) : null,
        ai_score: score,
        ai_justification: `Student addressed ${covered.length}/${keyPoints.length} key points for "${crit.name}".`,
        evidence,
      };
    });

    const isVi = String(language || '').toUpperCase() === 'VI';
    return {
      criteria_evaluations: criteriaEvals,
      strengths: covered.length > 0
        ? (isVi ? `Nắm vững các ý: ${covered.join(', ')}.` : `Demonstrated good understanding of: ${covered.join(', ')}.`)
        : (isVi ? 'Chưa thể hiện rõ các ý chính.' : 'Did not clearly address main key points.'),
      weaknesses: missing.length > 0
        ? (isVi ? `Chưa giải thích được: ${missing.join(', ')}.` : `Missing clear elaboration on: ${missing.join(', ')}.`)
        : (isVi ? 'Không có thiếu sót lớn.' : 'No major gaps observed.'),
      missing_points: missing,
      feedback: isVi
        ? `Câu trả lời đạt ${Math.round(ratio * 100)}% yêu cầu. Cần bổ sung ví dụ thực tế.`
        : `Answer covers approximately ${Math.round(ratio * 100)}% of expected points. Real-world examples recommended.`,
      confidence,
    };
  }
}

function createMockLlmAdapter() {
  return new MockLlmAdapter();
}

module.exports = {
  MockLlmAdapter,
  createMockLlmAdapter,
  BLOOM_LEVELS,
  MOCK_FOLLOW_UP_QUESTIONS,
};
