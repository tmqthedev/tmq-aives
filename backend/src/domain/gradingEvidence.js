const { normalizeForMatch } = require('../interview/groundingValidator');

const ignoredWords = new Set(['a', 'an', 'the', 'is', 'are', 'to', 'of', 'and', 'with', 'by', 'in', 'for']);
const injection = /\b(ignore|disregard|pretend|instructions?)\b|bỏ qua|phớt lờ/iu;
// A negation in the quote that the approved key point does not also contain may
// reverse its meaning ("không đồng bộ" is fine when the key point says it too).
const negations = ['not', 'never', 'no', 'without', 'không', 'chưa', 'đừng', 'chẳng'];
const nonblank = value => typeof value === 'string' && value.trim() !== '';
const exactForm = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();

// Conservative, deterministic support gate. It accepts reordered wording while
// preserving all substantive words of an approved key point. It does not infer
// synonyms or semantic entailment: uncertain paraphrases require human review.
function supportedPoint(quote, point) {
  if (injection.test(quote)) return false;
  const pointWords = normalizeForMatch(point).split(' ');
  const words = pointWords.filter(word => !ignoredWords.has(word));
  const transcriptWords = new Set(normalizeForMatch(quote).split(' '));
  const pointSet = new Set(pointWords);
  if (negations.some(neg => transcriptWords.has(neg) && !pointSet.has(neg))) return false;
  return words.length > 0 && words.every(word => transcriptWords.has(word));
}

function validateCriterionEvidence(item, { knowledge, history, criterion }) {
  const reasons = [];
  const score = item?.ai_score;
  const scale = Number(criterion.max_score ?? knowledge.rubric_snapshot.max_score);
  const levels = criterion.performance_levels || [];
  const level = levels.find(entry => Number(entry.performance_level_id) === Number(item?.ai_level_id));
  if (typeof score !== 'number' || !Number.isFinite(score) || (!Number.isFinite(scale) || scale <= 0) || score < 0 || score > scale) reasons.push('INVALID_SCORE_SCALE');
  if (levels.length && (!level || level.min_score == null || level.max_score == null
    || !Number.isFinite(Number(level.min_score)) || !Number.isFinite(Number(level.max_score))
    || Number(level.min_score) < 0 || Number(level.max_score) > scale
    || Number(level.min_score) > Number(level.max_score)
    || score < Number(level.min_score) || score > Number(level.max_score))) reasons.push('INVALID_PERFORMANCE_LEVEL');
  const answers = history.map(turn => exactForm(turn.answerText)).filter(Boolean);
  const valid = [];
  if (!Array.isArray(item?.evidence) || !item.evidence.length) reasons.push('MISSING_EVIDENCE');
  for (const evidence of Array.isArray(item?.evidence) ? item.evidence : []) {
    const pointIndex = evidence?.key_point_index;
    const point = Number.isInteger(pointIndex) ? knowledge.key_points[pointIndex] : null;
    const quote = exactForm(evidence?.quote);
    const reference = exactForm(evidence?.reference_quote);
    if (!nonblank(evidence?.quote) || !answers.some(answer => answer.includes(quote))) {
      reasons.push('UNVERIFIED_TRANSCRIPT_QUOTE');
    } else if (!nonblank(point) || !reference || !exactForm(knowledge.reference_answer).includes(reference)) {
      reasons.push('UNVERIFIED_APPROVED_KNOWLEDGE');
    } else if (!supportedPoint(quote, point)) {
      reasons.push('UNSUPPORTED_KEY_POINT');
    } else {
      valid.push({ quote: evidence.quote, key_point_index: pointIndex,
        key_point: point, reference_quote: evidence.reference_quote });
    }
  }
  return { valid, reasons: [...new Set(reasons)], score: reasons.length ? null : score,
    levelId: reasons.length || !level ? null : Number(level.performance_level_id) };
}
module.exports = { validateCriterionEvidence, supportedPoint };
