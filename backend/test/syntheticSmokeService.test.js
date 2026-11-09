const test = require('node:test');
const assert = require('node:assert/strict');
const { approveSyntheticSmokeQuestions } = require('../src/cli/syntheticSmokeQuestions');

function options() {
  const calls = [];
  return {
    calls, run: 'AI-SMOKE-123', jobId: 11, topicId: 12, lecturerId: 13, rubricId: 14,
    scenario: 'The receive window is 4096 bytes. ACK confirms received data.',
    db: { async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ question_id: 15 }] };
    } },
    questionService: {
      async updateQuestion(id, patch, user) { calls.push({ action: 'update', id, patch, user }); },
      async approve(id, options) { calls.push({ action: 'approve', id, options }); },
    },
  };
}

test('synthetic smoke approval writes source-grounded knowledge then uses the normal approval service', async () => {
  const opts = options();
  assert.deepEqual(await approveSyntheticSmokeQuestions(opts), [15]);
  const [query, update, approve] = opts.calls;
  assert.deepEqual(query.params, [11, 12, 13, 'AI-SMOKE-123']);
  assert.match(query.sql, /s.code = \$4/);
  assert.match(query.sql, /q.created_by = \$3/);
  assert.match(query.sql, /j.requested_by = \$3/);
  assert.match(query.sql, /q.status = 'PENDING_REVIEW'/);
  assert.deepEqual(update.patch, {
    rubricId: 14, referenceAnswer: opts.scenario,
    keyPoints: ['The receive window is 4096 bytes.', 'ACK confirms received data.'],
  });
  assert.equal(update.id, approve.id);
  assert.deepEqual(approve.options, { reviewedBy: 13, user: { id: 13, role: 'LECTURER' } });
});

test('smoke helper rejects unmarked runs and mismatched ownership without updating questions', async () => {
  const opts = options();
  await assert.rejects(approveSyntheticSmokeQuestions({ ...opts, run: 'LIVE-COURSE' }));
  assert.equal(opts.calls.length, 0);
  opts.db.query = async () => ({ rows: [] });
  await assert.rejects(approveSyntheticSmokeQuestions(opts), /No pending synthetic questions/);
  assert.equal(opts.calls.length, 0);
});

test('normal approval failures propagate instead of forcing the bank to APPROVED', async () => {
  const opts = options();
  opts.questionService.approve = async () => { throw Object.assign(new Error('incomplete'), { code: 'QUESTION_INCOMPLETE' }); };
  await assert.rejects(approveSyntheticSmokeQuestions(opts), { code: 'QUESTION_INCOMPLETE' });
});
