const test = require('node:test');
const assert = require('node:assert/strict');
const { VivaResultRepository } = require('../src/repositories/vivaResultRepository');

test('grading publication saves evaluations and final status on one locked transaction', async () => {
  const calls = [];
  const tx = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT')) return { rows: [{ status: 'AI_SCORING' }] };
    return { rows: [{ status: 'AI_SUGGESTED' }] };
  } };
  const repo = new VivaResultRepository({
    query() { throw new Error('escaped transaction'); },
    async withTransaction(fn) { calls.push('BEGIN'); try { const value = await fn(tx); calls.push('COMMIT'); return value; } catch (error) { calls.push('ROLLBACK'); throw error; } },
  });
  await repo.publishAiGrading(1, [], { status: 'AI_SUGGESTED', ai_total_score: 8 });
  assert.match(calls[1], /FOR UPDATE/);
  assert.match(calls[2], /DELETE FROM question_evaluation/);
  assert.match(calls[3], /UPDATE viva_result/);
  assert.equal(calls.at(-1), 'COMMIT');
});
test('failed publication rolls back without publishing final status; finalized rows are preserved', async () => {
  const calls = [];
  const tx = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT')) return { rows: [{ status: 'AI_SCORING' }] };
    throw new Error('write failure');
  } };
  const repo = new VivaResultRepository({ async withTransaction(fn) {
    try { return await fn(tx); } catch (error) { calls.push('ROLLBACK'); throw error; }
  } });
  await assert.rejects(repo.publishAiGrading(1, [], { status: 'AI_SUGGESTED' }), /write failure/);
  assert.equal(calls.some(sql => sql.includes('UPDATE viva_result')), false);
  assert.equal(calls.at(-1), 'ROLLBACK');
  tx.query = async () => ({ rows: [{ status: 'FINALIZED', final_total_score: 9 }] });
  const result = await repo.publishAiGrading(1, [], { status: 'AI_SUGGESTED' });
  assert.equal(result.final_total_score, 9);
});
