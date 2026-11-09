const test = require('node:test');
const assert = require('node:assert/strict');
const { QuestionService } = require('../src/services/questionService');

// Fake question repository backed by a Map. Mirrors the real repository's
// method surface used by the service; no InMemoryDatabase, no SQL.
class FakeQuestionRepo {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }

  _normalized(content) {
    return String(content).trim().toLowerCase();
  }

  async findAllFiltered({ status, bloom, source, topicId } = {}) {
    let all = [...this.rows.values()];
    if (status) all = all.filter((r) => r.status === status);
    if (bloom) all = all.filter((r) => r.bloom_level === bloom);
    if (source) all = all.filter((r) => r.source === source);
    if (topicId) all = all.filter((r) => Number(r.topic_id) === Number(topicId));
    return all.sort((a, b) => a.question_id - b.question_id).map((r) => ({ ...r }));
  }

  async findById(id) {
    const row = this.rows.get(Number(id));
    return row ? { ...row } : null;
  }

  async findByNormalizedContent(normalized, excludeId = null) {
    for (const row of this.rows.values()) {
      if (this._normalized(row.content) !== normalized) continue;
      if (excludeId != null && row.question_id === excludeId) continue;
      return { question_id: row.question_id };
    }
    return null;
  }

  async create(payload) {
    const id = this.nextId++;
    const row = {
      question_id: id,
      topic_id: payload.topicId,
      rubric_id: payload.rubricId ?? null,
      content: payload.content,
      status: payload.status,
      bloom_level: payload.bloomLevel ?? null,
      language: payload.language ?? null,
      reference_answer: payload.referenceAnswer ?? null,
      key_points: payload.keyPoints ?? null,
      source: payload.source ?? null,
      rationale: payload.rationale ?? null,
      embedding: payload.embedding ?? null,
      created_by: payload.createdBy ?? null,
      reviewed_by: payload.reviewedBy ?? null,
      reviewed_at: payload.reviewedAt ?? null,
      review_note: payload.reviewNote ?? null,
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async update(id, patch) {
    const row = this.rows.get(Number(id));
    if (!row) return null;
    const map = {
      topicId: 'topic_id',
      rubricId: 'rubric_id',
      content: 'content',
      status: 'status',
      bloomLevel: 'bloom_level',
      language: 'language',
      referenceAnswer: 'reference_answer',
      keyPoints: 'key_points',
      source: 'source',
      rationale: 'rationale',
      embedding: 'embedding',
      reviewedBy: 'reviewed_by',
      reviewedAt: 'reviewed_at',
      reviewNote: 'review_note',
    };
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] !== undefined) row[column] = patch[key];
    }
    return { ...row };
  }

  async updateStatusFields(id, fields) {
    return this.update(id, fields);
  }

  async deleteById(id) {
    const row = this.rows.get(Number(id));
    if (!row) return null;
    this.rows.delete(Number(id));
    return { ...row };
  }

  async findSubjectEmbeddingsByTopic() {
    return [];
  }

  async findSameSubjectEmbeddings() {
    return [];
  }
}

class FakeRubricRepo {
  constructor(rubrics = []) {
    this.rubrics = new Map(rubrics.map((r) => [r.rubric_id, r]));
  }

  async findById(id) {
    return this.rubrics.get(Number(id)) || null;
  }
}

class FakeTopicRepo {
  constructor(topics = []) {
    this.topics = new Map(topics.map((t) => [t.topic_id, t]));
  }

  async getById(id) {
    return this.topics.get(Number(id)) || null;
  }
}

// Embedding adapter stub producing a fixed small vector (never near-duplicate
// here because the fake repo returns no same-subject embeddings).
const stubEmbedding = { async embed() { return [1, 0, 0]; } };

function createService({ rubrics, topics } = {}) {
  const repository = new FakeQuestionRepo();
  const rubricRepository = rubrics ? new FakeRubricRepo(rubrics) : null;
  const topicRepository = topics ? new FakeTopicRepo(topics) : null;
  return {
    repository,
    service: new QuestionService({
      repository,
      embeddingAdapter: stubEmbedding,
      rubricRepository,
      topicRepository,
    }),
  };
}

test('createQuestion returns { question, warnings } and defaults DRAFT without rubric', async () => {
  const { service } = createService();
  const { question, warnings } = await service.createQuestion({
    topicId: 1,
    content: 'Explain OOP in Java.',
    language: 'en',
    bloomLevel: 'UNDERSTAND',
  });

  assert.equal(question.id, 1);
  assert.equal(question.topicId, 1);
  assert.equal(question.content, 'Explain OOP in Java.');
  assert.equal(question.status, 'DRAFT');
  assert.equal(question.rubricId, null);
  assert.equal(question.source, 'MANUAL');
  assert.deepEqual(warnings, []);
});

test('createQuestion defaults PENDING_REVIEW when content + topic + rubric are present', async () => {
  const { service } = createService();
  const { question } = await service.createQuestion({
    topicId: 1,
    rubricId: 5,
    content: 'Describe polymorphism.',
    language: 'en',
  });
  assert.equal(question.status, 'PENDING_REVIEW');
  assert.equal(question.rubricId, 5);
});

test('createQuestion stores purpose into rationale.purpose and exposes it', async () => {
  const { service } = createService();
  const { question } = await service.createQuestion({
    topicId: 1,
    content: 'What is a thread?',
    language: 'en',
    purpose: 'Assess concurrency basics',
  });
  assert.equal(question.purpose, 'Assess concurrency basics');
  assert.deepEqual(question.rationale, { purpose: 'Assess concurrency basics' });
});

test('createQuestion rejects duplicate content (case-insensitive) with 409 DUPLICATE_QUESTION', async () => {
  const { service } = createService();
  await service.createQuestion({ topicId: 1, content: 'What is a thread?', language: 'en' });

  await assert.rejects(
    () => service.createQuestion({ topicId: 1, content: '  WHAT IS A THREAD?  ', language: 'en' }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'DUPLICATE_QUESTION');
      return true;
    },
  );
});

test('createQuestion validates required fields', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.createQuestion({ topicId: 1 }),
    (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test('createQuestion rejects an invalid bloom level', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.createQuestion({
      topicId: 1, content: 'q', language: 'en', bloomLevel: 'CREATE',
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /bloomLevel/);
      return true;
    },
  );
});

test('getQuestionById returns 404 for a missing question', async () => {
  const { service } = createService();
  await assert.rejects(() => service.getQuestionById(999), (error) => {
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test('listQuestions filters by status', async () => {
  const { service } = createService();
  await service.createQuestion({ topicId: 1, content: 'Draft one', language: 'en' });
  await service.createQuestion({
    topicId: 1, rubricId: 2, content: 'Pending one', language: 'en',
  });

  const pending = await service.listQuestions({ status: 'PENDING_REVIEW' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].content, 'Pending one');
});

test('updateQuestion patches fields and keeps its own content non-duplicate', async () => {
  const { service } = createService();
  const { question } = await service.createQuestion({ topicId: 1, content: 'Initial', language: 'en' });

  const updated = await service.updateQuestion(question.id, {
    content: 'Updated question',
    bloomLevel: 'APPLY',
  });
  assert.equal(updated.content, 'Updated question');
  assert.equal(updated.bloomLevel, 'APPLY');

  // Re-saving its own content is not a duplicate conflict.
  const same = await service.updateQuestion(question.id, { content: 'Updated question' });
  assert.equal(same.content, 'Updated question');
});

test('approve requires an attached rubric (RUBRIC_REQUIRED) and a complete knowledge base', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({ topicId: 1, content: 'needs rubric', language: 'en' });
  // status DRAFT, no rubric.
  await assert.rejects(
    () => service.approve(question.id, { reviewedBy: 7 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'RUBRIC_REQUIRED');
      return true;
    },
  );

  // Attach the rubric AND the grading knowledge (reference answer + key points),
  // then approve.
  await repository.update(question.id, {
    rubricId: 3,
    referenceAnswer: 'A reference answer.',
    keyPoints: ['key point one'],
  });
  const approved = await service.approve(question.id, { reviewedBy: 7 });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.reviewedBy, 7);
});

test('approve rejects a blank reference answer with 409 QUESTION_INCOMPLETE', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({
    topicId: 1, rubricId: 5, content: 'needs a reference answer', language: 'en',
  });
  await repository.update(question.id, { keyPoints: ['key point one'] });

  await assert.rejects(
    () => service.approve(question.id, { reviewedBy: 7 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'QUESTION_INCOMPLETE');
      assert.match(error.message, /referenceAnswer/);
      return true;
    },
  );
  // The question was not approved.
  assert.equal((await repository.findById(question.id)).status, 'PENDING_REVIEW');
});

test('approve rejects missing or empty key points with 409 QUESTION_INCOMPLETE', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({
    topicId: 1, rubricId: 5, content: 'needs key points', language: 'en',
  });

  // No key points at all.
  await repository.update(question.id, { referenceAnswer: 'A reference answer.' });
  await assert.rejects(
    () => service.approve(question.id, { reviewedBy: 7 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'QUESTION_INCOMPLETE');
      assert.match(error.message, /keyPoints/);
      return true;
    },
  );

  // An empty array is still incomplete.
  await repository.update(question.id, { keyPoints: [] });
  await assert.rejects(
    () => service.approve(question.id, { reviewedBy: 7 }),
    (error) => error.statusCode === 409 && error.code === 'QUESTION_INCOMPLETE',
  );
});

test('approve rejects a rubric that belongs to another subject (RUBRIC_SUBJECT_MISMATCH)', async () => {
  const { service, repository } = createService({
    rubrics: [{ rubric_id: 5, subject_id: 200 }],
    topics: [{ topic_id: 1, subject_id: 100 }],
  });
  await repository.create({
    topicId: 1,
    rubricId: 5,
    content: 'rubric from another subject',
    status: 'PENDING_REVIEW',
    referenceAnswer: 'A reference answer.',
    keyPoints: ['key point one'],
  });

  await assert.rejects(
    () => service.approve(1, { reviewedBy: 7 }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'RUBRIC_SUBJECT_MISMATCH');
      return true;
    },
  );
});

test('reject requires a reason (REASON_REQUIRED) and stores the review note', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({
    topicId: 1, rubricId: 2, content: 'to review', language: 'en',
  });
  // Move to PENDING_REVIEW so REJECTED is a legal transition.
  await repository.update(question.id, { status: 'PENDING_REVIEW' });

  await assert.rejects(
    () => service.reject(question.id, { reason: '  ' }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'REASON_REQUIRED');
      return true;
    },
  );

  const rejected = await service.reject(question.id, { reason: 'Too vague', reviewedBy: 9 });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reviewNote, 'Too vague');
});

test('illegal lifecycle transition throws INVALID_TRANSITION', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({
    topicId: 1, rubricId: 2, content: 'archived item', language: 'en',
  });
  await repository.update(question.id, { status: 'ARCHIVED' });

  await assert.rejects(
    () => service.approve(question.id, { reviewedBy: 1 }),
    (error) => {
      assert.equal(error.code, 'INVALID_TRANSITION');
      return true;
    },
  );
});

test('deleteQuestion removes the row and then 404s', async () => {
  const { service } = createService();
  const { question } = await service.createQuestion({ topicId: 1, content: 'bye', language: 'en' });
  const deleted = await service.deleteQuestion(question.id);
  assert.equal(deleted.id, question.id);
  await assert.rejects(() => service.getQuestionById(question.id), (error) => {
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test('createQuestion rejects review outcomes as an explicit status', async () => {
  const { service } = createService();
  for (const status of ['APPROVED', 'REJECTED', 'ARCHIVED']) {
    await assert.rejects(
      () => service.createQuestion({ topicId: 1, content: `Q ${status}`, language: 'en', status }),
      (error) => error.statusCode === 400,
    );
  }
});

test('updateQuestion cannot move to APPROVED/REJECTED/ARCHIVED or leave ARCHIVED', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({ topicId: 1, content: 'Lifecycle guard', language: 'en' });
  await assert.rejects(() => service.updateQuestion(question.id, { status: 'APPROVED' }), (e) => e.statusCode === 400);
  await repository.update(question.id, { status: 'ARCHIVED' });
  await assert.rejects(
    () => service.updateQuestion(question.id, { status: 'DRAFT' }),
    (e) => e.statusCode === 409 && e.code === 'INVALID_TRANSITION',
  );
});

test('updateQuestion requires a revision to remove an APPROVED question rubric', async () => {
  const { service } = createService();
  const { question } = await service.createQuestion({
    topicId: 1,
    rubricId: 5,
    content: 'Keep my rubric',
    language: 'en',
    referenceAnswer: 'A reference answer.',
    keyPoints: ['key point one'],
  });
  const approved = await service.approve(question.id, { reviewedBy: 7 });
  assert.equal(approved.status, 'APPROVED');
  await assert.rejects(
    () => service.updateQuestion(question.id, { rubricId: null }),
    (e) => e.statusCode === 409 && e.code === 'QUESTION_REVISION_REQUIRED',
  );
});

test('listQuestions filters by topicId', async () => {
  const { service } = createService();
  await service.createQuestion({ topicId: 1, content: 'Topic 1 question', language: 'en' });
  await service.createQuestion({ topicId: 2, content: 'Topic 2 question', language: 'en' });

  const all = await service.listQuestions({});
  assert.equal(all.length, 2);

  const forTopic1 = await service.listQuestions({ topicId: 1 });
  assert.equal(forTopic1.length, 1);
  assert.equal(forTopic1[0].topicId, 1);

  const forTopic2 = await service.listQuestions({ topicId: 2 });
  assert.equal(forTopic2.length, 1);
  assert.equal(forTopic2[0].topicId, 2);
});


test('approved content edits preserve the active version even with a demotion in the same request', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({
    topicId: 1, rubricId: 5, content: 'Approved original', language: 'en',
    referenceAnswer: 'Original answer', keyPoints: ['Original point'],
  });
  await service.approve(question.id, { reviewedBy: 7 });
  const original = await repository.findById(question.id);
  const edits = {
    content: 'Changed content', referenceAnswer: 'Changed answer', keyPoints: [],
    rubricId: null, topicId: 2, language: 'VI', bloomLevel: 'APPLY',
    source: 'AI', purpose: 'Changed rationale',
  };
  for (const [field, value] of Object.entries(edits)) {
    await assert.rejects(
      () => service.updateQuestion(question.id, { [field]: value, status: 'PENDING_REVIEW' }),
      (e) => e.statusCode === 409 && e.code === 'QUESTION_REVISION_REQUIRED',
    );
    assert.deepEqual(await repository.findById(question.id), original);
  }
  await assert.rejects(
    () => service.updateQuestion(question.id, { status: 'PENDING_REVIEW' }),
    (e) => e.statusCode === 409 && e.code === 'QUESTION_REVISION_REQUIRED',
  );
  assert.deepEqual(await repository.findById(question.id), original);
  const unchanged = await service.updateQuestion(question.id, { status: 'APPROVED' });
  assert.equal(unchanged.status, 'APPROVED');
});

test('unapproved grading knowledge remains editable and can be explicitly approved afterwards', async () => {
  const { service } = createService();
  const { question } = await service.createQuestion({ topicId: 1, content: 'New question', language: 'en' });
  const edited = await service.updateQuestion(question.id, {
    rubricId: 5, referenceAnswer: 'Reviewed answer', keyPoints: ['Reviewed point'],
  });
  assert.equal(edited.referenceAnswer, 'Reviewed answer');
  assert.equal((await service.approve(question.id, { reviewedBy: 7 })).status, 'APPROVED');
});


test('approve rejects non-string legacy key points instead of coercing grading knowledge', async () => {
  const { service, repository } = createService();
  const { question } = await service.createQuestion({
    topicId: 1, rubricId: 5, content: 'Malformed legacy key points', language: 'en',
    referenceAnswer: 'Reference answer',
  });
  for (const points of [[42, { x: 1 }, '  '], JSON.stringify([42, { x: 1 }, '  '])]) {
    await repository.update(question.id, { keyPoints: points });
    await assert.rejects(
      () => service.approve(question.id, { reviewedBy: 7 }),
      (e) => e.statusCode === 409 && e.code === 'QUESTION_INCOMPLETE' && /keyPoints/.test(e.message),
    );
    assert.equal((await repository.findById(question.id)).status, 'PENDING_REVIEW');
  }
});
