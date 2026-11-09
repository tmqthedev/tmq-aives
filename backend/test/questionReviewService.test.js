const test = require('node:test');
const assert = require('node:assert/strict');
const { QuestionService } = require('../src/services/questionService');

// Fake question repository backed by a Map. Mirrors the method surface the
// review paths use (findById + updateStatusFields that threads a tx client).
class FakeQuestionRepo {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }

  seed(row) {
    const id = row.question_id ?? this.nextId++;
    const stored = { question_id: id, rubric_id: null, ...row, question_id: id };
    this.rows.set(id, stored);
    return stored;
  }

  async findById(id) {
    const row = this.rows.get(Number(id));
    return row ? { ...row } : null;
  }

  // updateStatusFields accepts an optional tx client; the service threads the
  // withTransaction client here so the fake can model all-or-nothing by only
  // mutating when the whole batch runs to completion. To keep it simple we
  // mutate immediately but the service's transaction wrapper rethrows before
  // any mutation when up-front validation fails (validation runs first).
  async updateStatusFields(id, fields = {}, _client = this.db) {
    const row = this.rows.get(Number(id));
    if (!row) return null;
    const map = {
      status: 'status',
      rubricId: 'rubric_id',
      reviewedBy: 'reviewed_by',
      reviewedAt: 'reviewed_at',
      reviewNote: 'review_note',
    };
    for (const [key, column] of Object.entries(map)) {
      if (fields[key] !== undefined) row[column] = fields[key];
    }
    return { ...row };
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

class FakeSourceRefRepo {
  constructor(byQuestion = {}) {
    this.byQuestion = byQuestion;
  }

  async listByQuestionWithMaterial(questionId) {
    return this.byQuestion[questionId] || [];
  }
}

// A transactional db whose client is just a pass-through: the fake repo keeps
// its own state, so the client only needs to exist for the service to thread.
const fakeDb = {
  async withTransaction(callback) {
    return callback({ query: async () => ({ rows: [], rowCount: 0 }) });
  },
};

function createService({ rubrics, topics, sourceRefs } = {}) {
  const repository = new FakeQuestionRepo();
  const rubricRepository = new FakeRubricRepo(rubrics || [{ rubric_id: 5, subject_id: 100 }]);
  const topicRepository = new FakeTopicRepo(topics || [{ topic_id: 1, subject_id: 100 }]);
  const questionSourceRefRepository = new FakeSourceRefRepo(sourceRefs || {});
  const service = new QuestionService({
    repository,
    rubricRepository,
    topicRepository,
    questionSourceRefRepository,
    db: fakeDb,
  });
  return {
    repository, service, rubricRepository, topicRepository,
  };
}

test('approveBatch flips every PENDING_REVIEW question to APPROVED with the shared rubric', async () => {
  const { service, repository } = createService();
  repository.seed({
    question_id: 1, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Answer one.', key_points: ['key point one'],
  });
  repository.seed({
    question_id: 2, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Answer two.', key_points: ['key point two'],
  });

  const result = await service.approveBatch({ questionIds: [1, 2], rubricId: 5, reviewedBy: 42 });

  assert.equal(result.length, 2);
  assert.ok(result.every((q) => q.status === 'APPROVED'));
  assert.ok(result.every((q) => q.rubricId === 5));
  assert.ok(result.every((q) => q.reviewedBy === 42));
  // Both rows were actually written.
  assert.equal((await repository.findById(1)).status, 'APPROVED');
  assert.equal((await repository.findById(2)).status, 'APPROVED');
});

test('approveBatch rejects a blank reference answer (QUESTION_INCOMPLETE) and rolls the whole batch back', async () => {
  const { service, repository } = createService();
  repository.seed({
    question_id: 1, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Answer one.', key_points: ['key point one'],
  });
  repository.seed({
    question_id: 2, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: '   ', key_points: ['key point two'],
  });

  await assert.rejects(
    () => service.approveBatch({ questionIds: [1, 2], rubricId: 5, reviewedBy: 42 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'QUESTION_INCOMPLETE');
      assert.equal(error.questionId, 2);
      return true;
    },
  );

  // Up-front validation runs BEFORE any write, so the valid row is untouched.
  assert.equal((await repository.findById(1)).status, 'PENDING_REVIEW');
  assert.equal((await repository.findById(2)).status, 'PENDING_REVIEW');
});

test('approveBatch rejects missing or empty key points (QUESTION_INCOMPLETE)', async () => {
  const { service, repository } = createService();
  repository.seed({
    question_id: 1, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Answer one.', key_points: [],
  });

  await assert.rejects(
    () => service.approveBatch({ questionIds: [1], rubricId: 5 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'QUESTION_INCOMPLETE');
      assert.equal(error.questionId, 1);
      return true;
    },
  );

  // A row with no key_points at all is also incomplete.
  repository.seed({
    question_id: 2, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Answer two.',
  });
  await assert.rejects(
    () => service.approveBatch({ questionIds: [2], rubricId: 5 }),
    (error) => error.statusCode === 409 && error.code === 'QUESTION_INCOMPLETE',
  );
});

test('approveBatch is all-or-nothing: a non-PENDING_REVIEW id rolls the whole batch back', async () => {
  const { service, repository } = createService();
  repository.seed({
    question_id: 1, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Answer one.', key_points: ['key point one'],
  });
  repository.seed({ question_id: 2, topic_id: 1, status: 'APPROVED' }); // illegal -> rollback

  await assert.rejects(
    () => service.approveBatch({ questionIds: [1, 2], rubricId: 5, reviewedBy: 42 }),
    (error) => {
      assert.equal(error.code, 'INVALID_TRANSITION');
      assert.equal(error.questionId, 2);
      return true;
    },
  );

  // Up-front validation runs BEFORE any write, so question 1 is untouched.
  assert.equal((await repository.findById(1)).status, 'PENDING_REVIEW');
  assert.equal((await repository.findById(1)).rubric_id, null);
});

test('approveBatch requires a rubric that resolves (RUBRIC_REQUIRED)', async () => {
  const { service, repository } = createService();
  repository.seed({ question_id: 1, topic_id: 1, status: 'PENDING_REVIEW' });

  await assert.rejects(
    () => service.approveBatch({ questionIds: [1], rubricId: 999 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'RUBRIC_REQUIRED');
      return true;
    },
  );
  assert.equal((await repository.findById(1)).status, 'PENDING_REVIEW');
});

test('approveBatch rejects a rubric from another subject with the offending id', async () => {
  const { service, repository } = createService({
    rubrics: [{ rubric_id: 5, subject_id: 200 }],
    topics: [{ topic_id: 1, subject_id: 100 }],
  });
  repository.seed({ question_id: 1, topic_id: 1, status: 'PENDING_REVIEW' });

  await assert.rejects(
    () => service.approveBatch({ questionIds: [1], rubricId: 5 }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.questionId, 1);
      return true;
    },
  );
});

test('approveBatch validates a non-empty questionIds array', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.approveBatch({ questionIds: [], rubricId: 5 }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      return true;
    },
  );
});

test('getQuestionSources maps citations via listByQuestionWithMaterial', async () => {
  const sourceRefs = {
    1: [
      {
        chunkId: 11,
        excerpt: 'threads share memory',
        materialTitle: 'Concurrency.pdf',
        location: 'page 3',
        content: 'Threads share memory within a process...',
      },
    ],
  };
  const { service, repository } = createService({ sourceRefs });
  repository.seed({ question_id: 1, topic_id: 1, status: 'PENDING_REVIEW' });

  const sources = await service.getQuestionSources(1);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].materialTitle, 'Concurrency.pdf');
  assert.equal(sources[0].location, 'page 3');
  assert.equal(sources[0].chunkId, 11);
});

test('getQuestionSources 404s for a missing question', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.getQuestionSources(999),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    },
  );
});


test('approveBatch rejects non-string legacy key points before approving any row', async () => {
  const { service, repository } = createService();
  repository.seed({ question_id: 1, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Good answer', key_points: ['Good point'] });
  repository.seed({ question_id: 2, topic_id: 1, status: 'PENDING_REVIEW',
    reference_answer: 'Malformed knowledge', key_points: [42, { x: 1 }, '  '] });
  await assert.rejects(
    () => service.approveBatch({ questionIds: [1, 2], rubricId: 5, reviewedBy: 7 }),
    (e) => e.statusCode === 409 && e.code === 'QUESTION_INCOMPLETE' && /keyPoints/.test(e.message),
  );
  assert.equal((await repository.findById(1)).status, 'PENDING_REVIEW');
  assert.equal((await repository.findById(2)).status, 'PENDING_REVIEW');
});
