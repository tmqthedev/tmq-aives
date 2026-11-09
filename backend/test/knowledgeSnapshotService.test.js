const test = require('node:test');
const assert = require('node:assert/strict');
const { AssignedQuestionRepository } = require('../src/repositories/assignedQuestionRepository');
const { readKnowledgeSnapshot, readInterviewQuestion } = require('../src/interview/knowledgeSnapshot');

test('assignment snapshots are serialized on the transaction and missing snapshot sets are rejected', async () => {
  const calls = [];
  const tx = { async query(sql, params) { calls.push({ sql, params }); return { rows: [{}] }; } };
  const repo = new AssignedQuestionRepository({ query() { throw new Error('escaped transaction'); } });
  const snapshot = { snapshot_version: 1, question_id: 2, content: 'Original', rubric_snapshot: { criteria: [] } };
  await repo.createMany(1, [2], tx, [snapshot]);
  assert.match(calls[0].sql, /knowledge_snapshot/);
  assert.deepEqual(calls[0].params, [1, 2, 1, JSON.stringify(snapshot)]);
  await assert.rejects(repo.createMany(1, [2], tx), /requires a knowledge snapshot/);
});

test('legacy operational prompts never satisfy grading snapshot requirements', () => {
  const row = { question_id: 1, legacy_question_text: 'Frozen migration prompt', knowledge_snapshot: null };
  assert.equal(readInterviewQuestion(row).legacy_operational_only, true);
  assert.throws(() => readKnowledgeSnapshot(row), { code: 'KNOWLEDGE_SNAPSHOT_MISSING' });
});


test('lecturer and student result metadata use frozen rubric definitions without exposing student evidence', async () => {
  const { VivaResultRepository } = require('../src/repositories/vivaResultRepository');
  const snapshot = { reference_answer: 'PRIVATE REFERENCE', rubric_snapshot: { max_score: 10,
    criteria: [{ rubric_criterion_id: 4, criterion_name: 'Original criterion', weight_percent: 100,
      performance_levels: [{ performance_level_id: 8, label: 'Original level' }] }] } };
  const db = { async query(sql) {
    assert.doesNotMatch(sql, /JOIN question q|JOIN rubric_criterion|JOIN performance_level/);
    if (sql.includes('FROM viva_result vr')) return { rows: [{ interview_id: 1 }] };
    if (sql.includes('FROM question_evaluation qe')) return { rows: [{ question_evaluation_id: 2, assigned_question_id: 3,
      ...(sql.includes('internal_snapshot') ? { internal_snapshot: structuredClone(snapshot) } : { knowledge_snapshot: structuredClone(snapshot) }) }] };
    if (sql.includes('FROM criterion_score cs')) return { rows: [{ criterion_score_id: 5, criterion_id: 4, ai_level_id: 8 }] };
    return { rows: [] };
  } };
  const repo = new VivaResultRepository(db);
  const lecturer = await repo.getFullResultDetail(1);
  assert.equal(lecturer.evaluations[0].criteria[0].criterion_name, 'Original criterion');
  assert.equal(lecturer.evaluations[0].criteria[0].level_label, 'Original level');
  const student = await repo.findFinalizedForStudent(1, 7);
  assert.equal(student.evaluations[0].criteria[0].criterion_name, 'Original criterion');
  assert.equal(JSON.stringify(student).includes('PRIVATE REFERENCE'), false);
  assert.equal(Object.hasOwn(student.evaluations[0], 'internal_snapshot'), false);
});


test('snapshot reader rejects malformed grading evidence and accepts complete JSON evidence', () => {
  const complete = { snapshot_version: 1, content: 'Question', reference_answer: 'Reference',
    key_points: ['Point'], rubric_snapshot: { criteria: [{ rubric_criterion_id: 1 }] } };
  const invalid = [
    { snapshot_version: 2 }, { snapshot_version: '1' }, { content: '  ' }, { content: {} },
    { reference_answer: '\t ' }, { reference_answer: 42 },
    { key_points: [] }, { key_points: [42, { x: 1 }, '  '] }, { key_points: null },
    { rubric_snapshot: { criteria: [] } }, { rubric_snapshot: { criteria: [null] } },
    { rubric_snapshot: { criteria: ['criterion'] } },
  ];
  for (const patch of invalid) {
    assert.throws(() => readKnowledgeSnapshot({ knowledge_snapshot: { ...complete, ...patch } }),
      { code: 'KNOWLEDGE_SNAPSHOT_MISSING' });
  }
  assert.deepEqual(readKnowledgeSnapshot({ knowledge_snapshot: JSON.stringify(complete) }), complete);
});
