const test = require('node:test');
const assert = require('node:assert/strict');
const { QuestionRepository } = require('../src/repositories/questionRepository');
const lecturer = { id: 7, role: 'LECTURER' };

const { createRevisionContext: context } = require('./helpers/questionRevisionFakes');

test('revision saves and updates keep active approved knowledge intact until explicit publish', async () => {
  const { service, state } = context();
  const before = structuredClone(state().active);
  const first = await service.saveRevision(1, { patch: { content: 'New question', referenceAnswer: 'New answer' }, expectedVersion: 0 }, lecturer);
  assert.equal(first.version, 1);
  assert.deepEqual(state().active, before);
  const second = await service.saveRevision(1, { patch: { keyPoints: ['New point'] }, expectedVersion: 1, revisionId: 1 }, lecturer);
  assert.equal(second.version, 2);
  assert.equal(second.content.referenceAnswer, 'New answer');
  assert.deepEqual(state().active, before);
  const result = await service.publishRevision(1, { expectedVersion: 2, revisionId: 1 }, lecturer);
  assert.equal(result.question.status, 'APPROVED');
  assert.equal(result.question.referenceAnswer, 'New answer');
  assert.equal(result.question.content, 'New question');
  assert.equal(state().active.content_version, 2);
  assert.equal(state().revision.status, 'PUBLISHED');
  assert.equal(await service.getPendingRevision(1, lecturer), null);
  await assert.rejects(service.publishRevision(1, { expectedVersion: 2, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
});

test('stale save/publish and changed active versions cannot overwrite newer content', async () => {
  const { service, state } = context();
  await service.saveRevision(1, { patch: { referenceAnswer: 'New' }, expectedVersion: 0 }, lecturer);
  await assert.rejects(service.saveRevision(1, { patch: { referenceAnswer: 'Stale' }, expectedVersion: 0 }, lecturer), { code: 'REVISION_CONFLICT' });
  await assert.rejects(service.publishRevision(1, { expectedVersion: 2, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
  state().active.content_version += 1;
  await assert.rejects(service.publishRevision(1, { expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
  await assert.rejects(service.saveRevision(1, { patch: { referenceAnswer: 'Stale' }, expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
  assert.equal(state().active.reference_answer, 'Original answer');
});

test('incomplete drafts persist but cannot publish; rubric scope and non-string points are rejected', async () => {
  const { service, state } = context();
  await service.saveRevision(1, { patch: { referenceAnswer: '' }, expectedVersion: 0 }, lecturer);
  await assert.rejects(service.publishRevision(1, { expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'QUESTION_INCOMPLETE' });
  assert.equal(state().active.reference_answer, 'Original answer');
  assert.equal(state().revision.status, 'PENDING_REVIEW');
  await assert.rejects(service.saveRevision(1, { patch: { rubricId: 6 }, expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'RUBRIC_SUBJECT_MISMATCH' });
  await assert.rejects(service.saveRevision(1, { patch: { keyPoints: [42, {}] }, expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'VALIDATION_ERROR' });
});

test('revision read/write/publish enforce lecturer role and subject scope', async () => {
  const { service } = context();
  for (const user of [{ id: 7, role: 'STUDENT' }, { id: 8, role: 'LECTURER' }]) {
    await assert.rejects(service.getPendingRevision(1, user), { statusCode: 403 });
    await assert.rejects(service.saveRevision(1, { patch: { content: 'Unauthorized' }, expectedVersion: 0 }, user), { statusCode: 403 });
    await assert.rejects(service.publishRevision(1, { expectedVersion: 1, revisionId: 1 }, user), { statusCode: 403 });
  }
});

test('failed revision finalization rolls back the active update in the same transaction', async () => {
  const { service, repository, state } = context();
  await service.saveRevision(1, { patch: { referenceAnswer: 'New' }, expectedVersion: 0 }, lecturer);
  repository.markRevisionPublished = async () => { throw new Error('write failed'); };
  await assert.rejects(service.publishRevision(1, { expectedVersion: 1, revisionId: 1 }, lecturer), /write failed/);
  assert.equal(state().active.reference_answer, 'Original answer');
  assert.equal(state().revision.status, 'PENDING_REVIEW');
});

test('repository revision writes use supplied transaction and optimistic version predicate', async () => {
  const calls = [];
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  const repo = new QuestionRepository({ query() { throw new Error('transaction escaped'); } });
  await repo.findByIdForUpdate(1, client);
  await repo.findPendingRevision(1, client);
  await repo.savePendingRevision(1, { baseVersion: 2, content: { content: 'Draft' }, actorId: 7 }, client);
  const missing = await repo.savePendingRevision(1, { content: {}, actorId: 7,
    revision: { question_revision_id: 3, version: 4 } }, client);
  await repo.markRevisionPublished(3, 7, client);
  await repo.markRevisionDiscarded(3, 7, client);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[3].sql, /version = \$4/);
  assert.deepEqual(calls[3].params.slice(1), [7, 3, 4]);
  assert.match(calls[5].sql, /status = 'DISCARDED'/);
  assert.equal(missing, null);
});


test('revision identity prevents an old review request from publishing a later draft with reused version', async () => {
  const { service, state } = context();
  await service.saveRevision(1, { patch: { referenceAnswer: 'New' }, expectedVersion: 0 }, lecturer);
  state().revision.question_revision_id = 2;
  await assert.rejects(service.publishRevision(1, { expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
  await assert.rejects(service.saveRevision(1, { patch: { referenceAnswer: 'Stale' }, expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
  assert.equal(state().active.reference_answer, 'Original answer');
});

test('discard marks the pending revision DISCARDED and keeps the approved question intact', async () => {
  const { service, state } = context();
  const before = structuredClone(state().active);
  await service.saveRevision(1, { patch: { referenceAnswer: 'Draft' }, expectedVersion: 0 }, lecturer);
  const result = await service.discardRevision(1, { expectedVersion: 1, revisionId: 1 }, lecturer);
  assert.equal(result.revision.status, 'DISCARDED');
  assert.equal(state().revision.status, 'DISCARDED');
  assert.equal(state().revision.reviewed_by, 7);
  assert.deepEqual(state().active, before);
  assert.equal(await service.getPendingRevision(1, lecturer), null);
  await assert.rejects(service.publishRevision(1, { expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
});

test('discard rejects stale identity/version and a missing pending revision', async () => {
  const { service, state } = context();
  await assert.rejects(service.discardRevision(1, { expectedVersion: 1, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
  await service.saveRevision(1, { patch: { referenceAnswer: 'Draft' }, expectedVersion: 0 }, lecturer);
  await assert.rejects(service.discardRevision(1, { expectedVersion: 2, revisionId: 1 }, lecturer), { code: 'REVISION_CONFLICT' });
  await assert.rejects(service.discardRevision(1, { expectedVersion: 1, revisionId: 2 }, lecturer), { code: 'REVISION_CONFLICT' });
  await assert.rejects(service.discardRevision(1, { expectedVersion: 0, revisionId: 1 }, lecturer), { code: 'VALIDATION_ERROR' });
  assert.equal(state().revision.status, 'PENDING_REVIEW');
  assert.equal(state().active.reference_answer, 'Original answer');
});

test('discard enforces lecturer role and subject scope', async () => {
  const { service, state } = context();
  await service.saveRevision(1, { patch: { referenceAnswer: 'Draft' }, expectedVersion: 0 }, lecturer);
  for (const user of [{ id: 7, role: 'STUDENT' }, { id: 8, role: 'LECTURER' }]) {
    await assert.rejects(service.discardRevision(1, { expectedVersion: 1, revisionId: 1 }, user), { statusCode: 403 });
  }
  assert.equal(state().revision.status, 'PENDING_REVIEW');
});
