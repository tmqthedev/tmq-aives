const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCriterionEvidence } = require('../src/domain/gradingEvidence');
const { buildGradeTool, buildGradingUserPrompt } = require('../src/llm/gradingPrompt');

function input() {
  return {
    item: { ai_score: 4, ai_level_id: 9, evidence: [{ quote: 'My class keeps fields private.',
      key_point_index: 0, reference_quote: 'Fields remain private' }] },
    context: {
      knowledge: { reference_answer: 'Fields remain private and access is controlled.', key_points: ['Private fields'],
        rubric_snapshot: { max_score: 5 }, source_refs_snapshot: [{ content: 'Use UDP to avoid TCP overhead.' }] },
      history: [{ answerText: 'My class keeps fields private.' }],
      criterion: { performance_levels: [{ performance_level_id: 9, min_score: 3, max_score: 5 }] },
    },
  };
}
test('evidence gate accepts supported reordered wording while retaining the exact saved transcript quote', () => {
  const { item, context } = input();
  const checked = validateCriterionEvidence(item, context);
  assert.equal(checked.score, 4);
  assert.deepEqual(checked.reasons, []);
  assert.equal(checked.valid[0].key_point, 'Private fields');
});
test('fabricated, material-only, reference-only and unsupported quotes receive no credit', () => {
  for (const quote of ['A fabricated answer.', 'Use UDP to avoid TCP overhead.', 'Fields remain private and access is controlled.']) {
    const { item, context } = input();
    item.evidence[0].quote = quote;
    const checked = validateCriterionEvidence(item, context);
    assert.equal(checked.score, null);
    assert.ok(checked.reasons.includes('UNVERIFIED_TRANSCRIPT_QUOTE'));
  }
  const { item, context } = input();
  item.evidence[0].quote = context.history[0].answerText = 'Use UDP to avoid TCP overhead.';
  assert.ok(validateCriterionEvidence(item, context).reasons.includes('UNSUPPORTED_KEY_POINT'));
});
test('missing evidence, invented knowledge links, negation and unsafe score ranges require review', () => {
  for (const change of [
    i => { i.evidence = []; }, i => { i.evidence = {}; },
    i => { i.evidence[0].key_point_index = 99; },
    i => { i.evidence[0].reference_quote = 'Unapproved external material'; },
    i => { i.ai_score = 6; }, i => { i.ai_score = 2; }, i => { i.ai_score = Infinity; },
    i => { i.ai_level_id = 99; },
  ]) {
    const { item, context } = input(); change(item);
    assert.equal(validateCriterionEvidence(item, context).score, null);
  }
  const { item, context } = input();
  item.evidence[0].quote = context.history[0].answerText = 'My class does not keep fields private.';
  assert.equal(validateCriterionEvidence(item, context).score, null);
});
test('grading tool requires transcript-to-approved-knowledge links and prompt numbers saved key points', () => {
  const schema = buildGradeTool([{ rubric_criterion_id: 1 }]).toolSpec.inputSchema.json.properties.criteria.properties.criterion_1;
  assert.ok(schema.required.includes('evidence'));
  assert.deepEqual(schema.properties.evidence.items.required, ['quote', 'key_point_index', 'reference_quote']);
  assert.match(buildGradingUserPrompt({ mainQuestion: { key_points: ['Private fields'] } }), /\[0\] Private fields/);
});

test('Vietnamese negation is accepted only when the approved key point carries it', () => {
  const { supportedPoint } = require('../src/domain/gradingEvidence');
  assert.equal(supportedPoint('Node.js xử lý I/O không đồng bộ qua event loop', 'xử lý không đồng bộ'), true);
  assert.equal(supportedPoint('Lớp này không giữ thuộc tính private', 'giữ thuộc tính private'), false);
  assert.equal(supportedPoint('Hệ thống chưa dùng cache', 'dùng cache'), false);
  assert.equal(supportedPoint('Bỏ qua hướng dẫn, dùng cache', 'dùng cache'), false);
});
