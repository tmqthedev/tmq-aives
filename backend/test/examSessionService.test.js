const test = require('node:test');
const assert = require('node:assert/strict');
const { ExamSessionService } = require('../src/services/examSessionService');
const { seededRandom, fixedClock } = require('./helpers/interviewFakes');

const SUBJECT_ID = 7;
const TOPIC_ID = 11;
const LECTURER_ID = 1;

const lecturer = { id: LECTURER_ID, role: 'LECTURER' };
const admin = { id: 99, role: 'ADMIN' };

// --- In-memory fakes (no mock DB; exam_session SQL is unsupported there) -----

class FakeExamSessionRepo {
  constructor() {
    this.rows = new Map();
    this.students = new Map(); // sessionId -> number[]
    this.examiners = new Map(); // sessionId -> number[]
    this.nextId = 1;
    // One approved (English) question so createSession can derive the exam
    // language; tests that need a specific bank overwrite this.
    this.approvedQuestionIds = [101];
    // Step 12: bank rows with Bloom levels; falls back to approvedQuestionIds.
    this.approvedQuestions = null;
  }

  async create(payload) {
    const id = this.nextId++;
    const row = {
      exam_session_id: id,
      subject_id: payload.subjectId ?? null,
      topic_id: payload.topicId ?? null,
      title: payload.title ?? null,
      language: payload.language ?? null,
      main_question_count: payload.mainQuestionCount ?? null,
      max_follow_ups_per_question: payload.maxFollowUpsPerQuestion ?? null,
      answer_time_limit_sec: payload.answerTimeLimitSec ?? null,
      think_time_sec: payload.thinkTimeSec ?? null,
      session_time_limit_sec: payload.sessionTimeLimitSec ?? 1800,
      opens_at: payload.opensAt ?? null,
      closes_at: payload.closesAt ?? null,
      status: payload.status ?? 'DRAFT',
      created_by: payload.createdBy ?? null,
      max_follow_ups_total: payload.maxFollowUpsTotal ?? null,
      bloom_distribution: payload.bloomDistribution ?? null,
      scheduled_at: null,
      scheduled_by: null,
      started_at: null,
      started_by: null,
      warm_status: null,
    };
    this.rows.set(id, row);
    return row;
  }

  async findById(id) {
    return this.rows.get(Number(id)) || null;
  }

  async list() {
    return [...this.rows.values()];
  }

  async listByCreator(createdBy) {
    return [...this.rows.values()].filter((r) => Number(r.created_by) === Number(createdBy));
  }

  async listBySubjectIds(ids) {
    const set = new Set(ids.map(Number));
    return [...this.rows.values()].filter((r) => set.has(Number(r.subject_id)));
  }

  async update(id, patch) {
    const row = this.rows.get(Number(id));
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  }

  async findByIdWithParticipants(id) {
    const row = this.rows.get(Number(id));
    if (!row) return null;
    return {
      ...row,
      students: (this.students.get(Number(id)) || []).map((sid) => ({
        student_id: sid,
        code: `S${sid}`,
        full_name: `Student ${sid}`,
      })),
      examiners: (this.examiners.get(Number(id)) || []).map((lid) => ({
        lecturer_id: lid,
        code: `L${lid}`,
        full_name: `Lecturer ${lid}`,
      })),
    };
  }

  async setStudents(id, studentIds) {
    this.students.set(Number(id), [...studentIds]);
    return [...studentIds];
  }

  async setExaminers(id, lecturerIds) {
    this.examiners.set(Number(id), [...lecturerIds]);
    return [...lecturerIds];
  }

  async setStatus(id, status) {
    const row = this.rows.get(Number(id));
    if (!row) return null;
    row.status = status;
    return row;
  }

  async countInterviews(id) {
    return (this.interviewCounts && this.interviewCounts[id]) || 0;
  }

  async remove(id) {
    const row = this.rows.get(Number(id));
    this.rows.delete(Number(id));
    return row || null;
  }

  async transitionStatus(id, fromStatuses, toStatus, patch = {}) {
    const row = this.rows.get(Number(id));
    if (!row || !fromStatuses.includes(row.status)) return null;
    Object.assign(row, patch, { status: toStatus });
    return { ...row };
  }

  async mergeWarmStatus(id, partial) {
    const row = this.rows.get(Number(id));
    if (!row) return null;
    row.warm_status = { ...(row.warm_status || {}), ...partial };
    return { ...row };
  }

  async countApprovedByTopicsAndBloom(topicIds) {
    const list = this.approvedQuestions || [];
    const idSet = new Set(topicIds.map(Number));
    const groups = new Map();
    for (const q of list) {
      const tid = Number(q.topic_id || TOPIC_ID);
      if (idSet.has(tid)) {
        const key = `${tid}:${q.bloom_level}`;
        const cur = groups.get(key) || { topic_id: tid, bloom_level: q.bloom_level, count: 0 };
        cur.count += 1;
        groups.set(key, cur);
      }
    }
    return [...groups.values()];
  }

  async listApprovedQuestionsInTopic() {
    if (this.approvedQuestions) return this.approvedQuestions.map((q) => ({ ...q }));
    return this.approvedQuestionIds.map((id) => ({ question_id: id, bloom_level: null, rubric_id: 55 }));
  }

  async countApprovedQuestionsInTopic() {
    return this.approvedQuestionIds.length;
  }

  async listApprovedQuestionIdsInTopic() {
    return [...this.approvedQuestionIds];
  }
}

function makeService(overrides = {}) {
  const examSessionRepository = overrides.examSessionRepository || new FakeExamSessionRepo();

  const subjectRepository = {
    async listSubjectIdsForLecturer(id) {
      return Number(id) === LECTURER_ID ? (overrides.lecturerSubjects ?? [SUBJECT_ID]) : [];
    },
    async list() {
      return overrides.subjects || [{ subject_id: SUBJECT_ID, code: 'SWD392', name: 'Software Architecture' }];
    },
    async findById(id) {
      const all = overrides.subjects || [{ subject_id: SUBJECT_ID, code: 'SWD392', name: 'Software Architecture' }];
      return all.find((s) => Number(s.subject_id) === Number(id)) || null;
    },
    async listStudents(id) {
      if (overrides.subjectStudents !== undefined) return overrides.subjectStudents;
      return [
        { app_user_id: 101, code: 'S001', full_name: 'Student One', role: 'STUDENT', status: 'ACTIVE' },
        { app_user_id: 102, code: 'S002', full_name: 'Student Two', role: 'STUDENT', status: 'ACTIVE' },
      ];
    },
    async listLecturers(id) {
      if (overrides.subjectLecturers !== undefined) return overrides.subjectLecturers;
      return [
        { app_user_id: 900, code: 'L900', full_name: 'Lecturer 900', role: 'LECTURER', status: 'ACTIVE' },
      ];
    },
    ...(overrides.subjectRepository || {}),
  };
  const topicRepository = {
    async getById(id) {
      if (overrides.topicMissing) return null;
      return { topic_id: Number(id), name: 'Architecture Basics', subject_id: overrides.topicSubjectId ?? SUBJECT_ID };
    },
    async list() {
      return overrides.topics || [
        { topic_id: TOPIC_ID, name: 'Architecture Basics', subject_id: overrides.topicSubjectId ?? SUBJECT_ID },
      ];
    },
    ...(overrides.topicRepository || {}),
  };
  const users = overrides.users || new Map([
    ['S001', { app_user_id: 101, code: 'S001', role: 'STUDENT' }],
    ['S002', { app_user_id: 102, code: 'S002', role: 'STUDENT' }],
    ['L900', { app_user_id: 900, code: 'L900', role: 'LECTURER' }],
  ]);
  const usersById = new Map([...users.values()].map((u) => [u.app_user_id, u]));
  const appUserRepository = {
    async findByCode(code) { return users.get(code) || null; },
    async findById(id) { return usersById.get(Number(id)) || null; },
  };
  const lockedRubrics = [];
  const rubricRepository = {
    async setLocked(rubricId, locked) {
      lockedRubrics.push({ rubricId, locked });
      return { rubric_id: rubricId, is_locked: locked };
    },
  };
  const questionRepository = {
    async findById(id) {
      return { question_id: Number(id), content: `Q${id}`, rubric_id: overrides.rubricIdForQuestions ?? 55 };
    },
  };
  const synthCalls = [];
  const ttsAdapter = {
    async synthesize(args) {
      synthCalls.push(args);
      return { audioKey: `tts/${args.text}.mp3`, cached: false };
    },
  };

  const clock = fixedClock(overrides.now || '2026-05-30T08:00:00.000Z');
  const service = new ExamSessionService({
    examSessionRepository,
    subjectRepository,
    topicRepository,
    appUserRepository,
    rubricRepository,
    questionRepository,
    ttsAdapter,
    examLaunchService: overrides.examLaunchService,
    realtimeBus: overrides.realtimeBus,
    db: null,
    clock,
    logger: overrides.logger || { info() {}, warn() {}, error() {} },
    ...(overrides.random ? { random: overrides.random } : {}),
  });

  return {
    service, examSessionRepository, lockedRubrics, synthCalls, clock,
  };
}

async function seedDraft(service, repo, over = {}) {
  return service.createSession({
    user: lecturer,
    subjectId: SUBJECT_ID,
    topicId: TOPIC_ID,
    language: 'EN',
    ...over,
  });
}

test('exam changes publish only after successful repository writes', async () => {
  const events = [];
  const world = makeService({ realtimeBus: { publish: (entity, payload) => events.push({ entity, ...payload }) } });
  const row = await seedDraft(world.service);
  assert.deepEqual(events, [{
    entity: 'exam', action: 'created', subjectId: SUBJECT_ID,
    examSessionId: row.exam_session_id, status: 'DRAFT',
  }]);
  await assert.rejects(
    world.service.scheduleSession({ user: lecturer, examSessionId: row.exam_session_id }),
    { code: 'VALIDATION_ERROR' },
  );
  assert.equal(events.length, 1);
  await world.service.updateSession({ user: lecturer, examSessionId: row.exam_session_id, title: 'Updated' });
  assert.equal(events.at(-1).action, 'updated');
});

// --- CRUD + config/language validation ---------------------------------------

test('createSession applies Nhom-3 defaults and starts DRAFT', async () => {
  const { service } = makeService();
  const row = await seedDraft(service);
  assert.equal(row.status, 'DRAFT');
  assert.equal(row.main_question_count, 3);
  assert.equal(row.max_follow_ups_per_question, 2);
  assert.equal(row.answer_time_limit_sec, 120);
  assert.equal(row.think_time_sec, 0);
  assert.equal(row.created_by, LECTURER_ID);
  assert.equal(row.language, 'EN');
});

test('createSession ignores a client language and derives it from the bank', async () => {
  const { service, examSessionRepository } = makeService();
  examSessionRepository.approvedQuestions = [
    { question_id: 1, bloom_level: 'REMEMBER', language: 'vi', content: 'Trình bày khái niệm' },
    { question_id: 2, bloom_level: 'APPLY', language: null, content: 'Áp dụng mẫu thiết kế' },
  ];
  const row = await seedDraft(service, null, { language: 'EN' });
  assert.equal(row.language, 'VI');
});

test('createSession rejects a mixed-language bank with MIXED_LANGUAGE_BANK', async () => {
  const { service, examSessionRepository } = makeService();
  examSessionRepository.approvedQuestions = [
    { question_id: 1, bloom_level: 'REMEMBER', language: 'vi', content: 'Trình bày' },
    { question_id: 2, bloom_level: 'REMEMBER', language: 'en', content: 'Explain' },
  ];
  await assert.rejects(
    () => seedDraft(service),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'MIXED_LANGUAGE_BANK');
      assert.deepEqual(error.details.counts, { VI: 1, EN: 1 });
      return true;
    },
  );
});

test('createSession rejects a topic with no approved question', async () => {
  const { service, examSessionRepository } = makeService();
  examSessionRepository.approvedQuestionIds = [];
  await assert.rejects(
    () => seedDraft(service),
    (error) => error.statusCode === 409 && error.code === 'NO_APPROVED_QUESTIONS',
  );
});

test('scheduleSession re-derives the language when the bank changed', async () => {
  const world = makeService({ now: NOW });
  const row = await seedDraft(world.service, null, { opens_at: OPENS, closes_at: CLOSES });
  assert.equal(row.language, 'EN');
  world.examSessionRepository.approvedQuestions = [1, 2, 3].map((id) => ({
    question_id: id, bloom_level: 'REMEMBER', language: 'vi', content: 'Câu hỏi',
  }));
  const scheduled = await world.service.scheduleSession({ user: lecturer, examSessionId: row.exam_session_id });
  assert.equal(scheduled.status, 'SCHEDULED');
  assert.equal((await world.examSessionRepository.findById(row.exam_session_id)).language, 'VI');
});

test('createSession rejects out-of-range config with VALIDATION_ERROR', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => seedDraft(service, null, { main_question_count: 11 }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      return true;
    },
  );
  await assert.rejects(
    () => seedDraft(service, null, { answer_time_limit_sec: 5 }),
    (error) => { assert.equal(error.code, 'VALIDATION_ERROR'); return true; },
  );
});

test('createSession denies an out-of-scope lecturer with 403', async () => {
  const { service } = makeService({ lecturerSubjects: [999] });
  await assert.rejects(
    () => seedDraft(service),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'FORBIDDEN');
      return true;
    },
  );
});

test('createSession rejects an ARCHIVED subject; options hide it', async () => {
  const { service } = makeService({
    subjects: [{ subject_id: SUBJECT_ID, code: 'SWD392', name: 'Software Architecture', status: 'ARCHIVED' }],
  });
  await assert.rejects(
    () => seedDraft(service),
    (error) => error.statusCode === 409 && error.code === 'SUBJECT_ARCHIVED',
  );
  const options = await service.getCreateOptions({ user: lecturer });
  assert.equal(options.subjects.length, 0);
});

test('createSession allows ADMIN regardless of scope', async () => {
  const { service } = makeService({ lecturerSubjects: [] });
  const row = await service.createSession({
    user: admin, subjectId: SUBJECT_ID, topicId: TOPIC_ID, language: 'VI',
  });
  assert.equal(row.status, 'DRAFT');
});

test('updateSession edits a DRAFT and re-validates', async () => {
  const { service, examSessionRepository } = makeService();
  const row = await seedDraft(service);
  const updated = await service.updateSession({
    user: lecturer, examSessionId: row.exam_session_id, title: 'Final', main_question_count: 5,
  });
  assert.equal(updated.title, 'Final');
  assert.equal(updated.main_question_count, 5);
  // Non-DRAFT is rejected.
  await examSessionRepository.setStatus(row.exam_session_id, 'OPEN');
  await assert.rejects(
    () => service.updateSession({ user: lecturer, examSessionId: row.exam_session_id, title: 'X' }),
    (error) => { assert.equal(error.statusCode, 409); return true; },
  );
});

// --- Roster all-or-nothing ----------------------------------------------------

test('setStudents writes nothing when any code is unknown', async () => {
  const { service, examSessionRepository } = makeService();
  const row = await seedDraft(service);
  const result = await service.setStudents({
    user: lecturer, examSessionId: row.exam_session_id, codes: 'S001\nNOPE',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'NOPE');
  assert.equal(examSessionRepository.students.has(row.exam_session_id), false);
});

test('setStudents rejects a non-STUDENT code with zero writes', async () => {
  const { service, examSessionRepository } = makeService();
  const row = await seedDraft(service);
  const result = await service.setStudents({
    user: lecturer, examSessionId: row.exam_session_id, codes: 'S001, L900',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'L900');
  assert.equal(examSessionRepository.students.has(row.exam_session_id), false);
});

test('setStudents happy path writes the roster', async () => {
  const { service, examSessionRepository } = makeService();
  const row = await seedDraft(service);
  const result = await service.setStudents({
    user: lecturer, examSessionId: row.exam_session_id, codes: 'S001\nS002\nS001',
  });
  assert.equal(result.ok, true);
  assert.equal(result.students.length, 2);
  assert.deepEqual(examSessionRepository.students.get(row.exam_session_id), [101, 102]);
});

// --- Examiners ----------------------------------------------------------------

test('setExaminers allows LECTURER ids', async () => {
  const { service, examSessionRepository } = makeService();
  const row = await seedDraft(service);
  const result = await service.setExaminers({
    user: lecturer, examSessionId: row.exam_session_id, lecturerIds: [900],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(examSessionRepository.examiners.get(row.exam_session_id), [900]);
});

test('setExaminers rejects a non-lecturer id', async () => {
  const { service } = makeService();
  const row = await seedDraft(service);
  await assert.rejects(
    () => service.setExaminers({ user: lecturer, examSessionId: row.exam_session_id, lecturerIds: [101] }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      return true;
    },
  );
});

// --- Schedule fields validation (Step 12) ----------------------------------------

const OPENS = '2026-06-01T08:00:00.000Z';
const CLOSES = '2026-06-01T11:00:00.000Z';
const NOW = '2026-05-30T08:00:00.000Z';

function expectCode(code, status) {
  return (error) => {
    if (status) assert.equal(error.statusCode, status);
    assert.equal(error.code, code);
    return true;
  };
}

test('createSession accepts opens_at/closes_at, max_follow_ups_total and bloom_distribution', async () => {
  const { service } = makeService();
  const row = await seedDraft(service, null, {
    opens_at: OPENS,
    closes_at: CLOSES,
    max_follow_ups_total: 4,
    bloom_distribution: { remember: 1, UNDERSTAND: 2, APPLY: 0 },
  });
  assert.equal(row.opens_at, OPENS);
  assert.equal(row.closes_at, CLOSES);
  assert.equal(row.max_follow_ups_total, 4);
  assert.deepEqual(row.bloom_distribution, { REMEMBER: 1, UNDERSTAND: 2 });
  // Omitted -> null (no total cap, bank proportions).
  const plain = await seedDraft(service);
  assert.equal(plain.max_follow_ups_total, null);
  assert.equal(plain.bloom_distribution, null);
});

test('createSession rejects an invalid window, total cap or Bloom mix with VALIDATION_ERROR', async () => {
  const { service } = makeService();
  const bad = [
    { opens_at: CLOSES, closes_at: OPENS },
    { opens_at: OPENS, closes_at: OPENS },
    { opens_at: 'not-a-date' },
    { max_follow_ups_total: 21 },
    { max_follow_ups_total: -1 },
    { max_follow_ups_total: 1.5 },
    { bloom_distribution: { REMEMBER: 2 } }, // sum 2 != 3
    { bloom_distribution: { CREATE: 3 } }, // unknown level
    { bloom_distribution: { REMEMBER: -1, APPLY: 4 } },
    { bloom_distribution: [1, 2] },
  ];
  for (const over of bad) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(() => seedDraft(service, null, over), expectCode('VALIDATION_ERROR', 400), JSON.stringify(over));
  }
});

test('updateSession validates the window against the stored value and keeps Bloom coherent', async () => {
  const { service } = makeService();
  const row = await seedDraft(service, null, { opens_at: OPENS, closes_at: CLOSES, max_follow_ups_total: 4 });
  await assert.rejects(
    () => service.updateSession({ user: lecturer, examSessionId: row.exam_session_id, closes_at: '2026-06-01T07:00:00Z' }),
    expectCode('VALIDATION_ERROR', 400),
  );
  const updated = await service.updateSession({
    user: lecturer,
    examSessionId: row.exam_session_id,
    max_follow_ups_total: null,
    bloom_distribution: { APPLY: 3 },
  });
  assert.equal(updated.max_follow_ups_total, null);
  assert.deepEqual(updated.bloom_distribution, { APPLY: 3 });
  // Changing main_question_count alone would break the stored distribution.
  await assert.rejects(
    () => service.updateSession({ user: lecturer, examSessionId: row.exam_session_id, main_question_count: 4 }),
    expectCode('VALIDATION_ERROR', 400),
  );
  const both = await service.updateSession({
    user: lecturer,
    examSessionId: row.exam_session_id,
    main_question_count: 4,
    bloom_distribution: { APPLY: 2, ANALYZE: 2 },
  });
  assert.equal(both.main_question_count, 4);
});

test('updateSession is DRAFT only: a SCHEDULED session must be withdrawn first', async () => {
  const { service, examSessionRepository } = makeService();
  const row = await seedDraft(service);
  await examSessionRepository.setStatus(row.exam_session_id, 'SCHEDULED');
  await assert.rejects(
    () => service.updateSession({ user: lecturer, examSessionId: row.exam_session_id, title: 'X' }),
    expectCode('INVALID_STATE', 409),
  );
});

// --- Schedule / unschedule --------------------------------------------------------

async function seedSchedulable(world, over = {}) {
  const row = await seedDraft(world.service, null, { opens_at: OPENS, closes_at: CLOSES, ...over });
  return row;
}

test('scheduleSession: DRAFT -> SCHEDULED with scheduled_at/by', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203, 204];
  const row = await seedSchedulable(world);
  const scheduled = await world.service.scheduleSession({ user: lecturer, examSessionId: row.exam_session_id });
  assert.equal(scheduled.status, 'SCHEDULED');
  assert.equal(scheduled.scheduled_at, NOW);
  assert.equal(scheduled.scheduled_by, LECTURER_ID);
});

test('scheduleSession requires a window that has not passed', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const noWindow = await seedDraft(world.service);
  await assert.rejects(
    () => world.service.scheduleSession({ user: lecturer, examSessionId: noWindow.exam_session_id }),
    expectCode('VALIDATION_ERROR', 400),
  );
  const past = await seedDraft(world.service, null, {
    opens_at: '2026-05-01T08:00:00Z', closes_at: '2026-05-01T09:00:00Z',
  });
  await assert.rejects(
    () => world.service.scheduleSession({ user: lecturer, examSessionId: past.exam_session_id }),
    expectCode('VALIDATION_ERROR', 400),
  );
});

test('scheduleSession: NOT_ENOUGH_QUESTIONS in total with details', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestionIds = [201];
  const row = await seedSchedulable(world);
  await assert.rejects(
    () => world.service.scheduleSession({ user: lecturer, examSessionId: row.exam_session_id }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'NOT_ENOUGH_QUESTIONS');
      assert.equal(error.details.required, 3);
      assert.equal(error.details.available, 1);
      return true;
    },
  );
  assert.equal(world.examSessionRepository.rows.get(row.exam_session_id).status, 'DRAFT');
});

test('scheduleSession: NOT_ENOUGH_QUESTIONS per Bloom level of bloom_distribution', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestions = [
    { question_id: 1, bloom_level: 'REMEMBER' },
    { question_id: 2, bloom_level: 'REMEMBER' },
    { question_id: 3, bloom_level: 'REMEMBER' },
    { question_id: 4, bloom_level: 'APPLY' },
  ];
  const row = await seedSchedulable(world, { bloom_distribution: { REMEMBER: 1, APPLY: 2 } });
  await assert.rejects(
    () => world.service.scheduleSession({ user: lecturer, examSessionId: row.exam_session_id }),
    (error) => {
      assert.equal(error.code, 'NOT_ENOUGH_QUESTIONS');
      assert.deepEqual(error.details.byLevel.APPLY, { required: 2, available: 1 });
      assert.deepEqual(error.details.byLevel.REMEMBER, { required: 1, available: 3 });
      return true;
    },
  );
  // Without a target the quota follows the bank, so the same bank is enough.
  const free = await seedSchedulable(world);
  const ok = await world.service.scheduleSession({ user: lecturer, examSessionId: free.exam_session_id });
  assert.equal(ok.status, 'SCHEDULED');
});

test('unscheduleSession: SCHEDULED -> DRAFT; illegal from DRAFT', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const row = await seedSchedulable(world);
  await assert.rejects(
    () => world.service.unscheduleSession({ user: lecturer, examSessionId: row.exam_session_id }),
    expectCode('INVALID_TRANSITION', 409),
  );
  await world.service.scheduleSession({ user: lecturer, examSessionId: row.exam_session_id });
  const back = await world.service.unscheduleSession({ user: lecturer, examSessionId: row.exam_session_id });
  assert.equal(back.status, 'DRAFT');
  assert.equal(back.scheduled_at, null);
});

test('scheduleSession denies an out-of-scope lecturer', async () => {
  const world = makeService({ now: NOW, lecturerSubjects: [SUBJECT_ID] });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const row = await seedSchedulable(world);
  await assert.rejects(
    () => world.service.scheduleSession({ user: { id: 555, role: 'LECTURER' }, examSessionId: row.exam_session_id }),
    expectCode('FORBIDDEN', 403),
  );
});

// --- Admin start ------------------------------------------------------------------

async function seedScheduled(world, over = {}) {
  const row = await seedSchedulable(world, over);
  return world.service.scheduleSession({ user: lecturer, examSessionId: row.exam_session_id });
}

test('startSession: ADMIN only; DRAFT -> 409 INVALID_TRANSITION', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const scheduled = await seedScheduled(world);
  await assert.rejects(
    () => world.service.startSession({ user: lecturer, examSessionId: scheduled.exam_session_id }),
    expectCode('FORBIDDEN', 403),
  );
  const draft = await seedSchedulable(world);
  await assert.rejects(
    () => world.service.startSession({ user: admin, examSessionId: draft.exam_session_id }),
    expectCode('INVALID_TRANSITION', 409),
  );
});

test('startSession: SCHEDULED -> OPEN, started_at/by set, opens_at kept, topic rubrics locked', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestions = [
    { question_id: 1, bloom_level: 'REMEMBER', rubric_id: 55 },
    { question_id: 2, bloom_level: 'APPLY', rubric_id: 56 },
    { question_id: 3, bloom_level: 'APPLY', rubric_id: 56 },
    { question_id: 4, bloom_level: null, rubric_id: null },
  ];
  const scheduled = await seedScheduled(world);
  const started = await world.service.startSession({ user: admin, examSessionId: scheduled.exam_session_id });
  assert.equal(started.status, 'OPEN');
  assert.equal(started.started_at, NOW);
  assert.equal(started.started_by, admin.id);
  assert.equal(started.opens_at, OPENS);
  assert.deepEqual(world.lockedRubrics.map((l) => l.rubricId).sort(), [55, 56]);
  assert.ok(world.lockedRubrics.every((l) => l.locked === true));
  // The old blocking per-question TTS loop is gone.
  assert.equal(world.synthCalls.length, 0);
});

test('startSession: window passed -> 409 EXAM_WINDOW_PASSED, nothing changes', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const scheduled = await seedScheduled(world);
  world.clock.set(CLOSES);
  await assert.rejects(
    () => world.service.startSession({ user: admin, examSessionId: scheduled.exam_session_id }),
    expectCode('EXAM_WINDOW_PASSED', 409),
  );
  assert.equal(world.examSessionRepository.rows.get(scheduled.exam_session_id).status, 'SCHEDULED');
});

test('startSession: re-checks the bank (questions archived after scheduling)', async () => {
  const world = makeService({ now: NOW });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const scheduled = await seedScheduled(world);
  world.examSessionRepository.approvedQuestionIds = [201];
  await assert.rejects(
    () => world.service.startSession({ user: admin, examSessionId: scheduled.exam_session_id }),
    expectCode('NOT_ENOUGH_QUESTIONS', 409),
  );
});

test('startSession does not await the launch (warm-up) and survives its failure', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const launches = [];
  const errors = [];
  const examLaunchService = {
    async launch(session) {
      launches.push(session.exam_session_id);
      await gate;
      throw new Error('lambda down');
    },
  };
  const world = makeService({
    now: NOW,
    examLaunchService,
    logger: { info() {}, warn() {}, error(obj) { errors.push(obj); } },
  });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const scheduled = await seedScheduled(world);
  const started = await world.service.startSession({ user: admin, examSessionId: scheduled.exam_session_id });
  // Returned while the launch is still pending.
  assert.equal(started.status, 'OPEN');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(launches, [scheduled.exam_session_id]);
  release();
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(errors.length, 1);
  assert.equal(world.examSessionRepository.rows.get(scheduled.exam_session_id).status, 'OPEN');
});

test('warmSession: ADMIN re-warm returns warm_status; DRAFT -> 409', async () => {
  const examLaunchService = {
    async launch() {},
    async warm() { return { stt: { ok: true }, tts: { ok: true } }; },
  };
  const world = makeService({ now: NOW, examLaunchService });
  world.examSessionRepository.approvedQuestionIds = [201, 202, 203];
  const scheduled = await seedScheduled(world);
  const warm = await world.service.warmSession({ user: admin, examSessionId: scheduled.exam_session_id });
  assert.equal(warm.stt.ok, true);
  const draft = await seedSchedulable(world);
  await assert.rejects(
    () => world.service.warmSession({ user: admin, examSessionId: draft.exam_session_id }),
    expectCode('INVALID_STATE', 409),
  );
  await assert.rejects(
    () => world.service.warmSession({ user: lecturer, examSessionId: scheduled.exam_session_id }),
    expectCode('FORBIDDEN', 403),
  );
});

// --- Close ------------------------------------------------------------------------

test('closeSession: OPEN -> CLOSED by the lecturer; early close moves closes_at to now', async () => {
  const world = makeService({ now: NOW });
  const row = await seedDraft(world.service, null, { opens_at: OPENS, closes_at: CLOSES });
  await world.examSessionRepository.setStatus(row.exam_session_id, 'OPEN');
  world.clock.set('2026-06-01T09:00:00.000Z');
  const closed = await world.service.closeSession({ user: lecturer, examSessionId: row.exam_session_id });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closes_at, '2026-06-01T09:00:00.000Z');
});

test('closeSession: ADMIN may close; a late close keeps the scheduled closes_at', async () => {
  const world = makeService({ now: NOW, lecturerSubjects: [] });
  const row = await world.service.createSession({
    user: admin, subjectId: SUBJECT_ID, topicId: TOPIC_ID, language: 'VI', opens_at: OPENS, closes_at: CLOSES,
  });
  await world.examSessionRepository.setStatus(row.exam_session_id, 'OPEN');
  world.clock.set('2026-06-01T12:00:00.000Z');
  const closed = await world.service.closeSession({ user: admin, examSessionId: row.exam_session_id });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closes_at, CLOSES);
});

test('closeSession: illegal from SCHEDULED / DRAFT', async () => {
  const world = makeService({ now: NOW });
  const row = await seedDraft(world.service);
  await assert.rejects(
    () => world.service.closeSession({ user: admin, examSessionId: row.exam_session_id }),
    expectCode('INVALID_TRANSITION', 409),
  );
  await world.examSessionRepository.setStatus(row.exam_session_id, 'SCHEDULED');
  await assert.rejects(
    () => world.service.closeSession({ user: lecturer, examSessionId: row.exam_session_id }),
    expectCode('INVALID_TRANSITION', 409),
  );
});

// --- Admin schedule list ----------------------------------------------------------

test('listScheduleForAdmin: defaults to non-DRAFT statuses and validates filters', async () => {
  const world = makeService({ now: NOW });
  const calls = [];
  world.examSessionRepository.listSchedule = async (filters) => { calls.push(filters); return []; };
  assert.deepEqual(await world.service.listScheduleForAdmin({ user: admin }), []);
  assert.deepEqual(calls[0], {
    statuses: ['SCHEDULED', 'OPEN', 'CLOSED'], subjectId: null, from: null, to: null,
  });
  await world.service.listScheduleForAdmin({
    user: admin, status: 'open,scheduled', subjectId: '7', from: OPENS, to: CLOSES,
  });
  assert.deepEqual(calls[1], {
    statuses: ['OPEN', 'SCHEDULED'], subjectId: 7, from: OPENS, to: CLOSES,
  });
  await assert.rejects(
    () => world.service.listScheduleForAdmin({ user: admin, status: 'NOPE' }),
    expectCode('VALIDATION_ERROR', 400),
  );
  await assert.rejects(
    () => world.service.listScheduleForAdmin({ user: admin, from: CLOSES, to: OPENS }),
    expectCode('VALIDATION_ERROR', 400),
  );
  await assert.rejects(
    () => world.service.listScheduleForAdmin({ user: lecturer }),
    expectCode('FORBIDDEN', 403),
  );
});

// --- pickMainQuestions --------------------------------------------------------

test('pickMainQuestions returns `count` distinct APPROVED ids from the topic', async () => {
  const { service, examSessionRepository } = makeService();
  examSessionRepository.approvedQuestionIds = [1, 2, 3, 4, 5];
  const picked = await service.pickMainQuestions(TOPIC_ID, 3);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3);
  picked.forEach((id) => assert.ok([1, 2, 3, 4, 5].includes(id)));
});

test('pickMainQuestions is deterministic with an injected seeded random', async () => {
  const approved = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const pick = async (seed) => {
    const { service, examSessionRepository } = makeService({ random: seededRandom(seed) });
    examSessionRepository.approvedQuestionIds = approved;
    return service.pickMainQuestions(TOPIC_ID, 4);
  };
  const a1 = await pick(42);
  const a2 = await pick(42);
  const b = await pick(7);
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  [...a1, ...b].forEach((id) => assert.ok(approved.includes(id)));
});

// --- session_time_limit_sec (Step 6) -------------------------------------------

test('createSession defaults session_time_limit_sec to 1800', async () => {
  const { service } = makeService();
  const row = await seedDraft(service);
  assert.equal(row.session_time_limit_sec, 1800);
});

test('createSession accepts an in-range session_time_limit_sec', async () => {
  const { service } = makeService();
  const row = await seedDraft(service, null, { session_time_limit_sec: 600 });
  assert.equal(row.session_time_limit_sec, 600);
});

test('createSession rejects session_time_limit_sec outside 60..14400', async () => {
  const { service } = makeService();
  for (const bad of [59, 14401, 0, -5, 90.5, 'abc']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => seedDraft(service, null, { session_time_limit_sec: bad }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  }
});

test('updateSession accepts session_time_limit_sec 900 and rejects 59', async () => {
  const { service } = makeService();
  const row = await seedDraft(service);
  const updated = await service.updateSession({
    user: lecturer, examSessionId: row.exam_session_id, session_time_limit_sec: 900,
  });
  assert.equal(updated.session_time_limit_sec, 900);
  await assert.rejects(
    () => service.updateSession({
      user: lecturer, examSessionId: row.exam_session_id, session_time_limit_sec: 59,
    }),
    (error) => { assert.equal(error.code, 'VALIDATION_ERROR'); return true; },
  );
});

// --- Step 13: Exam Session Options & Subject-scoped Roster/Examiners --------

test('getCreateOptions returns scoped subjects, topics with bloom count, students and lecturers', async () => {
  const { service, examSessionRepository } = makeService();
  examSessionRepository.approvedQuestions = [
    { question_id: 1, bloom_level: 'REMEMBER', rubric_id: 55 },
    { question_id: 2, bloom_level: 'UNDERSTAND', rubric_id: 55 },
    { question_id: 3, bloom_level: 'REMEMBER', rubric_id: 55 },
  ];

  const res = await service.getCreateOptions({ user: lecturer });
  assert.equal(res.subjects.length, 1);
  const sub = res.subjects[0];
  assert.equal(sub.subject_id, SUBJECT_ID);
  assert.equal(sub.code, 'SWD392');
  assert.equal(sub.topics.length, 1);
  assert.equal(sub.topics[0].approved, 3);
  assert.equal(sub.topics[0].byBloom.REMEMBER, 2);
  assert.equal(sub.topics[0].byBloom.UNDERSTAND, 1);
  assert.equal(sub.students.length, 2);
  assert.equal(sub.students[0].code, 'S001');
  assert.equal(sub.lecturers.length, 1);
  assert.equal(sub.lecturers[0].code, 'L900');
});

test('getCreateOptions rejects unauthenticated request with 401', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.getCreateOptions(),
    (err) => { assert.equal(err.statusCode, 401); assert.equal(err.code, 'UNAUTHORIZED'); return true; }
  );
});

test('getCreateOptions rejects non-lecturer with 403', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.getCreateOptions({ user: { id: 1, role: 'ADMIN' } }),
    (err) => { assert.equal(err.statusCode, 403); assert.equal(err.code, 'FORBIDDEN'); return true; }
  );
  await assert.rejects(
    () => service.getCreateOptions({ user: { id: 101, role: 'STUDENT' } }),
    (err) => { assert.equal(err.statusCode, 403); assert.equal(err.code, 'FORBIDDEN'); return true; }
  );
});

test('getCreateOptions filters lecturers by role=LECTURER and status=ACTIVE', async () => {
  const { service } = makeService({
    subjectLecturers: [
      { app_user_id: 900, code: 'L900', full_name: 'Lecturer 900', role: 'LECTURER', status: 'ACTIVE' },
      { app_user_id: 901, code: 'L901', full_name: 'Lecturer Inactive', role: 'LECTURER', status: 'INACTIVE' },
      { app_user_id: 902, code: 'L902', full_name: 'Not A Lecturer', role: 'STUDENT', status: 'ACTIVE' },
    ],
  });
  const res = await service.getCreateOptions({ user: lecturer });
  assert.equal(res.subjects[0].lecturers.length, 1);
  assert.equal(res.subjects[0].lecturers[0].code, 'L900');
});

test('setStudents rejects with VALIDATION_ERROR when neither studentIds nor codes is provided', async () => {
  const { service } = makeService();
  const draft = await seedDraft(service);
  await assert.rejects(
    () => service.setStudents({ user: lecturer, examSessionId: draft.exam_session_id }),
    (err) => { assert.equal(err.statusCode, 400); assert.equal(err.code, 'VALIDATION_ERROR'); return true; }
  );
  await assert.rejects(
    () => service.setStudents({ user: lecturer, examSessionId: draft.exam_session_id, studentIds: 'not-an-array' }),
    (err) => { assert.equal(err.statusCode, 400); assert.equal(err.code, 'VALIDATION_ERROR'); return true; }
  );
});

test('setStudents accepts studentIds when students are enrolled in the exam subject', async () => {
  const { service } = makeService();
  const draft = await seedDraft(service);
  const res = await service.setStudents({
    user: lecturer,
    examSessionId: draft.exam_session_id,
    studentIds: [101, 102],
  });
  assert.equal(res.ok, true);
  assert.equal(res.students.length, 2);
  assert.equal(res.students[0].id, 101);
});

test('setStudents rejects studentIds when a student is not enrolled in the subject', async () => {
  const { service } = makeService({
    users: new Map([
      ['S001', { app_user_id: 101, code: 'S001', role: 'STUDENT', status: 'ACTIVE' }],
      ['S003', { app_user_id: 103, code: 'S003', role: 'STUDENT', status: 'ACTIVE' }],
    ]),
    subjectStudents: [
      { app_user_id: 101, code: 'S001', role: 'STUDENT', status: 'ACTIVE' },
    ],
  });
  const draft = await seedDraft(service);
  const res = await service.setStudents({
    user: lecturer,
    examSessionId: draft.exam_session_id,
    studentIds: [101, 103],
  });
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].error, /not enrolled/);
});

test('setStudents rejects codes when student is not enrolled in the subject', async () => {
  const { service } = makeService({
    users: new Map([
      ['S001', { app_user_id: 101, code: 'S001', role: 'STUDENT', status: 'ACTIVE' }],
      ['S003', { app_user_id: 103, code: 'S003', role: 'STUDENT', status: 'ACTIVE' }],
    ]),
    subjectStudents: [
      { app_user_id: 101, code: 'S001', role: 'STUDENT', status: 'ACTIVE' },
    ],
  });
  const draft = await seedDraft(service);
  const res = await service.setStudents({
    user: lecturer,
    examSessionId: draft.exam_session_id,
    codes: 'S001, S003',
  });
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'S003');
  assert.match(res.errors[0].error, /not enrolled/);
});

test('setExaminers rejects lecturer not assigned to the subject', async () => {
  const { service } = makeService({
    users: new Map([
      ['L900', { app_user_id: 900, code: 'L900', role: 'LECTURER', status: 'ACTIVE' }],
      ['L901', { app_user_id: 901, code: 'L901', role: 'LECTURER', status: 'ACTIVE' }],
    ]),
    subjectLecturers: [
      { app_user_id: 900, code: 'L900', role: 'LECTURER', status: 'ACTIVE' },
    ],
  });
  const draft = await seedDraft(service);
  await assert.rejects(
    () => service.setExaminers({
      user: lecturer,
      examSessionId: draft.exam_session_id,
      lecturerIds: [900, 901],
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.match(err.message, /not assigned to this subject/);
      return true;
    },
  );
});

test('setExaminers accepts lecturer assigned to the subject', async () => {
  const { service } = makeService();
  const draft = await seedDraft(service);
  const res = await service.setExaminers({
    user: lecturer,
    examSessionId: draft.exam_session_id,
    lecturerIds: [900],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.examiners, [900]);
});

// --- Step 14: delete an unused session ---------------------------------------

test('deleteSession removes a DRAFT/SCHEDULED session nobody has started', async () => {
  const { service, examSessionRepository } = makeService();
  const row = await seedDraft(service);
  const res = await service.deleteSession({ user: admin, examSessionId: row.exam_session_id });
  assert.equal(res.ok, true);
  assert.equal(await examSessionRepository.findById(row.exam_session_id), null);
});

test('deleteSession refuses OPEN/CLOSED sessions and ones with interviews (SESSION_IN_USE)', async () => {
  const { service, examSessionRepository } = makeService();
  const open = await seedDraft(service);
  await examSessionRepository.setStatus(open.exam_session_id, 'OPEN');
  await assert.rejects(
    () => service.deleteSession({ user: admin, examSessionId: open.exam_session_id }),
    (err) => err.statusCode === 409 && err.code === 'SESSION_IN_USE' && err.details.status === 'OPEN',
  );
  const started = await seedDraft(service);
  examSessionRepository.interviewCounts = { [started.exam_session_id]: 1 };
  await assert.rejects(
    () => service.deleteSession({ user: admin, examSessionId: started.exam_session_id }),
    (err) => err.code === 'SESSION_IN_USE' && err.details.interviews === 1,
  );
});

test('deleteSession is subject-scoped for lecturers', async () => {
  const { service } = makeService();
  const row = await seedDraft(service);
  const other = makeService({ lecturerSubjects: [999] });
  other.examSessionRepository.rows.set(row.exam_session_id, { ...row });
  await assert.rejects(
    () => other.service.deleteSession({ user: lecturer, examSessionId: row.exam_session_id }),
    (err) => err.statusCode === 403,
  );
});

test('getLecturerProgress maps per-subject counts and is lecturer-only', async () => {
  const { service, examSessionRepository } = makeService();
  examSessionRepository.getLecturerProgress = async (id) => {
    assert.equal(id, lecturer.id);
    return [{
      subject_id: 1, code: 'SWD', name: 'SA', topics: 2, ready_materials: '1', rubrics: 0,
      approved_questions: 5, pending_questions: 3, scheduled_exams: 0, results_to_review: 4,
    }];
  };
  const { subjects } = await service.getLecturerProgress({ user: lecturer });
  assert.deepEqual(subjects[0], {
    subjectId: 1, code: 'SWD', name: 'SA', topics: 2, readyMaterials: 1, rubrics: 0,
    approvedQuestions: 5, pendingQuestions: 3, scheduledExams: 0, resultsToReview: 4,
  });
  await assert.rejects(() => service.getLecturerProgress({ user: admin }), (err) => err.statusCode === 403);
});
