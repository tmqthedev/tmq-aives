const test = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryDatabase } = require('../src/db/createDatabase');
const { RubricRepository } = require('../src/repositories/rubricRepository');
const { RubricService } = require('../src/services/rubricService');
const { QuestionRepository } = require('../src/repositories/questionRepository');
const { QuestionService } = require('../src/services/questionService');
const { createMockEmbeddingAdapter } = require('../src/embedding/mockEmbeddingAdapter');

function createRubricService(db = new InMemoryDatabase({ persist: false })) {
  const rubricRepository = new RubricRepository(db);
  const questionRepository = new QuestionRepository(db);
  return {
    db,
    rubricService: new RubricService({ repository: rubricRepository }),
    questionService: new QuestionService({
      repository: questionRepository,
      rubricRepository,
      embeddingAdapter: createMockEmbeddingAdapter(),
    }),
  };
}

function sampleRubricPayload(overrides = {}) {
  return {
    maxScore: 10,
    criteria: [
      { name: 'Accuracy', weightPercent: 50 },
      { name: 'Clarity', weightPercent: 50 },
    ],
    ...overrides,
  };
}

test('creates and lists rubrics with criteria', async () => {
  const { rubricService } = createRubricService();

  const created = await rubricService.createRubric(sampleRubricPayload());
  assert.equal(created.id, 1);
  assert.equal(created.maxScore, 10);
  assert.equal(created.criteria.length, 2);
  assert.equal(created.isLocked, false);
  assert.equal(created.version, 1);

  const list = await rubricService.listRubrics();
  assert.equal(list.length, 1);
  assert.equal(list[0].criteria[0].name, 'Accuracy');
});

test('rubric create, update, clone and delete publish safe subject-scoped invalidations', async () => {
  const db = new InMemoryDatabase({ persist: false });
  const repository = new RubricRepository(db);
  const events = [];
  const rubricService = new RubricService({
    repository,
    realtimeBus: { publish: (entity, payload) => events.push({ entity, ...payload }) },
  });
  const created = await rubricService.createRubric(sampleRubricPayload({ subjectId: 7 }));
  await rubricService.updateRubric(created.id, { maxScore: 20 });
  const cloned = await rubricService.cloneRubric(created.id);
  await rubricService.deleteRubric(cloned.id);
  assert.deepEqual(events, [
    { entity: 'rubric', action: 'created', rubricId: created.id, subjectId: 7 },
    { entity: 'rubric', action: 'updated', rubricId: created.id, subjectId: 7 },
    { entity: 'rubric', action: 'created', rubricId: cloned.id, subjectId: 7 },
    { entity: 'rubric', action: 'deleted', rubricId: cloned.id, subjectId: 7 },
  ]);
});

test('rejects rubric when criteria weights do not total 100', async () => {
  const { rubricService } = createRubricService();

  await assert.rejects(
    () => rubricService.createRubric(sampleRubricPayload({
      criteria: [
        { name: 'Accuracy', weightPercent: 40 },
        { name: 'Clarity', weightPercent: 40 },
      ],
    })),
    (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test('rejects duplicate criterion names in the same rubric', async () => {
  const { rubricService } = createRubricService();

  await assert.rejects(
    () => rubricService.createRubric(sampleRubricPayload({
      criteria: [
        { name: 'Accuracy', weightPercent: 50 },
        { name: ' accuracy ', weightPercent: 50 },
      ],
    })),
    (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
});

test('updates rubric and replaces criteria', async () => {
  const { rubricService } = createRubricService();
  const created = await rubricService.createRubric(sampleRubricPayload());

  const updated = await rubricService.updateRubric(created.id, {
    maxScore: 20,
    criteria: [{ name: 'Depth', weightPercent: 100 }],
  });

  assert.equal(updated.maxScore, 20);
  assert.equal(updated.criteria.length, 1);
  assert.equal(updated.criteria[0].name, 'Depth');
});

test('rejects invalid criterion reference on update', async () => {
  const { rubricService } = createRubricService();
  const created = await rubricService.createRubric(sampleRubricPayload());

  await assert.rejects(
    () => rubricService.updateRubric(created.id, {
      criteria: [{ id: 999, name: 'Depth', weightPercent: 100 }],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /criterion reference/i);
      return true;
    },
  );
});

test('blocks delete when rubric is assigned to a question', async () => {
  const { db, rubricService, questionService } = createRubricService();
  const rubric = await rubricService.createRubric(sampleRubricPayload());

  await questionService.createQuestion({
    topicId: 1,
    rubricId: rubric.id,
    content: 'Question linked to rubric',
    language: 'en',
  });

  await assert.rejects(() => rubricService.deleteRubric(rubric.id), (error) => {
    assert.equal(error.statusCode, 409);
    return true;
  });

  assert.equal(db.rubrics.has(rubric.id), true);
});

test('deletes rubric when not in use', async () => {
  const { rubricService } = createRubricService();
  const created = await rubricService.createRubric(sampleRubricPayload());
  const deleted = await rubricService.deleteRubric(created.id);

  assert.equal(deleted.id, created.id);
  await assert.rejects(() => rubricService.getRubricById(created.id), (error) => {
    assert.equal(error.statusCode, 404);
    return true;
  });
});

// --- Lock / clone / performance levels (fake-repo) ---------------------------

// Minimal fake rubric repository exercising lock, clone, and nested levels
// without the in-memory SQL mock (which has no performance_level table).
class FakeRubricRepo {
  constructor() {
    this.rubrics = new Map();
    this.nextRubricId = 1;
    this.nextCriterionId = 1;
    this.nextLevelId = 1;
  }

  _build(rubricId, {
    maxScore, criteria, subjectId = null, createdBy = null, version = 1, isLocked = false,
  }) {
    const savedCriteria = (criteria || []).map((c) => ({
      rubric_criterion_id: this.nextCriterionId++,
      rubric_id: rubricId,
      criterion_name: c.name,
      weight_percent: c.weightPercent,
      description: c.description ?? null,
      performance_levels: (c.performanceLevels || []).map((lvl) => ({
        performance_level_id: this.nextLevelId++,
        label: lvl.label,
        min_score: lvl.minScore ?? null,
        max_score: lvl.maxScore ?? null,
        description: lvl.description ?? null,
        order_no: lvl.orderNo ?? null,
      })),
    }));
    return {
      rubric_id: rubricId,
      max_score: maxScore,
      subject_id: subjectId,
      created_by: createdBy,
      version,
      is_locked: isLocked,
      criteria: savedCriteria,
    };
  }

  async create({ maxScore, criteria }) {
    const id = this.nextRubricId++;
    const row = this._build(id, { maxScore, criteria });
    this.rubrics.set(id, row);
    return JSON.parse(JSON.stringify(row));
  }

  async findById(id) {
    const row = this.rubrics.get(Number(id));
    return row ? JSON.parse(JSON.stringify(row)) : null;
  }

  async findCriterionById(criterionId) {
    for (const rubric of this.rubrics.values()) {
      const found = rubric.criteria.find((c) => c.rubric_criterion_id === Number(criterionId));
      if (found) return { ...found };
    }
    return null;
  }

  async countQuestionsUsingRubric() { return 0; }

  async update(id, { maxScore, criteria }) {
    const row = this.rubrics.get(Number(id));
    if (!row) return null;
    const next = this._build(id, {
      maxScore: maxScore ?? row.max_score,
      criteria: criteria ?? row.criteria.map((c) => ({
        name: c.criterion_name,
        weightPercent: Number(c.weight_percent),
        description: c.description,
      })),
      subjectId: row.subject_id,
      createdBy: row.created_by,
      version: row.version,
      isLocked: row.is_locked,
    });
    this.rubrics.set(id, next);
    return JSON.parse(JSON.stringify(next));
  }

  async clone(id) {
    const source = this.rubrics.get(Number(id));
    if (!source) return null;
    const newId = this.nextRubricId++;
    const cloned = this._build(newId, {
      maxScore: source.max_score,
      criteria: source.criteria.map((c) => ({
        name: c.criterion_name,
        weightPercent: Number(c.weight_percent),
        description: c.description,
        performanceLevels: (c.performance_levels || []).map((lvl) => ({
          label: lvl.label,
          minScore: lvl.min_score,
          maxScore: lvl.max_score,
          description: lvl.description,
          orderNo: lvl.order_no,
        })),
      })),
      subjectId: source.subject_id,
      createdBy: source.created_by,
      version: (source.version || 1) + 1,
      isLocked: false,
    });
    this.rubrics.set(newId, cloned);
    return JSON.parse(JSON.stringify(cloned));
  }

  lock(id) { this.rubrics.get(Number(id)).is_locked = true; }
}

test('updateRubric is blocked with RUBRIC_LOCKED when the rubric is locked', async () => {
  const repo = new FakeRubricRepo();
  const service = new RubricService({ repository: repo });
  const created = await service.createRubric(sampleRubricPayload());
  repo.lock(created.id);

  await assert.rejects(
    () => service.updateRubric(created.id, { maxScore: 20 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'RUBRIC_LOCKED');
      return true;
    },
  );
});

test('cloneRubric copies criteria + performance levels and bumps version with is_locked=false', async () => {
  const repo = new FakeRubricRepo();
  const service = new RubricService({ repository: repo });
  const created = await service.createRubric({
    maxScore: 10,
    criteria: [
      {
        name: 'Accuracy',
        weightPercent: 100,
        performanceLevels: [
          { label: 'Excellent', minScore: 8, maxScore: 10, orderNo: 1 },
          { label: 'Poor', minScore: 0, maxScore: 4, orderNo: 2 },
        ],
      },
    ],
  });
  repo.lock(created.id);

  const clone = await service.cloneRubric(created.id);
  assert.notEqual(clone.id, created.id);
  assert.equal(clone.version, created.version + 1);
  assert.equal(clone.isLocked, false);
  assert.equal(clone.criteria.length, 1);
  assert.equal(clone.criteria[0].performanceLevels.length, 2);
  assert.equal(clone.criteria[0].performanceLevels[0].label, 'Excellent');
});

test('createRubric validates performance level fields (label + min<=max + integer order)', async () => {
  const repo = new FakeRubricRepo();
  const service = new RubricService({ repository: repo });

  // Missing label.
  await assert.rejects(
    () => service.createRubric({
      maxScore: 10,
      criteria: [{ name: 'A', weightPercent: 100, performanceLevels: [{ minScore: 1, maxScore: 2 }] }],
    }),
    (error) => { assert.equal(error.statusCode, 400); return true; },
  );

  // min > max.
  await assert.rejects(
    () => service.createRubric({
      maxScore: 10,
      criteria: [{ name: 'A', weightPercent: 100, performanceLevels: [{ label: 'Lvl', minScore: 9, maxScore: 2 }] }],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /minScore must be <= maxScore/);
      return true;
    },
  );

  // Non-integer order.
  await assert.rejects(
    () => service.createRubric({
      maxScore: 10,
      criteria: [{ name: 'A', weightPercent: 100, performanceLevels: [{ label: 'Lvl', orderNo: 1.5 }] }],
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /orderNo must be an integer/);
      return true;
    },
  );
});

test('createRubric accepts valid nested performance levels', async () => {
  const repo = new FakeRubricRepo();
  const service = new RubricService({ repository: repo });
  const created = await service.createRubric({
    maxScore: 10,
    criteria: [
      {
        name: 'Accuracy',
        weightPercent: 100,
        performanceLevels: [{ label: 'Good', minScore: 5, maxScore: 10, orderNo: 1 }],
      },
    ],
  });
  assert.equal(created.criteria[0].performanceLevels.length, 1);
  assert.equal(created.criteria[0].performanceLevels[0].label, 'Good');
});

test('preserves criterion order_index when creating and updating rubric', async () => {
  const { rubricService } = createRubricService();

  const created = await rubricService.createRubric({
    maxScore: 10,
    criteria: [
      { name: 'First', weightPercent: 30 },
      { name: 'Second', weightPercent: 30 },
      { name: 'Third', weightPercent: 40 },
    ],
  });

  assert.equal(created.criteria.length, 3);
  assert.equal(created.criteria[0].orderIndex, 1);
  assert.equal(created.criteria[1].orderIndex, 2);
  assert.equal(created.criteria[2].orderIndex, 3);

  const updated = await rubricService.updateRubric(created.id, {
    criteria: [
      { name: 'Updated A', weightPercent: 60 },
      { name: 'Updated B', weightPercent: 40 },
    ],
  });

  assert.equal(updated.criteria.length, 2);
  assert.equal(updated.criteria[0].orderIndex, 1);
  assert.equal(updated.criteria[1].orderIndex, 2);
});
