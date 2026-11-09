// Shared test helpers for the Step 6 interview engine. InMemoryDatabase cannot
// run the engine SQL, so engine tests use these in-memory repositories over
// shared Maps. They mirror the real repositories' method signatures and the
// semantics that matter (conditional status claims, unique keys, idempotent
// upserts). Rows are copied in and out so the service cannot mutate "DB" state
// by reference (JSONB snapshot semantics).

const { InterviewService } = require('../../src/services/interviewService');
const { SessionContextStore } = require('../../src/interview/sessionContextStore');
const { InMemorySessionStore } = require('../../src/services/awsClients');
const { MockSttAdapter } = require('../../src/stt/mockSttAdapter');
const { MockLlmAdapter } = require('../../src/llm/mockLlmAdapter');

// mulberry32: tiny seeded PRNG so random selection is reproducible in tests.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Controllable clock: clock() returns the current fake time.
function fixedClock(startIso) {
  let nowMs = Date.parse(startIso);
  const clock = () => new Date(nowMs);
  clock.advance = (ms) => { nowMs += ms; return clock(); };
  clock.set = (iso) => { nowMs = Date.parse(iso); return clock(); };
  return clock;
}

const copy = (row) => (row == null ? row : structuredClone(row));
const uniqueViolation = (constraint) => {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  err.code = '23505';
  return err;
};

class FakeInterviewDb {
  constructor() {
    this.exams = new Map();
    this.rosters = new Map(); // examId -> Set<studentId>
    this.questions = new Map();
    this.sourceRefs = new Map(); // questionId -> [{ chunkId, excerpt, materialTitle, location, content }]
    this.rubrics = new Map();
    this.lockedRubrics = new Set();
    this.interviews = new Map();
    this.assigned = new Map();
    this.turns = new Map();
    this.transcripts = new Map(); // interviewId -> row
    this.failures = [];
    this.results = new Map(); // interviewId -> row
    this.seq = 1;
    this.hooks = {};
    this.examLocks = []; // examIds passed to lockForUpdate (Step 12)
    this._build();
  }

  nextId() {
    this.seq += 1;
    return this.seq;
  }

  turnsOf(interviewId) {
    return [...this.turns.values()]
      .filter((t) => t.interview_id === interviewId)
      .sort((a, b) => a.sequence_no - b.sequence_no);
  }

  _build() {
    const db = this;
    this.examSessionRepository = {
      async findById(id) { return copy(db.exams.get(Number(id)) || null); },
      // No real row lock in memory; recorded so tests can assert it is taken.
      async lockForUpdate(id) {
        db.examLocks.push(Number(id));
        return copy(db.exams.get(Number(id)) || null);
      },
      async listApprovedQuestionsInTopic(topicId) {
        return [...db.questions.values()]
          .filter((q) => q.topic_id === topicId && q.status === 'APPROVED')
          .sort((a, b) => a.question_id - b.question_id)
          .map((q) => ({
            question_id: q.question_id,
            bloom_level: q.bloom_level ?? null,
            rubric_id: q.rubric_id ?? null,
            content: q.content,
            language: q.language ?? null,
          }));
      },
      async listApprovedQuestionIdsInTopic(topicId) {
        return [...db.questions.values()]
          .filter((q) => q.topic_id === topicId && q.status === 'APPROVED')
          .map((q) => q.question_id)
          .sort((a, b) => a - b);
      },
      async isStudentOnRoster(examId, studentId) {
        return (db.rosters.get(Number(examId)) || new Set()).has(Number(studentId));
      },
    };

    this.questionRepository = {
      async findByIdForUpdate(id) { return copy(db.questions.get(Number(id)) || null); },
      async findById(id) { return copy(db.questions.get(Number(id)) || null); },
    };
    this.questionSourceRefRepository = {
      async listByQuestionWithMaterial(questionId) { return copy(db.sourceRefs.get(Number(questionId)) || []); },
    };
    this.rubricRepository = {
      async findById(id) { return copy(db.rubrics.get(Number(id)) || null); },
      async setLocked(id, locked) {
        if (locked) db.lockedRubrics.add(Number(id));
        else db.lockedRubrics.delete(Number(id));
        return { rubric_id: id, is_locked: locked };
      },
    };

    this.vivaInterviewRepository = {
      async create({
        examSessionId, studentId, status, startedAt, deadlineAt, clientIp,
      }) {
        if (db.hooks.beforeInterviewCreate) await db.hooks.beforeInterviewCreate();
        const dup = [...db.interviews.values()]
          .some((i) => i.exam_session_id === examSessionId && i.student_id === studentId);
        if (dup) throw uniqueViolation('uq_viva_interview_exam_student');
        const row = {
          viva_interview_id: db.nextId(),
          exam_session_id: examSessionId,
          student_id: studentId,
          status: status || 'NOT_STARTED',
          current_question_index: 0,
          current_follow_up_count: 0,
          started_at: startedAt ?? null,
          deadline_at: deadlineAt ?? null,
          ended_at: null,
          end_reason: null,
          paused_at: null,
          client_ip: clientIp ?? null,
        };
        db.interviews.set(row.viva_interview_id, row);
        return copy(row);
      },
      async findById(id) { return copy(db.interviews.get(Number(id)) || null); },
      async findByExamAndStudent(examId, studentId) {
        return copy([...db.interviews.values()]
          .find((i) => i.exam_session_id === Number(examId) && i.student_id === Number(studentId)) || null);
      },
      async updateProgress(id, patch) {
        const row = db.interviews.get(Number(id));
        Object.assign(row, patch);
        return copy(row);
      },
      async setStatus(id, status) {
        const row = db.interviews.get(Number(id));
        if (row) row.status = status;
        return copy(row);
      },
      async listOverdueActive({ before, limit = 50 } = {}) {
        const cutoff = before instanceof Date ? before.getTime() : new Date(before).getTime();
        const lim = Number.isInteger(limit) && limit > 0 ? limit : 50;
        return [...db.interviews.values()]
          .filter((i) => ['IN_PROGRESS', 'PAUSED'].includes(i.status) && i.deadline_at && new Date(i.deadline_at).getTime() < cutoff)
          .sort((a, b) => new Date(a.deadline_at).getTime() - new Date(b.deadline_at).getTime())
          .slice(0, lim)
          .map(copy);
      },
      async completeIfActive(id, { endedAt, endReason }) {
        const row = db.interviews.get(Number(id));
        if (!row || !['IN_PROGRESS', 'PAUSED'].includes(row.status)) return null;
        Object.assign(row, { status: 'COMPLETED', ended_at: endedAt, end_reason: endReason });
        return copy(row);
      },
    };

    this.assignedQuestionRepository = {
      async createMany(interviewId, questionIds, _client, snapshots) {
        return questionIds.map((qid, i) => {
          const row = {
            assigned_question_id: db.nextId(),
            interview_id: interviewId,
            question_id: qid,
            knowledge_snapshot: copy(snapshots[i]),
            order_no: i + 1,
            is_asked: false,
          };
          db.assigned.set(row.assigned_question_id, row);
          return copy(row);
        });
      },
      async listByInterview(interviewId) {
        return [...db.assigned.values()]
          .filter((a) => a.interview_id === Number(interviewId))
          .sort((a, b) => a.order_no - b.order_no)
          .map(copy);
      },
      async markAsked(id) {
        const row = db.assigned.get(Number(id));
        row.is_asked = true;
        return copy(row);
      },
      // Newest-first question ids of the `limit` latest started interviews.
      async listRecentByExam(examId, limit) {
        return [...db.interviews.values()]
          .filter((i) => i.exam_session_id === Number(examId) && i.started_at != null)
          .sort((a, b) => (new Date(b.started_at) - new Date(a.started_at))
            || (b.viva_interview_id - a.viva_interview_id))
          .slice(0, limit)
          .map((i) => [...db.assigned.values()]
            .filter((a) => a.interview_id === i.viva_interview_id)
            .sort((a, b) => a.order_no - b.order_no)
            .map((a) => a.question_id));
      },
      async countUsageByExam(examId) {
        const ids = new Set([...db.interviews.values()]
          .filter((i) => i.exam_session_id === Number(examId))
          .map((i) => i.viva_interview_id));
        const usage = new Map();
        for (const a of db.assigned.values()) {
          if (ids.has(a.interview_id)) usage.set(a.question_id, (usage.get(a.question_id) || 0) + 1);
        }
        return usage;
      },
    };

    const applyTurnPatch = (row, patch) => {
      for (const [k, v] of Object.entries(patch || {})) {
        if (v !== undefined) row[k] = v;
      }
    };
    this.qaTurnRepository = {
      async create(p) {
        if (db.turnsOf(p.interviewId).some((t) => t.sequence_no === p.sequenceNo)) {
          throw uniqueViolation('uq_qa_turn_sequence');
        }
        const row = {
          qa_turn_id: db.nextId(),
          interview_id: p.interviewId,
          assigned_question_id: p.assignedQuestionId ?? null,
          sequence_no: p.sequenceNo,
          turn_type: p.turnType,
          follow_up_reason: p.followUpReason ?? null,
          question_text: p.questionText ?? null,
          rationale: p.rationale == null ? null : JSON.parse(JSON.stringify(p.rationale)),
          answer_text: null,
          answer_audio_key: null,
          transcript_confidence: null,
          asked_at: p.askedAt ?? null,
          answer_started_at: null,
          answer_ended_at: null,
          timed_out: null,
          status: p.status ?? null,
          question_audio_key: p.questionAudioKey ?? null,
          played_at: null,
          answer_deadline_at: null,
          processing_started_at: p.processingStartedAt ?? null,
          retry_count: p.retryCount ?? p.retry_count ?? 0,
        };
        db.turns.set(row.qa_turn_id, row);
        return copy(row);
      },
      async findById(id) { return copy(db.turns.get(Number(id)) || null); },
      async listByInterview(interviewId) { return db.turnsOf(Number(interviewId)).map(copy); },
      async findLatestByInterview(interviewId) {
        const list = db.turnsOf(Number(interviewId));
        return copy(list[list.length - 1] || null);
      },
      async update(id, patch) {
        const row = db.turns.get(Number(id));
        applyTurnPatch(row, patch);
        return copy(row);
      },
      async transitionStatus(id, fromStatuses, toStatus, patch = {}) {
        const row = db.turns.get(Number(id));
        if (!row || !fromStatuses.includes(row.status)) return null;
        applyTurnPatch(row, patch);
        row.status = toStatus;
        return copy(row);
      },
      async markOpenTurnsUnanswered(interviewId) {
        const changed = [];
        for (const t of db.turnsOf(Number(interviewId))) {
          if (['ASKED', 'ANSWERING'].includes(t.status)) {
            t.status = 'UNANSWERED';
            changed.push(copy(t));
          }
        }
        return changed;
      },
    };

    this.transcriptRepository = {
      async upsert({ interviewId, fullText, isComplete }) {
        const existing = db.transcripts.get(interviewId);
        const row = {
          transcript_id: existing ? existing.transcript_id : db.nextId(),
          interview_id: interviewId,
          full_text: fullText,
          is_complete: isComplete === true,
        };
        db.transcripts.set(interviewId, row);
        return copy(row);
      },
      async findByInterview(interviewId) { return copy(db.transcripts.get(Number(interviewId)) || null); },
    };

    this.processingFailureRepository = {
      async create(p) {
        if (db.hooks.failureCreate) await db.hooks.failureCreate(p);
        const row = {
          processing_failure_id: db.nextId(),
          interview_id: p.interviewId,
          turn_id: p.turnId ?? null,
          stage: p.stage,
          error_code: p.errorCode,
          message: p.message,
          retry_count: p.retryCount ?? 0,
          resolved: false,
        };
        db.failures.push(row);
        return copy(row);
      },
      async listByInterview(interviewId) {
        return db.failures.filter((f) => f.interview_id === Number(interviewId)).map(copy);
      },
    };

    this.vivaResultRepository = {
      async createPendingIfAbsent(interviewId) {
        if (!db.results.has(interviewId)) {
          db.results.set(interviewId, { viva_result_id: db.nextId(), interview_id: interviewId, status: 'PENDING' });
        }
        return copy(db.results.get(interviewId));
      },
      async findByInterviewId(interviewId) {
        return copy(db.results.get(Number(interviewId)) || null);
      },
      async isExaminerOrCreator() {
        return true;
      },
      async listFinalizedForStudent() {
        return [];
      },
      async findFinalizedForStudent() {
        return null;
      },
    };
  }
}

// Scripted LLM: each decideFollowUp call consumes the next script entry.
//   object / string -> returned as the raw decision
//   Error           -> thrown
//   'NEVER'         -> a promise that never settles (timeout path)
//   function        -> called with (input, callIndex); its result is used
//   (script empty)  -> falls back to the deterministic MockLlmAdapter
function scriptedLlm(script = []) {
  const mock = new MockLlmAdapter();
  const llm = {
    calls: [],
    script: [...script],
    async decideFollowUp(input) {
      llm.calls.push(input);
      if (llm.script.length === 0) return mock.decideFollowUp(input);
      const next = llm.script.shift();
      if (next instanceof Error) throw next;
      if (next === 'NEVER') return new Promise(() => {});
      if (typeof next === 'function') return next(input, llm.calls.length - 1);
      return next;
    },
  };
  return llm;
}

function spyTts({ failWith = null } = {}) {
  const tts = {
    calls: [],
    failWith,
    // Optional hook (args, callIndex) — e.g. advance the clock to simulate
    // provider latency.
    onCall: null,
    async synthesize(args) {
      tts.calls.push(args);
      if (typeof tts.onCall === 'function') tts.onCall(args, tts.calls.length - 1);
      if (tts.failWith) throw tts.failWith;
      return { audioKey: `tts/${tts.calls.length}.mp3`, cached: false };
    },
  };
  return tts;
}

function spyS3({ failWith = null } = {}) {
  const s3 = {
    puts: [],
    failWith,
    async putObject(args) {
      if (s3.failWith) throw s3.failWith;
      s3.puts.push(args);
      return { bucket: args.bucket, key: args.key };
    },
  };
  return s3;
}

function recordingEnqueue({ failWith = null } = {}) {
  const enqueue = async (type, payload) => {
    enqueue.jobs.push({ type, payload });
    if (enqueue.failWith) throw enqueue.failWith;
    return { id: enqueue.jobs.length };
  };
  enqueue.jobs = [];
  enqueue.failWith = failWith;
  return enqueue;
}

const START_ISO = '2026-03-01T08:00:00.000Z';
const EXAM_ID = 3;
const STUDENT = { id: 42, role: 'STUDENT' };
const OTHER_STUDENT = { id: 43, role: 'STUDENT' };
const TOPIC_ID = 11;
const KEY_POINTS = ['three-way handshake', 'sequence numbers', 'acknowledgements'];

// Seed a world: an OPEN exam on TOPIC_ID with both students rostered, one AI
// question with a grounded source ref, MANUAL/IMPORT questions, a rubric, plus
// noise (a non-APPROVED question and an APPROVED one in another topic).
// `bloomLevels` (optional) cycles Bloom levels over the APPROVED questions;
// by default every question is UNDERSTAND.
function buildWorld({
  exam: examOver = {},
  approvedCount = 4,
  seed = 1,
  llmScript = [],
  env: envOver = {},
  bloomLevels = null,
} = {}) {
  const db = new FakeInterviewDb();
  const clock = fixedClock(START_ISO);
  db.exams.set(EXAM_ID, {
    exam_session_id: EXAM_ID,
    topic_id: TOPIC_ID,
    language: 'EN',
    status: 'OPEN',
    main_question_count: 3,
    max_follow_ups_per_question: 2,
    answer_time_limit_sec: 120,
    think_time_sec: 5,
    session_time_limit_sec: 1800,
    closes_at: null,
    ...examOver,
  });
  db.rosters.set(EXAM_ID, new Set([STUDENT.id, OTHER_STUDENT.id]));
  db.rubrics.set(5, {
    rubric_id: 5,
    version: 1,
    criteria: [
      { criterion_name: 'Accuracy', weight_percent: '70.00' },
      { criterion_name: 'Clarity', weight_percent: '30.00' },
    ],
  });
  db.rubrics.set(6, { rubric_id: 6, version: 1, criteria: [{ criterion_name: 'Depth', weight_percent: '100' }] });
  const sources = ['AI', 'MANUAL', 'IMPORT', 'MANUAL', 'AI', 'MANUAL', 'MANUAL', 'MANUAL'];
  for (let i = 0; i < approvedCount; i += 1) {
    const qid = 101 + i;
    db.questions.set(qid, {
      question_id: qid,
      topic_id: TOPIC_ID,
      rubric_id: i % 2 === 0 ? 5 : 6,
      content: `Main question ${qid}: explain how TCP provides reliable delivery.`,
      status: 'APPROVED',
      // Same language as the exam: the engine only picks exam-language questions.
      language: String(db.exams.get(EXAM_ID).language || 'EN').toLowerCase(),
      source: sources[i % sources.length],
      bloom_level: bloomLevels ? bloomLevels[i % bloomLevels.length] : 'UNDERSTAND',
      reference_answer: `Reference answer ${qid}: TCP uses a three-way handshake, sequence numbers and acknowledgements.`,
      key_points: [...KEY_POINTS],
      rationale: sources[i % sources.length] === 'AI'
        ? { purpose: `AI purpose ${qid}`, synthesis: `AI synthesis ${qid}`, target: { keyPoints: KEY_POINTS } }
        : null,
    });
    if (sources[i % sources.length] === 'AI') {
      db.sourceRefs.set(qid, [{
        chunkId: 900 + i,
        excerpt: 'connection is established with a three-way handshake',
        materialTitle: 'Networking notes',
        location: 'page 2',
        content: 'A TCP connection is established with a three-way handshake before data transfer.',
      }]);
    }
  }
  db.questions.set(201, {
    question_id: 201, topic_id: TOPIC_ID, rubric_id: 5, content: 'Draft question', status: 'DRAFT', source: 'MANUAL',
  });
  db.questions.set(202, {
    question_id: 202, topic_id: 99, rubric_id: 5, content: 'Other topic', status: 'APPROVED', source: 'MANUAL',
  });

  const sessionStore = new InMemorySessionStore();
  const silent = { info() {}, warn() {}, error() {} };
  const sessionContextStore = new SessionContextStore({
    sessionStore, ttlGraceSec: 3600, clock, logger: silent,
  });
  const llm = scriptedLlm(llmScript);
  const stt = new MockSttAdapter();
  const tts = spyTts();
  const s3 = spyS3();
  const enqueueJob = recordingEnqueue();
  const env = { audioBucket: 'test-audio-bucket', followUpLlmTimeoutMs: 1000, ...envOver };

  const makeService = (over = {}) => new InterviewService({
    db: null,
    examSessionRepository: db.examSessionRepository,
    vivaInterviewRepository: db.vivaInterviewRepository,
    assignedQuestionRepository: db.assignedQuestionRepository,
    qaTurnRepository: db.qaTurnRepository,
    transcriptRepository: db.transcriptRepository,
    processingFailureRepository: db.processingFailureRepository,
    vivaResultRepository: db.vivaResultRepository,
    questionRepository: db.questionRepository,
    questionSourceRefRepository: db.questionSourceRefRepository,
    rubricRepository: db.rubricRepository,
    sessionContextStore,
    sttAdapter: stt,
    ttsAdapter: tts,
    llmAdapter: llm,
    awsClients: s3,
    enqueueJob,
    env,
    clock,
    random: seededRandom(seed),
    logger: silent,
    ...over,
  });

  return {
    db,
    clock,
    sessionStore,
    sessionContextStore,
    llm,
    stt,
    tts,
    s3,
    enqueueJob,
    env,
    makeService,
    service: makeService(),
  };
}

module.exports = {
  seededRandom,
  fixedClock,
  FakeInterviewDb,
  scriptedLlm,
  spyTts,
  spyS3,
  recordingEnqueue,
  buildWorld,
  START_ISO,
  EXAM_ID,
  STUDENT,
  OTHER_STUDENT,
  TOPIC_ID,
  KEY_POINTS,
};
