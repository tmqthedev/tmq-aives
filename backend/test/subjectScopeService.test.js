const test = require('node:test');
const assert = require('node:assert/strict');
const { SubjectScope } = require('../src/services/subjectScope');
const { QuestionService } = require('../src/services/questionService');
const { RubricService } = require('../src/services/rubricService');
const { QuestionGenerationService } = require('../src/services/questionGenerationService');

// Lecturer 1 owns subject 10, lecturer 2 owns subject 20. Topic 1 -> subject 10,
// topic 2 -> subject 20, topic 3 has no subject (legacy, unscoped).
const SUBJECTS_BY_LECTURER = { 1: [10], 2: [20] };
const TOPICS = {
  1: { topic_id: 1, subject_id: 10 },
  2: { topic_id: 2, subject_id: 20 },
  3: { topic_id: 3, subject_id: null },
};
const L1 = { id: 1, role: 'LECTURER' };
const L2 = { id: 2, role: 'LECTURER' };
const ADMIN = { id: 99, role: 'ADMIN' };

const subjectRepository = {
  async listSubjectIdsForLecturer(id) { return SUBJECTS_BY_LECTURER[id] || []; },
};
const topicRepository = { async getById(id) { return TOPICS[id] || null; } };
const subjectScope = new SubjectScope({ subjectRepository });

function questionService(rows) {
  const store = new Map(rows.map((r) => [r.question_id, { ...r }]));
  const repository = {
    async findAllFiltered() { return [...store.values()]; },
    async findById(id) { return store.get(id) || null; },
    async deleteById(id) { const row = store.get(id); store.delete(id); return row || null; },
    async updateStatusFields(id, fields) {
      const row = { ...store.get(id), status: fields.status };
      store.set(id, row);
      return row;
    },
    async findByNormalizedContent() { return null; },
    async create(payload) {
      const row = { question_id: 100, topic_id: payload.topicId, status: payload.status, content: payload.content };
      store.set(100, row);
      return row;
    },
  };
  return new QuestionService({ repository, topicRepository, subjectScope });
}

const QUESTIONS = [
  {
    question_id: 1, topic_id: 1, status: 'PENDING_REVIEW', content: 'in subject 10',
    rubric_id: 5, reference_answer: 'Answer one.', key_points: ['key point one'],
  },
  {
    question_id: 2, topic_id: 2, status: 'PENDING_REVIEW', content: 'in subject 20',
    rubric_id: 5, reference_answer: 'Answer two.', key_points: ['key point two'],
  },
  { question_id: 3, topic_id: 3, status: 'DRAFT', content: 'legacy, no subject' },
];

const forbidden = (error) => error.statusCode === 403 && error.code === 'FORBIDDEN';

test('listQuestions only returns the lecturer\'s subjects (plus unscoped rows)', async () => {
  const service = questionService(QUESTIONS);
  assert.deepEqual((await service.listQuestions({}, L1)).map((q) => q.id), [1, 3]);
  assert.deepEqual((await service.listQuestions({}, L2)).map((q) => q.id), [2, 3]);
  assert.deepEqual((await service.listQuestions({}, ADMIN)).map((q) => q.id), [1, 2, 3]);
});

test('question reads and writes outside the lecturer\'s subject are 403', async () => {
  const service = questionService(QUESTIONS);
  await assert.rejects(() => service.getQuestionById(2, L1), forbidden);
  await assert.rejects(() => service.updateQuestion(2, { content: 'tamper' }, L1), forbidden);
  await assert.rejects(() => service.deleteQuestion(2, L1), forbidden);
  await assert.rejects(() => service.approve(2, { user: L1 }), forbidden);
  await assert.rejects(() => service.reject(2, { reason: 'x', user: L1 }), forbidden);
  await assert.rejects(() => service.archive(2, { user: L1 }), forbidden);
  await assert.rejects(() => service.getQuestionSources(2, L1), forbidden);
  await assert.rejects(
    () => service.createQuestion({ topicId: 2, content: 'sneaky', language: 'en' }, L1),
    forbidden,
  );
  // Moving a question into someone else's topic is also blocked.
  await assert.rejects(() => service.updateQuestion(1, { topicId: 2 }, L1), forbidden);
  assert.equal((await service.getQuestionById(1, L1)).id, 1);
});

test('approveBatch rejects the whole batch when any question is out of scope', async () => {
  const service = questionService(QUESTIONS);
  const rubricRepository = { async findById() { return { rubric_id: 5, subject_id: null }; } };
  service.rubricRepository = rubricRepository;
  await assert.rejects(
    () => service.approveBatch({ questionIds: [1, 2], rubricId: 5, user: L1 }),
    forbidden,
  );
});

function rubricService() {
  const rows = [
    { rubric_id: 1, subject_id: 10, max_score: 10, criteria: [] },
    { rubric_id: 2, subject_id: 20, max_score: 10, criteria: [] },
    { rubric_id: 3, subject_id: null, max_score: 10, criteria: [] },
  ];
  const repository = {
    async findAll() { return rows; },
    async findById(id) { return rows.find((r) => r.rubric_id === id) || null; },
    async clone(id) { return rows.find((r) => r.rubric_id === id); },
    async countQuestionsUsingRubric() { return 0; },
    async deleteById(id) { return rows.find((r) => r.rubric_id === id); },
  };
  return new RubricService({ repository, subjectScope });
}

test('rubrics are filtered and guarded by subject', async () => {
  const service = rubricService();
  assert.deepEqual((await service.listRubrics(L1)).map((r) => r.id), [1, 3]);
  await assert.rejects(() => service.getRubricById(2, L1), forbidden);
  await assert.rejects(() => service.updateRubric(2, { maxScore: 5 }, L1), forbidden);
  await assert.rejects(() => service.cloneRubric(2, L1), forbidden);
  await assert.rejects(() => service.deleteRubric(2, L1), forbidden);
  await assert.rejects(
    () => service.createRubric({ maxScore: 10, subjectId: 20, criteria: [{ name: 'a', weightPercent: 100 }] }, L1),
    forbidden,
  );
  assert.equal((await service.getRubricById(2, ADMIN)).id, 2);
});

test('getJob is scoped through the job\'s topic', async () => {
  const jobs = { 1: { question_generation_job_id: 1, topic_id: 1 }, 2: { question_generation_job_id: 2, topic_id: 2 } };
  const service = new QuestionGenerationService({
    questionGenerationJobRepository: { async findById(id) { return jobs[id] || null; } },
    topicRepository,
    subjectRepository,
  });
  assert.equal((await service.getJob({ user: L1, jobId: 1 })).question_generation_job_id, 1);
  await assert.rejects(() => service.getJob({ user: L1, jobId: 2 }), forbidden);
  await assert.rejects(() => service.getJob({ user: L1, jobId: 9 }), (e) => e.statusCode === 404);
  assert.equal((await service.getJob({ user: ADMIN, jobId: 2 })).topic_id, 2);
});
