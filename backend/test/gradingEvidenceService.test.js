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

test('one unverifiable item is dropped instead of voiding an otherwise verified criterion', () => {
  const { item, context } = input();
  const supported = item.evidence[0];
  item.evidence = [
    ...Array.from({ length: 5 }, () => ({ ...supported })),
    { ...supported, quote: 'A fabricated answer.' },
  ];
  const checked = validateCriterionEvidence(item, context);
  assert.equal(checked.score, 4);
  assert.equal(checked.valid.length, 5);
  assert.deepEqual(checked.reasons, []);
  assert.deepEqual(checked.dropped, ['UNVERIFIED_TRANSCRIPT_QUOTE']);
  assert.equal(checked.droppedCount, 1);
});

test('a criterion whose every item fails stays blocked and explains why', () => {
  const { item, context } = input();
  item.evidence = [
    { quote: 'A fabricated answer.', key_point_index: 0, reference_quote: 'Fields remain private' },
    { quote: 'My class keeps fields private.', key_point_index: 0, reference_quote: 'Unapproved external material' },
  ];
  const checked = validateCriterionEvidence(item, context);
  assert.equal(checked.score, null);
  assert.equal(checked.levelId, null);
  assert.deepEqual(checked.valid, []);
  assert.ok(checked.reasons.includes('MISSING_EVIDENCE'));
  assert.ok(checked.reasons.includes('UNVERIFIED_TRANSCRIPT_QUOTE'));
  assert.ok(checked.reasons.includes('UNVERIFIED_APPROVED_KNOWLEDGE'));
  assert.deepEqual(checked.dropped, []);
  assert.equal(checked.droppedCount, 0);
});

test('empty or missing evidence is blocking', () => {
  for (const evidence of [[], undefined, {}]) {
    const { item, context } = input();
    item.evidence = evidence;
    const checked = validateCriterionEvidence(item, context);
    assert.equal(checked.score, null);
    assert.deepEqual(checked.reasons, ['MISSING_EVIDENCE']);
    assert.deepEqual(checked.dropped, []);
    assert.equal(checked.droppedCount, 0);
  }
});

test('STT spelling variants still support an approved key point', () => {
  const { supportedPoint } = require('../src/domain/gradingEvidence');
  assert.equal(supportedPoint('This class has acknowledgments for the protocol', 'acknowledgements for the protocol'), true);
  assert.equal(supportedPoint('the file is 377,489 bytes', '377489 bytes'), true);
  assert.equal(supportedPoint('the file is 377.489 bytes', '377489 bytes'), true);
  assert.equal(supportedPoint('the file is 377 489 bytes', '377489 bytes'), true);
  assert.equal(supportedPoint('the file is 1,234,567 bytes', '1234567 bytes'), true);
  assert.equal(supportedPoint('the behavior is undefined', 'behaviour is undefined'), true);
  assert.equal(supportedPoint('the colour is red', 'the color is red'), true);
});

test('spelling tolerance does not defeat the negation check', () => {
  const { supportedPoint } = require('../src/domain/gradingEvidence');
  assert.equal(supportedPoint('The service does not use ACK', 'uses ACK'), false);
  assert.equal(supportedPoint('The behaviour does not change', 'behaviour changes'), false);
});

test('an invalid score scale or performance level still blocks valid evidence', () => {
  const { item, context } = input();
  item.ai_score = 6;
  const scaleFailure = validateCriterionEvidence(item, context);
  assert.equal(scaleFailure.score, null);
  assert.equal(scaleFailure.valid.length, 1);
  assert.ok(scaleFailure.reasons.includes('INVALID_SCORE_SCALE'));

  const { item: levelItem, context: levelContext } = input();
  levelItem.ai_level_id = 99;
  const levelFailure = validateCriterionEvidence(levelItem, levelContext);
  assert.equal(levelFailure.score, null);
  assert.equal(levelFailure.valid.length, 1);
  assert.deepEqual(levelFailure.reasons, ['INVALID_PERFORMANCE_LEVEL']);
});

test('server derives shortest exact Vietnamese transcript evidence when the model returns none', () => {
  const point = 'Số thứ tự giúp bên nhận sắp xếp dữ liệu và nhận biết dữ liệu bị thiếu.';
  const answer = 'truyền lại số thứ tự giúp bên nhận sắp xếp dữ liệu và nhận biết dữ liệu bị thiếu bên nhận gửi ác';
  const { item, context } = input();
  item.evidence = [];
  context.knowledge.key_points = [point];
  context.knowledge.reference_answer = point;
  context.history = [{ answerText: answer }];
  const checked = validateCriterionEvidence(item, context);
  assert.equal(checked.derived, true);
  assert.equal(checked.score, 4);
  assert.ok(checked.valid[0].source === 'SERVER_MATCH');
  assert.ok(answer.includes(checked.valid[0].quote));
});

test('server evidence fallback rejects distant words, negation, and unapproved reference text', () => {
  const point = 'sắp xếp dữ liệu';
  const cases = [
    { answer: 'sắp xếp alpha beta gamma delta epsilon zeta eta theta dữ liệu', reference: point },
    { answer: 'không sắp xếp dữ liệu', reference: point },
    { answer: 'sắp xếp dữ liệu', reference: 'Reference contains no such claim.' },
  ];
  for (const entry of cases) {
    const { item, context } = input();
    item.evidence = [];
    context.knowledge.key_points = [point];
    context.knowledge.reference_answer = entry.reference;
    context.history = [{ answerText: entry.answer }];
    const checked = validateCriterionEvidence(item, context);
    assert.equal(checked.derived, undefined);
    assert.equal(checked.score, null);
    assert.ok(checked.reasons.includes('MISSING_EVIDENCE'));
  }
});

test('valid model evidence bypasses derivation and derivation does not bypass score validation', () => {
  const { item, context } = input();
  item.evidence[0].reference_quote = 'Fields remain private';
  context.knowledge.reference_answer = 'Fields remain private';
  assert.equal(validateCriterionEvidence(item, context).derived, undefined);

  item.evidence = [];
  context.knowledge.key_points = ['Fields remain private'];
  context.history = [{ answerText: 'Fields remain private' }];
  item.ai_score = 6;
  const checked = validateCriterionEvidence(item, context);
  assert.equal(checked.derived, true);
  assert.equal(checked.score, null);
  assert.ok(checked.reasons.includes('INVALID_SCORE_SCALE'));
});
