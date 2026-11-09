const { normalizeForMatch } = require('../interview/groundingValidator');

const ignoredWords = new Set(['a', 'an', 'the', 'is', 'are', 'to', 'of', 'and', 'with', 'by', 'in', 'for']);
const injection = /\b(ignore|disregard|pretend|instructions?)\b|bỏ qua|phớt lờ/iu;
// A negation in the quote that the approved key point does not also contain may
// reverse its meaning ("không đồng bộ" is fine when the key point says it too).
const negations = ['not', 'never', 'no', 'without', 'không', 'chưa', 'đừng', 'chẳng'];
const nonblank = value => typeof value === 'string' && value.trim() !== '';
const exactForm = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();

// STT output frequently differs from authored key points only by orthography
// ("acknowledgments"/"acknowledgements", "377,489"/"377489", "behavior"/
// "behaviour"). Fold those variants on both sides of the comparison. This is
// deliberately narrow: no stemming, and non-ASCII (Vietnamese) words are left
// untouched because none of these suffixes apply to them.
function collapseDigitGroups(text) {
  let previous;
  let result = text;
  // Repeat so grouped numbers with more than one separator ("1,234,567")
  // collapse fully once the first pair has been joined.
  do {
    previous = result;
    result = result.replace(/(\d)[,.\s](?=\d{3}\b)/g, '$1');
  } while (result !== previous);
  return result;
}

function canonicalWord(word) {
  let result = word;
  if (result.length > 4 && result.endsWith('our')) result = `${result.slice(0, -3)}or`;
  result = result.replace(/dgement/g, 'dgment');
  if (result.endsWith('isation')) result = `${result.slice(0, -7)}ization`;
  else if (result.length > 5 && result.endsWith('ising')) result = `${result.slice(0, -5)}izing`;
  else if (result.length > 5 && result.endsWith('ised')) result = `${result.slice(0, -4)}ized`;
  else if (result.length > 5 && result.endsWith('ise')) result = `${result.slice(0, -3)}ize`;
  return result;
}

function canonicalWords(text) {
  return collapseDigitGroups(normalizeForMatch(text)).split(' ').filter(Boolean).map(canonicalWord);
}

// Conservative, deterministic support gate. It accepts reordered wording while
// preserving all substantive words of an approved key point. It does not infer
// synonyms or semantic entailment: uncertain paraphrases require human review.
function supportedPoint(quote, point) {
  if (injection.test(quote)) return false;
  const pointWords = canonicalWords(point);
  const words = pointWords.filter(word => !ignoredWords.has(word));
  const transcriptWords = new Set(canonicalWords(quote));
  const pointSet = new Set(pointWords);
  if (negations.some(neg => transcriptWords.has(neg) && !pointSet.has(neg))) return false;
  return words.length > 0 && words.every(word => transcriptWords.has(word));
}

function transcriptTokens(text) {
  const tokens = [];
  const matcher = /[\p{L}\p{N}]+/gu;
  for (const match of String(text ?? '').matchAll(matcher)) {
    tokens.push({ raw: match[0], start: match.index, end: match.index + match[0].length });
  }
  // Keep the original offsets while applying the same grouped-number folding
  // used by supportedPoint (e.g. 1,234,567 becomes one comparable token).
  for (let i = 0; i < tokens.length; i += 1) {
    if (!/^\d+$/u.test(tokens[i].raw)) continue;
    let combined = tokens[i].raw;
    let last = i;
    while (last + 1 < tokens.length && /^\d+$/u.test(tokens[last + 1].raw)
      && /^\d{3}$/u.test(tokens[last + 1].raw)
      && /^[,.\s]+$/u.test(String(text).slice(tokens[last].end, tokens[last + 1].start))) {
      combined += tokens[last + 1].raw;
      last += 1;
    }
    if (last > i) {
      tokens.splice(i, last - i + 1, { raw: combined, start: tokens[i].start, end: tokens[last].end });
    }
  }
  return tokens.map(token => ({ ...token, folded: canonicalWord(token.raw.toLowerCase()) }));
}

function deriveTranscriptEvidence({ knowledge, history }) {
  const reference = exactForm(knowledge?.reference_answer);
  const results = [];
  for (let pointIndex = 0; pointIndex < (knowledge?.key_points || []).length; pointIndex += 1) {
    const point = knowledge.key_points[pointIndex];
    if (!nonblank(point) || !exactForm(reference).includes(exactForm(point))) continue;
    const pointWords = canonicalWords(point).filter(word => !ignoredWords.has(word));
    const required = new Set(pointWords);
    if (!required.size) continue;
    const maxWindow = 2 * canonicalWords(point).length + 2;
    let found = null;
    for (const turn of history || []) {
      const answer = String(turn.answerText ?? '');
      const tokens = transcriptTokens(answer);
      for (let start = 0; start < tokens.length; start += 1) {
        const seen = new Set();
        for (let end = start; end < tokens.length && end - start + 1 <= maxWindow; end += 1) {
          seen.add(tokens[end].folded);
          if (pointWords.every(word => seen.has(word))) {
            const preceding = start > 0 ? tokens[start - 1] : null;
            const includeNegation = preceding && negations.includes(preceding.folded);
            const quote = answer.slice(includeNegation ? preceding.start : tokens[start].start, tokens[end].end);
            if (supportedPoint(quote, point)) {
              const candidate = { quote, length: end - start + 1 };
              if (!found || candidate.length < found.length) found = candidate;
            }
            break;
          }
        }
      }
    }
    if (found) results.push({ quote: found.quote, key_point_index: pointIndex, key_point: point,
      reference_quote: point, source: 'SERVER_MATCH' });
  }
  return results;
}

function validateCriterionEvidence(item, { knowledge, history, criterion }) {
  const blocking = [];
  const itemFailures = [];
  const score = item?.ai_score;
  const scale = Number(criterion.max_score ?? knowledge.rubric_snapshot.max_score);
  const levels = criterion.performance_levels || [];
  const level = levels.find(entry => Number(entry.performance_level_id) === Number(item?.ai_level_id));
  if (typeof score !== 'number' || !Number.isFinite(score) || (!Number.isFinite(scale) || scale <= 0) || score < 0 || score > scale) blocking.push('INVALID_SCORE_SCALE');
  if (levels.length && (!level || level.min_score == null || level.max_score == null
    || !Number.isFinite(Number(level.min_score)) || !Number.isFinite(Number(level.max_score))
    || Number(level.min_score) < 0 || Number(level.max_score) > scale
    || Number(level.min_score) > Number(level.max_score)
    || score < Number(level.min_score) || score > Number(level.max_score))) blocking.push('INVALID_PERFORMANCE_LEVEL');
  const answers = history.map(turn => exactForm(turn.answerText)).filter(Boolean);
  const valid = [];
  for (const evidence of Array.isArray(item?.evidence) ? item.evidence : []) {
    const pointIndex = evidence?.key_point_index;
    const point = Number.isInteger(pointIndex) ? knowledge.key_points[pointIndex] : null;
    const quote = exactForm(evidence?.quote);
    const reference = exactForm(evidence?.reference_quote);
    if (!nonblank(evidence?.quote) || !answers.some(answer => answer.includes(quote))) {
      itemFailures.push('UNVERIFIED_TRANSCRIPT_QUOTE');
    } else if (!nonblank(point) || !reference || !exactForm(knowledge.reference_answer).includes(reference)) {
      itemFailures.push('UNVERIFIED_APPROVED_KNOWLEDGE');
    } else if (!supportedPoint(quote, point)) {
      itemFailures.push('UNSUPPORTED_KEY_POINT');
    } else {
      valid.push({ quote: evidence.quote, key_point_index: pointIndex,
        key_point: point, reference_quote: evidence.reference_quote });
    }
  }
  // Per-item failures only void the criterion when they leave no verified
  // evidence at all. With at least one valid item they are dropped so a single
  // spelling/STT mismatch cannot null out an otherwise supported score.
  let derived = false;
  if (!valid.length) {
    // Only a silent model (no evidence at all) gets the server-side match.
    // Fabricated quotes mean the grading itself is unreliable: keep it blocked.
    const fallback = itemFailures.length ? [] : deriveTranscriptEvidence({ knowledge, history });
    if (fallback.length) {
      valid.push(...fallback);
      derived = true;
    } else blocking.push(...itemFailures, 'MISSING_EVIDENCE');
  }
  const reasons = [...new Set(blocking)];
  const dropped = valid.length && !derived ? [...new Set(itemFailures)] : [];
  return { valid, reasons, dropped, droppedCount: valid.length ? itemFailures.length : 0,
    score: reasons.length ? null : score,
    levelId: reasons.length || !level ? null : Number(level.performance_level_id), ...(derived ? { derived: true } : {}) };
}
module.exports = { validateCriterionEvidence, supportedPoint, deriveTranscriptEvidence, canonicalWord, canonicalWords, collapseDigitGroups };
