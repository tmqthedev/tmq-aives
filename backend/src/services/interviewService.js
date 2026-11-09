const { readInterviewQuestion } = require('../interview/knowledgeSnapshot');
// Interview engine (Step 6): runs one student's viva from start to completion.
// ENGINE ONLY: no REST routes and no Socket.IO here; Step 7 wires these public
// methods to the transport. Every public method returns ONLY the student-safe
// view (interview/studentView.js), never a DB row and never rationale.
//
// State: Postgres is the durable record and the source of truth; the DynamoDB
// SessionContext (interview/sessionContextStore.js) holds fast-moving context
// and is rebuilt from Postgres whenever it is missing. The service keeps NO
// in-memory state between calls, so any instance can continue any interview.
//
// Decision order after an answer (interview/decideNextStep.js, spec order):
//   (1) session deadline passed -> end
//   (2) empty answer            -> next main question, no follow-up
//   (3) LLM proposes a follow-up AND follow-ups remain (per question AND, when
//       set, per candidate: max_follow_ups_total) -> ask follow-up
//   (4) otherwise               -> next main question; none left -> end
// A4: an LLM error / timeout / invalid output is retried once; a second
// failure moves on to the next main question and records processing_failure.
// No provider failure ever stops the exam.

const { pickBalancedQuestions, recentWindow } = require('../interview/pickBalancedQuestions');
const { examLanguageOf } = require('../domain/questionLanguage');
const { decideNextStep, shouldConsultLlm, followUpsRemaining } = require('../interview/decideNextStep');
const { parseFollowUpDecision } = require('../interview/followUpDecision');
const { validateGrounding } = require('../interview/groundingValidator');
const {
  buildMainRationale, buildFollowUpRationale, toStringArray, criterionNames,
} = require('../interview/rationaleBuilder');
const { toStudentInterviewView, assertStudentSafe } = require('../interview/studentView');
const { toStudentTranscriptView } = require('../interview/studentTranscriptView');
const {
  ACTIVE_INTERVIEW_STATUSES, ACTIVE_TURN_STATUSES, END_REASONS,
} = require('../domain/interviewStatus');

const DEFAULT_SESSION_TIME_LIMIT_SEC = 1800;
const DEFAULT_MAIN_QUESTION_COUNT = 3;
const DEFAULT_ANSWER_TIME_LIMIT_SEC = 120;
const DEFAULT_TURN_PROCESSING_STALE_SEC = 180;
const MAX_FAILURE_MESSAGE = 500;
const MIN_AUDIO_BYTES = 64;

// Turn statuses that mean the student still has an open question.
const OPEN_TURN_STATUSES = ['ASKED', 'ANSWERING', 'PROCESSING'];

const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function toMs(value) {
  if (value == null) return null;
  const t = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(t) ? null : t;
}

function audioExtension(contentType) {
  if (!contentType) return 'webm';
  const base = String(contentType).split(';')[0].trim().toLowerCase();
  return AUDIO_EXTENSIONS[base] || 'bin';
}

function clampConfidence(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function buildTranscriptText(turns) {
  return turns
    .map((t) => `[${t.turn_type} ${t.sequence_no}] Q: ${t.question_text ?? ''}\nA: ${t.answer_text ?? ''}`)
    .join('\n\n');
}

// Reject when `promise` does not settle within `ms`. The timer is cleared as
// soon as the race settles, so it holds the event loop for at most `ms`. It is
// deliberately NOT unref'd: with a hung provider and no other handles (job
// worker, test runner) an unref'd timer would let the process exit before the
// timeout fires instead of falling back.
function withTimeout(promise, ms, defaultCode = 'LLM_TIMEOUT') {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(httpError(504, defaultCode, `Call exceeded ${ms} ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class InterviewService {
  constructor({
    db,
    examSessionRepository,
    vivaInterviewRepository,
    assignedQuestionRepository,
    qaTurnRepository,
    transcriptRepository,
    processingFailureRepository,
    vivaResultRepository,
    questionRepository,
    questionSourceRefRepository,
    rubricRepository,
    sessionContextStore,
    sttAdapter,
    ttsAdapter,
    llmAdapter,
    awsClients,
    enqueueJob,
    env = {},
    realtimeBus = null,
    clock = () => new Date(),
    random = Math.random,
    logger = console,
  } = {}) {
    this.realtimeBus = realtimeBus;
    this.db = db;
    this.examSessionRepository = examSessionRepository;
    this.vivaInterviewRepository = vivaInterviewRepository;
    this.assignedQuestionRepository = assignedQuestionRepository;
    this.qaTurnRepository = qaTurnRepository;
    this.transcriptRepository = transcriptRepository;
    this.processingFailureRepository = processingFailureRepository;
    this.vivaResultRepository = vivaResultRepository;
    this.questionRepository = questionRepository;
    this.questionSourceRefRepository = questionSourceRefRepository;
    this.rubricRepository = rubricRepository;
    this.sessionContextStore = sessionContextStore;
    this.sttAdapter = sttAdapter;
    this.ttsAdapter = ttsAdapter;
    this.llmAdapter = llmAdapter;
    this.awsClients = awsClients;
    this.enqueueJob = enqueueJob;
    this.env = env;
    this.clock = clock;
    this.random = random;
    this.logger = logger;
  }

  // =========================================================================
  // Public, student-facing API (Step 7 calls these from Socket.IO / REST).
  // =========================================================================

  // Start the student's interview for an exam, or resume the existing one.
  // A student never gets a second attempt: a COMPLETED interview returns its
  // ended view.
  async startOrResume({ user, examSessionId, clientIp } = {}) {
    this._assertStudent(user);
    const examId = this._parseId(examSessionId, 'exam session id');
    const exam = await this.examSessionRepository.findById(examId);
    if (!exam) throw httpError(404, 'EXAM_SESSION_NOT_FOUND', 'Exam session not found.');

    const existing = await this.vivaInterviewRepository.findByExamAndStudent(examId, user.id);
    if (existing) return this._resume(existing, exam);

    if (exam.status !== 'OPEN') {
      throw httpError(409, 'EXAM_NOT_OPEN', 'This exam session is not open.');
    }
    const onRoster = await this.examSessionRepository.isStudentOnRoster(examId, user.id);
    if (!onRoster) {
      throw httpError(403, 'NOT_ON_ROSTER', 'You are not on the roster for this exam session.');
    }

    const startedAt = this.clock();
    // SCHEDULED -> OPEN can happen before the window: students wait for opens_at.
    const opensMs = toMs(exam.opens_at);
    if (opensMs != null && startedAt.getTime() < opensMs) {
      throw httpError(409, 'EXAM_NOT_STARTED', 'This exam session has not started yet.');
    }
    const deadlineAt = this._computeDeadline(startedAt, exam);
    if (deadlineAt.getTime() <= startedAt.getTime()) {
      throw httpError(409, 'EXAM_CLOSED', 'This exam session has already closed.');
    }

    // Per-student balanced pick from ALL APPROVED questions of the topic.
    const required = Number(exam.main_question_count) || DEFAULT_MAIN_QUESTION_COUNT;
    const bank = await this._loadQuestionBank(exam.topic_id, exam.language);
    if (bank.length < required) {
      throw httpError(
        409,
        'NOT_ENOUGH_QUESTIONS',
        `Topic has ${bank.length} APPROVED questions but ${required} are required.`,
      );
    }
    // The STT container should be hot by the time the first answer arrives.
    this._warmSttInBackground(exam.language);

    let created;
    try {
      created = await this._run(async (tx) => {
        // Exam row lock: concurrent starts of this exam serialize here, so each
        // pick sees the previous candidates' assignments (Postgres). The pick,
        // the first-turn preparation and the inserts all run under it; the
        // first question's audio was pre-generated at admin start, so the TTS
        // call is normally a cache hit.
        await this._lockExam(examId, tx);
        const pickedIds = await this._pickMainQuestions(exam, bank, required, tx);
        const lockedQuestions = new Map();
        // Global lock order avoids cross-exam starts taking the same question
        // and rubric locks in opposite random picker order.
        for (const qid of [...pickedIds].sort((a, b) => Number(a) - Number(b))) {
          const question = await this.questionRepository.findByIdForUpdate(qid, tx);
          let points = question?.key_points;
          if (typeof points === 'string') {
            try { points = JSON.parse(points); } catch { points = null; }
          }
          if (!question || question.status !== 'APPROVED'
            || typeof question.reference_answer !== 'string' || !question.reference_answer.trim()
            || !Array.isArray(points) || !points.some((point) => typeof point === 'string' && point.trim())
            || question.rubric_id == null) {
            throw httpError(409, 'QUESTION_INCOMPLETE', 'A selected approved question changed; retry after bank review.');
          }
          const selected = bank.find(q => Number(q.question_id) === Number(qid));
          if (Number(question.topic_id) !== Number(exam.topic_id)
            || examLanguageOf(question) !== String(exam.language).toUpperCase()
            || (selected?.bloom_level ?? null) !== (question.bloom_level ?? null)) {
            throw httpError(409, 'QUESTION_BANK_CHANGED', 'The selected bank changed; retry the interview start.');
          }
          lockedQuestions.set(qid, { ...question, key_points: points });
        }
        const rubricIds = [...new Set([...lockedQuestions.values()].map(q => Number(q.rubric_id)))].sort((a, b) => a - b);
        for (const rubricId of rubricIds) await this.rubricRepository.setLocked(rubricId, true, tx);
        const questions = [];
        for (const qid of pickedIds) {
          const question = lockedQuestions.get(qid);
          const material = await this._loadQuestionMaterial(question, tx);
          if (!material.rubric || !Array.isArray(material.rubric.criteria) || material.rubric.criteria.length === 0) {
            throw httpError(409, 'QUESTION_INCOMPLETE', 'A selected question has no grading rubric criteria.');
          }
          const rubric = material.rubric;
          questions.push(JSON.parse(JSON.stringify({
            snapshot_version: 1, question_id: question.question_id,
            content_version: question.content_version, topic_id: question.topic_id,
            content: question.content, bloom_level: question.bloom_level,
            language: question.language, source: question.source,
            reference_answer: question.reference_answer, key_points: question.key_points,
            rubric_id: question.rubric_id, rationale: question.rationale,
            rubric_snapshot: {
              rubric_id: rubric.rubric_id, version: rubric.version, max_score: rubric.max_score,
              criteria: rubric.criteria.map(c => ({
                rubric_criterion_id: c.rubric_criterion_id, criterion_name: c.criterion_name,
                weight_percent: c.weight_percent, description: c.description, order_index: c.order_index,
                performance_levels: (c.performance_levels || []).map(l => ({
                  performance_level_id: l.performance_level_id, label: l.label,
                  min_score: l.min_score, max_score: l.max_score, description: l.description, order_no: l.order_no,
                })),
              })),
            },
            source_refs_snapshot: material.sourceRefs.map(ref => ({
              chunkId: ref.chunkId, excerpt: ref.excerpt, materialTitle: ref.materialTitle,
              location: ref.location, content: ref.content,
            })),
          })));
        }

        const first = await this._prepareMainTurn(questions[0], exam);
        // Final gate: slow preparation (TTS) must not create an already-expired
        // interview. Same answer as the pre-check above; nothing written yet.
        if (this._deadlinePassed(deadlineAt)) {
          throw httpError(409, 'EXAM_CLOSED', 'This exam session has already closed.');
        }

        const interview = await this.vivaInterviewRepository.create({
          examSessionId: examId,
          studentId: user.id,
          status: 'IN_PROGRESS',
          startedAt,
          deadlineAt,
          clientIp: clientIp ?? null,
        }, tx);
        const interviewId = interview.viva_interview_id;
        const assigned = await this.assignedQuestionRepository.createMany(interviewId, pickedIds, tx, questions);
        const turn = await this.qaTurnRepository.create({
          interviewId,
          assignedQuestionId: assigned[0].assigned_question_id,
          sequenceNo: 1,
          turnType: 'MAIN',
          questionText: first.question.content,
          rationale: first.rationale,
          status: 'ASKED',
          questionAudioKey: first.audioKey,
          askedAt: startedAt,
        }, tx);
        await this.assignedQuestionRepository.markAsked(assigned[0].assigned_question_id, tx);
        return {
          interview, assigned, turn, first,
        };
      });
    } catch (err) {
      // A concurrent start for the same student won the unique key: resume it.
      if (err && err.code === '23505') {
        const winner = await this.vivaInterviewRepository.findByExamAndStudent(examId, user.id);
        if (winner) return this._resume(winner, exam);
      }
      throw err;
    }

    const {
      interview, assigned, turn, first,
    } = created;
    if (first.ttsError) {
      await this._recordFailure({
        interviewId: interview.viva_interview_id, turnId: turn.qa_turn_id, stage: 'TTS', error: first.ttsError,
      });
    }
    await this._safeContext(() => this.sessionContextStore.put({
      ...this._contextFromRows(interview, turn),
      coveredKeyPoints: {},
      partialSegments: [],
    }));
    await this._publishInterview(interview, 'created', exam);
    return this._buildView(interview, exam, { currentTurn: turn, totalQuestions: assigned.length });
  }

  // Invalidation only (ids + status). Runs after commit; never throws and
  // never carries answer text. studentUserId is routing-only (stripped on the wire).
  async _publishInterview(interview, action, knownExam = null) {
    if (!this.realtimeBus || !interview) return;
    try {
      const examId = Number(interview.exam_session_id);
      const exam = knownExam || await this.examSessionRepository.findById(examId);
      this.realtimeBus.publish('interview', {
        action,
        interviewId: Number(interview.viva_interview_id),
        examSessionId: examId,
        subjectId: exam?.subject_id ?? null,
        status: interview.status,
        studentUserId: interview.student_id == null ? null : Number(interview.student_id),
      });
    } catch (err) {
      this.logger?.warn?.({ err }, 'interview realtime publish failed');
    }
  }

  async getCurrentState({ user, interviewId } = {}) {
    const { interview, exam } = await this._loadOwned(user, interviewId);
    const current = await this._enforceDeadline(interview);
    if (!this._isActive(current)) return this._buildView(current, exam);

    // Reconnection check (A8): if the active turn's answer window expired while disconnected,
    // auto-submit as timed out and advance according to the decision order.
    const latest = await this.qaTurnRepository.findLatestByInterview(current.viva_interview_id);
    if (latest && latest.status === 'ANSWERING' && latest.answer_deadline_at) {
      const now = this.clock();
      if (now.getTime() >= toMs(latest.answer_deadline_at)) {
        return this.submitAnswer({
          user,
          interviewId: current.viva_interview_id,
          turnId: latest.qa_turn_id,
          transcript: { text: '' },
          timedOut: true,
        });
      }
    }

    return this._resume(current, exam);
  }

  // A5: Pause the interview due to system outage. Time spent PAUSED is compensated.
  async pauseInterview({ user, interviewId, reason = 'SYSTEM_ERROR' } = {}) {
    const { interview, exam } = await this._loadOwned(user, interviewId);
    if (interview.status !== 'IN_PROGRESS') return this._buildView(interview, exam);

    const pausedAt = this.clock();
    const updated = await this._run(async (tx) => {
      await this.vivaInterviewRepository.updateProgress(
        interview.viva_interview_id,
        { paused_at: pausedAt },
        tx,
      );
      return this.vivaInterviewRepository.setStatus(interview.viva_interview_id, 'PAUSED', tx);
    });
    await this._recordFailure({
      interviewId: interview.viva_interview_id,
      stage: 'SYSTEM',
      errorCode: 'INTERVIEW_PAUSED',
      message: reason,
    });
    await this._safeContext(() => this.sessionContextStore.update(interview.viva_interview_id, {
      status: 'PAUSED',
    }));
    return this._buildView(updated, exam);
  }

  // A5: Resume a paused interview. Extends deadline_at by the exact downtime (BR-06).
  async resumeInterview({ user, interviewId } = {}) {
    const { interview, exam } = await this._loadOwned(user, interviewId);
    if (interview.status !== 'PAUSED') return this._buildView(interview, exam);

    const now = this.clock();
    const pausedMs = interview.paused_at ? Math.max(0, now.getTime() - toMs(interview.paused_at)) : 0;
    const newDeadlineAt = new Date(toMs(interview.deadline_at) + pausedMs);

    const updated = await this._run(async (tx) => {
      await this.vivaInterviewRepository.updateProgress(
        interview.viva_interview_id,
        { deadline_at: newDeadlineAt, paused_at: null },
        tx,
      );
      return this.vivaInterviewRepository.setStatus(interview.viva_interview_id, 'IN_PROGRESS', tx);
    });
    await this._safeContext(() => this.sessionContextStore.update(interview.viva_interview_id, {
      status: 'IN_PROGRESS',
      deadlineAt: newDeadlineAt.toISOString(),
    }));
    return this._buildView(updated, exam);
  }

  // The student's client finished playing the question audio: open the answer
  // window. Replaying never extends it (the stored deadline is kept).
  async markQuestionPlayed({ user, interviewId, turnId } = {}) {
    const owned = await this._loadOwned(user, interviewId);
    const { exam } = owned;
    const interview = await this._enforceDeadline(owned.interview);
    if (!this._isActive(interview)) return this._buildView(interview, exam);

    const turn = await this._requireCurrentTurn(interview, turnId);
    if (turn.status === 'ANSWERING') return this._buildView(interview, exam, { currentTurn: turn });
    if (turn.status !== 'ASKED') {
      throw httpError(409, 'TURN_NOT_ACTIVE', 'This question is no longer awaiting an answer.');
    }

    const playedAt = this.clock();
    const windowSec = (Number(exam.think_time_sec) || 0)
      + (Number(exam.answer_time_limit_sec) || DEFAULT_ANSWER_TIME_LIMIT_SEC);
    const answerDeadlineMs = Math.min(
      playedAt.getTime() + windowSec * 1000,
      toMs(interview.deadline_at),
    );
    const answerDeadlineAt = new Date(answerDeadlineMs);
    const updated = await this.qaTurnRepository.transitionStatus(
      turn.qa_turn_id,
      ['ASKED'],
      'ANSWERING',
      { played_at: playedAt, answer_deadline_at: answerDeadlineAt },
    );
    const current = updated || await this.qaTurnRepository.findById(turn.qa_turn_id);
    if (updated) {
      await this._ensureContext(interview, current);
      await this._safeContext(() => this.sessionContextStore.update(interview.viva_interview_id, {
        currentTurnId: current.qa_turn_id,
        answerDeadlineAt: answerDeadlineAt.toISOString(),
      }));
    }
    return this._buildView(interview, exam, { currentTurn: current });
  }

  // Live partial transcript from the client (Step 7 streams these). Stored in
  // the SessionContext only; nothing is echoed back.
  async appendPartialTranscript({
    user, interviewId, turnId, text, confidence,
  } = {}) {
    const owned = await this._loadOwned(user, interviewId);
    const interview = await this._enforceDeadline(owned.interview);
    if (!this._isActive(interview)) return assertStudentSafe({ accepted: false });
    const turn = await this._requireCurrentTurn(interview, turnId);
    if (!ACTIVE_TURN_STATUSES.includes(turn.status)) return assertStudentSafe({ accepted: false });
    await this._ensureContext(interview, turn);
    const segment = await this._safeContext(() => this.sessionContextStore.appendPartialSegment(
      interview.viva_interview_id,
      { turnId: turn.qa_turn_id, text, confidence },
    ));
    return assertStudentSafe({ accepted: !!segment });
  }

  // Submit the answer to the current turn: audio (stored to S3 then STT),
  // a client transcript, or, when neither is given, the partial segments
  // collected so far. Then apply the decision order.
  async submitAnswer({
    user, interviewId, turnId, audio, contentType, transcript, timedOut = false, signals, onTranscribed,
  } = {}) {
    const { interview, exam } = await this._loadOwned(user, interviewId);
    // Already ended (e.g. lazily at the deadline): nothing is accepted.
    if (!this._isActive(interview)) return this._buildView(interview, exam);

    const latest = await this._requireCurrentTurn(interview, turnId);
    if (Number(latest.retry_count) > 0 && this._deadlinePassed(interview.deadline_at)) {
      return this._buildView(await this._enforceDeadline(interview), exam);
    }
    const prevStatus = latest.status;
    const claimedAt = this.clock();
    // Atomic claim: a second submit for the same turn loses here.
    // processing_started_at lets the read paths detect a claim abandoned by a
    // crashed request (TURN_PROCESSING_STALE_SEC).
    const claimed = await this.qaTurnRepository.transitionStatus(
      latest.qa_turn_id,
      ACTIVE_TURN_STATUSES,
      'PROCESSING',
      { processing_started_at: claimedAt },
    );
    if (!claimed) {
      throw httpError(409, 'TURN_NOT_ACTIVE', 'This question has already been answered.');
    }
    const receivedAt = this.clock();

    try {
      return await this._processClaimedAnswer({
        interview,
        exam,
        claimed,
        prevStatus,
        receivedAt,
        audio,
        contentType,
        transcript,
        timedOut,
        signals,
        onTranscribed,
      });
    } catch (err) {
      // The turn never left PROCESSING: release it back to ANSWERING instead of
      // leaving every resubmit at 409 TURN_NOT_ACTIVE. `null` means another
      // path already moved it on (e.g. the intentional STT_FAILED release), so
      // the original error is surfaced. A failed revert still ends in 503; the
      // read-path stale-claim recovery will release the turn later.
      const released = await this._releaseProcessingTurnSafely(interview, exam, claimed, { error: err });
      if (released === null) throw err;
      throw httpError(
        503,
        'TURN_PROCESSING_FAILED',
        'Could not process the answer; please answer again.',
      );
    }
  }

  // Everything after the turn claim: resolve the answer text, persist it and
  // apply the decision order. Extracted so submitAnswer can release the turn
  // when any step fails unexpectedly.
  async _processClaimedAnswer({
    interview, exam, claimed, prevStatus, receivedAt,
    audio, contentType, transcript, timedOut, signals, onTranscribed,
  }) {
    const id = interview.viva_interview_id;
    const ctx = await this._ensureContext(interview, claimed);
    const assigned = await this.assignedQuestionRepository.listByInterview(id);
    const assignedRow = assigned.find(
      (a) => String(a.assigned_question_id) === String(claimed.assigned_question_id),
    );
    const question = readInterviewQuestion(assignedRow);
    const keyPoints = toStringArray(question && question.key_points);

    // --- Resolve the answer text -------------------------------------------
    let answerAudioKey = null;
    let stt;

    const isAudioEmpty = !timedOut && audio && (
      !Buffer.isBuffer(audio)
      || audio.length === 0
    );

    if (isAudioEmpty) {
      if ((Number(claimed.retry_count) || 0) < 1) {
        // A1: Audio rỗng hoặc hỏng do hệ thống -> Cho nói lại 1 lần
        await this._recordFailure({
          interviewId: id,
          turnId: claimed.qa_turn_id,
          stage: 'AUDIO_INPUT',
          errorCode: 'AUDIO_EMPTY_OR_CORRUPT',
          message: 'Audio rỗng hoặc hỏng, cho nói lại 1 lần.',
          retryCount: 0,
        });
        const windowSec = Number(exam.answer_time_limit_sec) || DEFAULT_ANSWER_TIME_LIMIT_SEC;
        const retryDeadlineMs = Math.min(
          receivedAt.getTime() + windowSec * 1000,
          toMs(interview.deadline_at),
        );
        const retryTurn = await this.qaTurnRepository.transitionStatus(
          claimed.qa_turn_id,
          ['PROCESSING'],
          'ANSWERING',
          {
            retry_count: (Number(claimed.retry_count) || 0) + 1,
            answer_deadline_at: new Date(retryDeadlineMs),
          },
        );
        return this._buildView(interview, exam, {
          currentTurn: retryTurn || claimed,
          totalQuestions: assigned.length,
          retryPrompt: 'Audio rỗng hoặc không rõ, bạn được nói lại 1 lần.',
        });
      }

      await this._recordFailure({
        interviewId: id,
        turnId: claimed.qa_turn_id,
        stage: 'AUDIO_INPUT',
        errorCode: 'AUDIO_EMPTY_OR_CORRUPT',
        message: 'Audio rỗng hoặc hỏng sau lần thử lại; tiếp tục câu chính tiếp.',
        retryCount: 1,
      });
      stt = { text: '', confidence: 0, words: [] };
    } else if (audio) {
      // A2: Lưu audio lên S3 (thử lại 3 lần)
      const key = `interviews/${id}/turns/${claimed.qa_turn_id}/answer.${audioExtension(contentType)}`;
      let uploadError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.awsClients.putObject({
            bucket: this.env.audioBucket, key, body: audio, contentType,
          });
          answerAudioKey = key;
          uploadError = null;
          break;
        } catch (err) {
          uploadError = err;
        }
      }
      if (uploadError) {
        await this._recordFailure({
          interviewId: id,
          turnId: claimed.qa_turn_id,
          stage: 'AUDIO_STORE',
          errorCode: 'AUDIO_STORAGE_FAILED',
          message: `Lưu audio vào S3 thất bại sau 3 lần thử: ${uploadError.message}`,
          retryCount: 3,
        });
      }

      // A3: STT (thử lại 2 lần, timeout 10s)
      let sttError = null;
      const sttTimeoutMs = Number(this.env.sttTimeoutMs) || 10000;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          stt = await withTimeout(
            this.sttAdapter.transcribe({
              audio, contentType, language: exam.language, hints: keyPoints,
            }),
            sttTimeoutMs,
            'STT_TIMEOUT',
          );
          sttError = null;
          break;
        } catch (err) {
          sttError = err;
        }
      }
      if (sttError) {
        await this._recordFailure({
          interviewId: id,
          turnId: claimed.qa_turn_id,
          stage: 'STT',
          error: sttError,
          errorCode: (sttError && sttError.code) || 'STT_FAILED',
          message: `STT thất bại sau 2 lần thử: ${sttError.message}`,
          retryCount: 2,
        });
        // Infrastructure failures never become an empty/failed student answer.
        // Keep the original answer deadline; the overall exam deadline still wins.
        await this.qaTurnRepository.transitionStatus(
          claimed.qa_turn_id, ['PROCESSING'], prevStatus,
          { retry_count: (Number(claimed.retry_count) || 0) + 1 },
        );
        const current = await this._enforceDeadline(interview);
        if (!this._isActive(current)) return this._buildView(current, exam);
        throw httpError(502, 'STT_FAILED', 'Speech recognition failed. Please submit the answer again.');
      }
    } else if (transcript && transcript.text != null) {
      stt = {
        text: String(transcript.text),
        confidence: transcript.confidence ?? null,
        words: Array.isArray(transcript.words) ? transcript.words : [],
      };
    } else {
      const segments = (ctx && Array.isArray(ctx.partialSegments) ? ctx.partialSegments : [])
        .filter((s) => String(s.turnId) === String(claimed.qa_turn_id))
        .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
      stt = { text: segments.map((s) => s.text).join(' '), confidence: null, words: [] };
    }
    const answerText = String((stt && stt.text) ?? '').trim();

    // Server-enforced answer window: late answers are accepted ("tự nộp phần
    // đã nói") but flagged timed_out.
    const answerDeadlineMs = toMs(claimed.answer_deadline_at);
    const timedOutFinal = timedOut === true
      || (answerDeadlineMs != null && receivedAt.getTime() >= answerDeadlineMs);

    const answeredTurn = await this.qaTurnRepository.update(claimed.qa_turn_id, {
      status: 'ANSWERED',
      answer_text: answerText,
      answer_audio_key: answerAudioKey,
      transcript_confidence: clampConfidence(stt && stt.confidence),
      answer_ended_at: receivedAt,
      // Restart the claim clock: the decision phase (follow-up LLM + TTS)
      // starts now, and read-path recovery must measure its staleness from
      // here, not from receivedAt (STT alone can take minutes).
      processing_started_at: this.clock(),
      timed_out: timedOutFinal,
      response_latency_ms: signals?.responseLatencyMs ?? signals?.response_latency_ms,
      speech_duration_ms: signals?.speechDurationMs ?? signals?.speech_duration_ms,
      words_per_minute: signals?.wordsPerMinute ?? signals?.words_per_minute,
      pause_count: signals?.pause_count ?? signals?.pauseCount,
    });
    await this._safeContext(() => this.sessionContextStore.clearPartialSegments(id));

    // Hand the recognized answer to the transport as soon as it is persisted,
    // BEFORE the follow-up LLM decision and next-turn TTS. A slow or failing
    // provider must never delay or suppress it, so the callback is optional and
    // its failures are swallowed here.
    if (typeof onTranscribed === 'function') {
      const persisted = answeredTurn || claimed;
      try {
        onTranscribed({
          interviewId: id,
          turnId: persisted.qa_turn_id,
          sequenceNo: persisted.sequence_no,
          transcript: answeredTurn ? (answeredTurn.answer_text ?? null) : answerText,
        });
      } catch (err) {
        this.logger.warn({ err, interviewId: id }, 'onTranscribed callback failed');
      }
    }

    // --- Decision ------------------------------------------------------------
    const followUpsUsed = Number(interview.current_follow_up_count) || 0;
    const maxFollowUps = Number(exam.max_follow_ups_per_question) || 0;
    const deadlineMs = toMs(interview.deadline_at);
    const turns = await this.qaTurnRepository.listByInterview(id);
    const material = await this._loadQuestionMaterial(question);
    // Per-candidate cap (Step 12): FOLLOW_UP turns across the whole interview.
    const totalFollowUpsUsed = turns.filter((t) => t.turn_type === 'FOLLOW_UP').length;
    const maxFollowUpsTotal = exam.max_follow_ups_total ?? null;
    const caps = {
      followUpsUsed, maxFollowUps, totalFollowUpsUsed, maxFollowUpsTotal,
    };

    let llmDecision;
    if (receivedAt.getTime() < deadlineMs
      && question.snapshot_version === 1
      && shouldConsultLlm({ answerText, ...caps })) {
      llmDecision = await this._decideWithRetry({
        input: {
          language: exam.language,
          mainQuestion: {
            text: question ? question.content : '',
            bloomLevel: question ? question.bloom_level ?? null : null,
            referenceAnswer: question ? question.reference_answer ?? null : null,
            keyPoints,
          },
          rubricCriteria: criterionNames(material.rubric),
          sourceChunks: material.sourceChunks,
          history: turns
            .filter((t) => String(t.assigned_question_id) === String(claimed.assigned_question_id))
            .map((t) => ({ turnType: t.turn_type, questionText: t.question_text, answerText: t.answer_text })),
          // The prompt sees the tighter of the two caps as its budget.
          followUpsUsed,
          maxFollowUps: followUpsUsed + followUpsRemaining(caps),
        },
        parseContext: { referenceAnswer: question ? question.reference_answer : null, keyPoints },
        interviewId: id,
        turnId: claimed.qa_turn_id,
      });
    }

    // Re-read the clock: LLM latency must not push a follow-up past the deadline.
    const step = decideNextStep({
      now: this.clock(),
      deadlineAt: interview.deadline_at,
      answerText,
      ...caps,
      llmDecision,
    });

    const coveredKeyPoints = { ...((ctx && ctx.coveredKeyPoints) || {}) };
    if (llmDecision) {
      const aqKey = String(claimed.assigned_question_id);
      coveredKeyPoints[aqKey] = [...new Set([
        ...(coveredKeyPoints[aqKey] || []),
        ...llmDecision.covered_key_points,
      ])];
    }

    let current = interview;
    let currentTurn = null;
    if (step.action === 'END_SESSION') {
      current = await this._endInterview(interview, END_REASONS.DEADLINE_REACHED);
    } else if (step.action === 'ASK_FOLLOW_UP') {
      const transcriptSoFar = turns.map((t) => t.answer_text || '').join('\n');
      const groundingResult = validateGrounding(llmDecision.rationale.grounding, {
        transcriptSoFar, keyPoints, sourceChunks: material.sourceChunks,
      });
      const rationale = buildFollowUpRationale({ decision: llmDecision, groundingResult, now: this.clock() });
      const tts = await this._synthesize(llmDecision.follow_up_question, exam.language);
      // Final gate: TTS latency must not create a turn past the deadline;
      // the prepared follow-up is discarded and decision (1) applies.
      if (this._deadlinePassed(interview.deadline_at)) {
        current = await this._endInterview(interview, END_REASONS.DEADLINE_REACHED);
      } else {
        const result = await this._run(async (tx) => {
          const turn = await this.qaTurnRepository.create({
            interviewId: id,
            assignedQuestionId: claimed.assigned_question_id,
            sequenceNo: (Number(claimed.sequence_no) || 0) + 1,
            turnType: 'FOLLOW_UP',
            followUpReason: llmDecision.follow_up_reason,
            questionText: llmDecision.follow_up_question,
            rationale,
            status: 'ASKED',
            questionAudioKey: tts.audioKey,
            askedAt: this.clock(),
          }, tx);
          const updated = await this.vivaInterviewRepository.updateProgress(id, {
            current_follow_up_count: followUpsUsed + 1,
          }, tx);
          return { turn, updated };
        });
        current = result.updated;
        currentTurn = result.turn;
        if (tts.ttsError) {
          await this._recordFailure({
            interviewId: id, turnId: currentTurn.qa_turn_id, stage: 'TTS', error: tts.ttsError,
          });
        }
      }
    } else {
      const advanced = await this._advanceToNextMainQuestion({
        interview,
        exam,
        assigned,
        sequenceNo: (Number(claimed.sequence_no) || 0) + 1,
      });
      current = advanced.interview;
      currentTurn = advanced.turn;
    }

    if (this._isActive(current)) {
      await this._safeContext(() => this.sessionContextStore.update(id, {
        ...this._contextFromRows(current, currentTurn),
        coveredKeyPoints,
        partialSegments: [],
      }));
    } else {
      await this._safeContext(() => this.sessionContextStore.update(id, { coveredKeyPoints }));
    }
    return this._buildView(current, exam, { currentTurn, totalQuestions: assigned.length });
  }

  // Student-owned question/answer history. Available during and after the
  // interview; only answered turns plus the current asked question.
  async getTranscript({ user, interviewId } = {}) {
    const { interview } = await this._loadOwned(user, interviewId);
    const turns = await this.qaTurnRepository.listByInterview(interview.viva_interview_id);
    return assertStudentSafe(
      toStudentTranscriptView({ interview, turns }),
      { allowedKeys: ['transcript'] },
    );
  }

  // The recognized answer text of one of the student's own answered turns, for
  // the `turn:transcribed` event and the REST answer response. Returns null
  // when the turn has not been answered yet (e.g. an empty-audio retry).
  async getTranscribedTurn({ user, interviewId, turnId } = {}) {
    const { interview } = await this._loadOwned(user, interviewId);
    const id = this._parseId(turnId, 'turn id');
    const turn = await this.qaTurnRepository.findById(id);
    if (!turn || String(turn.interview_id) !== String(interview.viva_interview_id)) {
      throw httpError(404, 'TURN_NOT_FOUND', 'Turn not found.');
    }
    if (turn.status !== 'ANSWERED') return null;
    return {
      interviewId: interview.viva_interview_id,
      turnId: turn.qa_turn_id,
      sequenceNo: turn.sequence_no,
      transcript: turn.answer_text ?? null,
    };
  }

  // Let a student flag a mis-recognized answer so the examiner replays the
  // audio. Allowed during the interview and after completion until the result
  // is FINALIZED. Idempotent: a second call updates the note.
  async disputeStt({ user, interviewId, turnId, note = null } = {}) {
    const { interview, exam } = await this._loadOwned(user, interviewId);
    const id = this._parseId(turnId, 'turn id');
    const turn = await this.qaTurnRepository.findById(id);
    if (!turn || String(turn.interview_id) !== String(interview.viva_interview_id)) {
      throw httpError(404, 'TURN_NOT_FOUND', 'Turn not found.');
    }
    if (turn.status !== 'ANSWERED') {
      throw httpError(409, 'TURN_NOT_ANSWERED', 'Only answered turns can be disputed.');
    }
    const result = await this.vivaResultRepository.findByInterviewId(interview.viva_interview_id);
    if (result && result.status === 'FINALIZED') {
      throw httpError(409, 'RESULT_FINALIZED', 'The result is finalized; STT disputes are no longer accepted.');
    }
    const rawNote = note == null ? null : String(note);
    if (rawNote != null && rawNote.length > 500) {
      throw httpError(400, 'VALIDATION_ERROR', 'Dispute note must be at most 500 characters.');
    }
    const noteText = rawNote == null ? null : (rawNote.trim() || null);
    const updated = await this.qaTurnRepository.update(turn.qa_turn_id, {
      stt_disputed_at: this.clock(),
      stt_dispute_note: noteText,
    });
    await this._publishInterview(interview, 'updated', exam);
    return {
      turnId: updated.qa_turn_id,
      sttDisputed: true,
      sttDisputeNote: updated.stt_dispute_note ?? null,
    };
  }

  // =========================================================================
  // Internals (no instance state besides injected dependencies).
  // =========================================================================

  async _run(fn) {
    if (this.db && typeof this.db.withTransaction === 'function') {
      return this.db.withTransaction((tx) => fn(tx));
    }
    return fn(this.db || undefined);
  }

  // APPROVED bank with Bloom levels; repositories without the Step-12 method
  // fall back to bare ids (one UNSPECIFIED level -> plain least-used pick).
  // Only questions in the exam's language are eligible, so a question added to
  // the topic after scheduling can never be asked in the other language.
  async _loadQuestionBank(topicId, language = null) {
    if (typeof this.examSessionRepository.listApprovedQuestionsInTopic === 'function') {
      const bank = await this.examSessionRepository.listApprovedQuestionsInTopic(topicId);
      return language ? bank.filter((q) => examLanguageOf(q) === String(language).toUpperCase()) : bank;
    }
    const ids = await this.examSessionRepository.listApprovedQuestionIdsInTopic(topicId);
    return ids.map((qid) => ({ question_id: qid, bloom_level: null }));
  }

  async _lockExam(examId, tx) {
    if (typeof this.examSessionRepository.lockForUpdate === 'function') {
      await this.examSessionRepository.lockForUpdate(examId, tx);
    }
  }

  // Balanced pick (interview/pickBalancedQuestions.js): same Bloom mix for
  // every candidate, no overlap with the previous K candidates, least used
  // first. Reads run on the locking transaction.
  async _pickMainQuestions(exam, bank, required, tx) {
    const examId = exam.exam_session_id;
    const repo = this.assignedQuestionRepository;
    const k = recentWindow(bank.length, required);
    const recent = k > 0 && typeof repo.listRecentByExam === 'function'
      ? await repo.listRecentByExam(examId, k, tx)
      : [];
    const usage = typeof repo.countUsageByExam === 'function'
      ? await repo.countUsageByExam(examId, tx)
      : new Map();
    const { ids, warnings } = pickBalancedQuestions({
      bank: bank.map((q) => ({ id: Number(q.question_id), bloom_level: q.bloom_level ?? null })),
      n: required,
      recentByCandidate: recent,
      usageCounts: usage,
      bloomTarget: exam.bloom_distribution || null,
      random: this.random,
    });
    if (warnings.length > 0) {
      this.logger.warn({ examSessionId: examId, warnings }, 'balanced question pick relaxed');
    }
    return ids;
  }

  // Fire-and-forget STT warm-up; a failure never affects the start.
  _warmSttInBackground(language) {
    if (!this.sttAdapter || typeof this.sttAdapter.warmUp !== 'function') return;
    const lang = String(language || 'VI').toUpperCase() === 'EN' ? 'en' : 'vi';
    Promise.resolve()
      .then(() => this.sttAdapter.warmUp(lang))
      .catch((err) => this.logger.warn({ err }, 'STT warm-up at interview start failed'));
  }

  _assertStudent(user) {
    if (!user) throw httpError(401, 'UNAUTHENTICATED', 'Authentication required.');
    if (user.role !== 'STUDENT') {
      throw httpError(403, 'FORBIDDEN', 'Only students can take an interview.');
    }
  }

  _parseId(raw, label) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw httpError(400, 'VALIDATION_ERROR', `A valid ${label} is required.`);
    }
    return id;
  }

  // Owner check: someone else's interview is reported as not found so its
  // existence is not leaked.
  async _loadOwned(user, interviewId) {
    this._assertStudent(user);
    const id = this._parseId(interviewId, 'interview id');
    const interview = await this.vivaInterviewRepository.findById(id);
    if (!interview || Number(interview.student_id) !== Number(user.id)) {
      throw httpError(404, 'INTERVIEW_NOT_FOUND', 'Interview not found.');
    }
    const exam = await this.examSessionRepository.findById(interview.exam_session_id);
    return { interview, exam };
  }

  _isActive(interview) {
    return !!interview && ACTIVE_INTERVIEW_STATUSES.includes(interview.status);
  }

  // deadline_at = started_at + session_time_limit_sec, capped at closes_at
  // when that is set and earlier. Computed once at start and persisted.
  _computeDeadline(startedAt, exam) {
    const limitSec = Number(exam.session_time_limit_sec) || DEFAULT_SESSION_TIME_LIMIT_SEC;
    let deadlineMs = startedAt.getTime() + limitSec * 1000;
    const closesMs = toMs(exam.closes_at);
    if (closesMs != null && closesMs < deadlineMs) deadlineMs = closesMs;
    return new Date(deadlineMs);
  }

  async _resume(interview, exam) {
    let current = await this._enforceDeadline(interview);
    if (this._isActive(current)) {
      current = await this._recoverStuckState(current, exam);
      if (this._isActive(current)) await this._ensureContext(current);
    }
    return this._buildView(current, exam);
  }

  // Read-path crash recovery (defects A/B). A request can die after claiming a
  // turn as PROCESSING (or after persisting ANSWERED but before creating the
  // next turn), leaving every later read stuck. On the student's next read:
  //   * a PROCESSING turn whose claim is older than TURN_PROCESSING_STALE_SEC
  //     (or has no processing_started_at, legacy rows) is released to
  //     ANSWERING exactly like the submitAnswer failure path;
  //   * an active interview with no ASKED/ANSWERING/PROCESSING turn advances to
  //     the next main question, or ends normally when none remains.
  // Idempotent under concurrent reads: the release is a conditional transition
  // and the next-turn insert is protected by (interview_id, sequence_no).
  async _recoverStuckState(interview, exam) {
    const id = interview.viva_interview_id;
    let turns = await this.qaTurnRepository.listByInterview(id);
    let latest = turns[turns.length - 1] || null;

    if (latest && latest.status === 'PROCESSING' && this._isProcessingStale(latest)) {
      const released = await this._releaseProcessingTurnSafely(interview, exam, latest, {
        errorCode: 'STALE_PROCESSING',
      });
      if (released) {
        latest = released;
      } else {
        // Another read released it (or moved it on) first.
        turns = await this.qaTurnRepository.listByInterview(id);
        latest = turns[turns.length - 1] || null;
      }
    }

    if (!latest) return interview;
    if (OPEN_TURN_STATUSES.includes(latest.status)) return interview;
    if (turns.some((t) => OPEN_TURN_STATUSES.includes(t.status))) return interview;
    // submitAnswer persists ANSWERED, then spends seconds on the follow-up
    // decision before inserting the next turn. Advancing during that window
    // would replace a follow-up with the next main question.
    if (!this._isStaleSince(latest.processing_started_at || latest.answer_ended_at)) return interview;
    if (this._deadlinePassed(interview.deadline_at)) {
      return this._enforceDeadline(interview);
    }

    const assigned = await this.assignedQuestionRepository.listByInterview(id);
    const advanced = await this._advanceToNextMainQuestion({
      interview,
      exam,
      assigned,
      sequenceNo: (Number(latest.sequence_no) || 0) + 1,
    });
    if (this._isActive(advanced.interview)) {
      const ctx = await this._ensureContext(advanced.interview);
      await this._safeContext(() => this.sessionContextStore.update(id, {
        ...this._contextFromRows(advanced.interview, advanced.turn),
        coveredKeyPoints: (ctx && ctx.coveredKeyPoints) || {},
        partialSegments: [],
      }));
    }
    return advanced.interview;
  }

  // A PROCESSING claim older than TURN_PROCESSING_STALE_SEC was abandoned by
  // its request. Legacy rows (claimed before migration 036) have no timestamp
  // and are treated as stale too.
  _isProcessingStale(turn) {
    return this._isStaleSince(turn.processing_started_at);
  }

  _isStaleSince(value) {
    const startedMs = toMs(value);
    if (startedMs == null) return true;
    const staleSec = Number(this.env.turnProcessingStaleSec) || DEFAULT_TURN_PROCESSING_STALE_SEC;
    return this.clock().getTime() - startedMs >= staleSec * 1000;
  }

  // Release a turn claimed as PROCESSING back to ANSWERING. Race-safe: iff
  // another path already moved it on, returns null (the caller keeps its own
  // error outcome). Records one processing_failure whenever the release wins.
  async _releaseProcessingTurn(interview, exam, turn, {
    stage = 'ANSWER_PROCESSING',
    errorCode = 'UNEXPECTED_ERROR',
    error = null,
  } = {}) {
    const now = this.clock();
    const windowSec = Number(exam.answer_time_limit_sec) || DEFAULT_ANSWER_TIME_LIMIT_SEC;
    const deadlineMs = Math.min(
      now.getTime() + windowSec * 1000,
      toMs(interview.deadline_at),
    );
    const released = await this.qaTurnRepository.transitionStatus(
      turn.qa_turn_id,
      ['PROCESSING'],
      'ANSWERING',
      { answer_deadline_at: new Date(deadlineMs) },
    );
    if (!released) return null;
    await this._recordFailure({
      interviewId: interview.viva_interview_id,
      turnId: turn.qa_turn_id,
      stage,
      errorCode,
      message: error ? (error.message || String(error)) : undefined,
      error,
    });
    return released;
  }

  // Same as _releaseProcessingTurn, but a failed revert is logged instead of
  // thrown: the caller still has to surface its own failure to the student.
  // Returns `false` (not null) when the revert itself failed so the caller can
  // tell it apart from "the turn was already moved on".
  async _releaseProcessingTurnSafely(interview, exam, turn, options = {}) {
    try {
      return await this._releaseProcessingTurn(interview, exam, turn, options);
    } catch (revertErr) {
      this.logger?.error?.(
        { err: revertErr, interviewId: interview.viva_interview_id, turnId: turn.qa_turn_id },
        'could not release a PROCESSING turn after an unexpected error',
      );
      return false;
    }
  }

  // Decision (1) applied lazily: an active interview past its deadline ends
  // now (Step 7 adds timers so this also fires without a client call).
  // submitAnswer deliberately does NOT call this before persisting: the
  // in-flight answer is saved first ("tự nộp phần đã nói") and decision (1)
  // then ends the interview.
  // Uses the persisted deadline only; closes_at is not re-read (it was applied
  // once when the deadline was computed at start).
  async _enforceDeadline(interview) {
    if (!this._isActive(interview)) return interview;
    if (!this._deadlinePassed(interview.deadline_at)) return interview;
    return this._endInterview(interview, END_REASONS.DEADLINE_REACHED);
  }

  // True when the clock has reached `deadlineAt`. Called as the final gate
  // right before any transaction that creates a turn.
  _deadlinePassed(deadlineAt) {
    const deadlineMs = toMs(deadlineAt);
    return deadlineMs != null && this.clock().getTime() >= deadlineMs;
  }

  async _requireCurrentTurn(interview, turnId) {
    const latest = await this.qaTurnRepository.findLatestByInterview(interview.viva_interview_id);
    if (!latest || String(latest.qa_turn_id) !== String(turnId)) {
      throw httpError(409, 'TURN_NOT_CURRENT', 'This is not the current question.');
    }
    return latest;
  }

  // Idempotent completion (A6 minimal). Conditional COMPLETED flip, then in
  // the same transaction: open turns -> UNANSWERED, transcript persisted as
  // complete, viva_result PENDING created if absent. After commit the grading
  // job is enqueued (Step 8 implements GRADE_INTERVIEW).
  async _endInterview(interview, reason) {
    const id = interview.viva_interview_id;
    const endedAt = this.clock();
    const ended = await this._run(async (tx) => {
      const done = await this.vivaInterviewRepository.completeIfActive(id, { endedAt, endReason: reason }, tx);
      if (!done) return null;
      await this.qaTurnRepository.markOpenTurnsUnanswered(id, tx);
      const turns = await this.qaTurnRepository.listByInterview(id, tx);
      await this.transcriptRepository.upsert({
        interviewId: id, fullText: buildTranscriptText(turns), isComplete: true,
      }, tx);
      await this.vivaResultRepository.createPendingIfAbsent(id, tx);
      return done;
    });
    if (!ended) {
      // Someone else ended it first: no duplicate side effects.
      return this.vivaInterviewRepository.findById(id);
    }
    try {
      await this.enqueueJob('GRADE_INTERVIEW', { interviewId: id });
    } catch (err) {
      await this._recordFailure({ interviewId: id, stage: 'GRADE_ENQUEUE', error: err });
    }
    await this._safeContext(() => this.sessionContextStore.update(id, {
      status: ended.status,
      currentTurnId: null,
      answerDeadlineAt: null,
      partialSegments: [],
    }));
    await this._publishInterview({ ...interview, ...ended }, 'completed');
    return ended;
  }

  // Background sweep (F9): end abandoned interviews whose deadline has passed.
  // Idempotent completion via _endInterview creates viva_result and enqueues GRADE_INTERVIEW.
  // Records individual failures and continues so one failed row never blocks the sweep.
  async expireOverdueInterviews({ graceSec = 30, limit = 50 } = {}) {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - (Number(graceSec) || 0) * 1000);
    const overdue = await this.vivaInterviewRepository.listOverdueActive({ before: cutoff, limit });
    let endedCount = 0;
    for (const interview of overdue) {
      try {
        const ended = await this._endInterview(interview, END_REASONS.DEADLINE_REACHED);
        if (ended && ended.status === 'COMPLETED') {
          endedCount += 1;
        }
      } catch (err) {
        await this._recordFailure({
          interviewId: interview.viva_interview_id,
          stage: 'EXPIRE_SWEEP',
          error: err,
        });
      }
    }
    return { ended: endedCount };
  }

  // Advance to the next main question, or end the interview when none remains
  // or the session deadline passed while preparing. Shared by submitAnswer and
  // the read-path crash recovery. A concurrent caller that loses the unique
  // (interview_id, sequence_no) insert is answered with the winner's turn, so
  // two reads can never create two turns.
  async _advanceToNextMainQuestion({
    interview, exam, assigned, sequenceNo,
  }) {
    const id = interview.viva_interview_id;
    const index = Number(interview.current_question_index) || 0;
    const next = assigned.find((a) => Number(a.order_no) === index + 2);
    if (!next) {
      return {
        interview: await this._endInterview(interview, END_REASONS.QUESTIONS_EXHAUSTED),
        turn: null,
      };
    }
    const prepared = await this._prepareMainTurn(readInterviewQuestion(next), exam);
    // Final gate: preparation latency must not create a turn past the deadline;
    // the prepared main question is discarded.
    if (this._deadlinePassed(interview.deadline_at)) {
      return {
        interview: await this._endInterview(interview, END_REASONS.DEADLINE_REACHED),
        turn: null,
      };
    }
    let result;
    try {
      result = await this._run(async (tx) => {
        const turn = await this.qaTurnRepository.create({
          interviewId: id,
          assignedQuestionId: next.assigned_question_id,
          sequenceNo,
          turnType: 'MAIN',
          questionText: prepared.question.content,
          rationale: prepared.rationale,
          status: 'ASKED',
          questionAudioKey: prepared.audioKey,
          askedAt: this.clock(),
        }, tx);
        await this.assignedQuestionRepository.markAsked(next.assigned_question_id, tx);
        const updated = await this.vivaInterviewRepository.updateProgress(id, {
          current_question_index: index + 1,
          current_follow_up_count: 0,
        }, tx);
        return { turn, updated };
      });
    } catch (err) {
      if (!err || err.code !== '23505') throw err;
      // Lost the race to another reader: return the turn it created.
      const latest = await this.qaTurnRepository.findLatestByInterview(id);
      const current = await this.vivaInterviewRepository.findById(id);
      return { interview: current || interview, turn: latest };
    }
    if (prepared.ttsError) {
      await this._recordFailure({
        interviewId: id,
        turnId: result.turn.qa_turn_id,
        stage: 'TTS',
        error: prepared.ttsError,
      });
    }
    return { interview: result.updated, turn: result.turn };
  }

  // Load question rationale sources and rubric for a main turn, and synthesize
  // its audio. Runs outside any transaction; TTS failure is reported back so
  // the caller can record it once the turn id exists.
  async _prepareMainTurn(question, exam) {
    const material = await this._loadQuestionMaterial(question);
    const rationale = buildMainRationale({
      question, sourceRefs: material.sourceRefs, rubric: material.rubric, now: this.clock(),
    });
    const tts = await this._synthesize(question ? question.content : '', exam.language);
    return {
      question, rationale, audioKey: tts.audioKey, ttsError: tts.ttsError,
    };
  }

  async _loadQuestionMaterial(question, client) {
    if (question?.snapshot_version === 1 || question?.legacy_operational_only) {
      const sourceRefs = question.source_refs_snapshot || [];
      return {
        sourceRefs, rubric: question.rubric_snapshot,
        sourceChunks: sourceRefs.map((s) => ({ chunkId: s.chunkId, location: s.location, content: s.content })),
      };
    }
    let sourceRefs = [];
    if (question && question.source === 'AI' && this.questionSourceRefRepository) {
      sourceRefs = await this.questionSourceRefRepository.listByQuestionWithMaterial(question.question_id, client);
    }
    const rubric = question && question.rubric_id != null && this.rubricRepository
      ? await this.rubricRepository.findById(question.rubric_id, client)
      : null;
    return {
      sourceRefs,
      rubric,
      sourceChunks: sourceRefs.map((s) => ({ chunkId: s.chunkId, location: s.location, content: s.content })),
    };
  }

  async _synthesize(text, language) {
    try {
      const result = await withTimeout(
        this.ttsAdapter.synthesize({ text, language }),
        Number(this.env.ttsTimeoutMs) || 8000,
        'TTS_TIMEOUT',
      );
      return { audioKey: (result && result.audioKey) || null, ttsError: null };
    } catch (err) {
      return { audioKey: null, ttsError: err };
    }
  }

  // Up to two attempts (each bounded by FOLLOW_UP_LLM_TIMEOUT_MS). Both failing
  // records one processing_failure and returns null (-> next main question).
  async _decideWithRetry({
    input, parseContext, interviewId, turnId,
  }) {
    let errorCode = null;
    let message = null;
    const timeoutMs = Number(this.env.followUpLlmTimeoutMs) || 20000;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await withTimeout(
          Promise.resolve().then(() => this.llmAdapter.decideFollowUp(input)),
          timeoutMs,
          'LLM_TIMEOUT',
        );
        const parsed = parseFollowUpDecision(raw, parseContext);
        if (parsed.ok) return parsed.value;
        errorCode = parsed.errorCode;
        message = parsed.message;
      } catch (err) {
        errorCode = 'LLM_ERROR';
        message = err && err.message ? err.message : String(err);
      }
    }
    await this._recordFailure({
      interviewId, turnId, stage: 'FOLLOW_UP_LLM', errorCode, message, retryCount: 1,
    });
    return null;
  }

  async _recordFailure({
    interviewId, turnId = null, stage, error, errorCode, message, retryCount = 0,
  }) {
    try {
      await this.processingFailureRepository.create({
        interviewId,
        turnId,
        stage,
        errorCode: errorCode || (error && error.code) || `${stage}_FAILED`,
        message: String(message ?? (error && error.message) ?? '').slice(0, MAX_FAILURE_MESSAGE),
        retryCount,
      });
    } catch (err) {
      this.logger.error({ err, interviewId, stage }, 'could not record processing_failure');
    }
    if (this.logger && this.logger.warn) {
      this.logger.warn({ interviewId, turnId, stage, errorCode }, 'interview processing failure recorded');
    }
  }

  _contextFromRows(interview, turn) {
    return {
      interviewId: interview.viva_interview_id,
      examSessionId: interview.exam_session_id,
      studentId: interview.student_id,
      status: interview.status,
      currentTurnId: turn ? turn.qa_turn_id : null,
      currentAssignedQuestionId: turn ? turn.assigned_question_id : null,
      currentQuestionIndex: Number(interview.current_question_index) || 0,
      currentFollowUpCount: Number(interview.current_follow_up_count) || 0,
      deadlineAt: new Date(toMs(interview.deadline_at)).toISOString(),
      answerDeadlineAt: turn && turn.answer_deadline_at
        ? new Date(toMs(turn.answer_deadline_at)).toISOString()
        : null,
    };
  }

  // Return the SessionContext, rebuilding it from Postgres when missing or
  // expired (A5). Context failures never break the interview (Postgres is truth).
  async _ensureContext(interview, knownTurn) {
    return this._safeContext(async () => {
      const existing = await this.sessionContextStore.get(interview.viva_interview_id);
      if (existing) return existing;
      return this.rebuildContextFromDb(interview.viva_interview_id, knownTurn);
    });
  }

  // A5: Reconstruct active session context from durable Postgres state.
  async rebuildContextFromDb(interviewId, knownTurn) {
    const id = this._parseId(interviewId, 'interview id');
    const interview = await this.vivaInterviewRepository.findById(id);
    if (!interview) return null;

    const turn = knownTurn
      || await this.qaTurnRepository.findLatestByInterview(id);
    const turns = await this.qaTurnRepository.listByInterview(id);
    const coveredKeyPoints = {};
    for (const t of turns) {
      if (t.rationale && Array.isArray(t.rationale.covered_key_points) && t.assigned_question_id) {
        const aqKey = String(t.assigned_question_id);
        coveredKeyPoints[aqKey] = [...new Set([
          ...(coveredKeyPoints[aqKey] || []),
          ...t.rationale.covered_key_points,
        ])];
      }
    }
    const rebuilt = {
      ...this._contextFromRows(interview, turn),
      coveredKeyPoints,
      partialSegments: [],
    };
    await this._safeContext(() => this.sessionContextStore.put(rebuilt));
    return rebuilt;
  }

  async _safeContext(fn) {
    if (!this.sessionContextStore) return null;
    try {
      return await fn();
    } catch (err) {
      if (this.logger && this.logger.warn) {
        this.logger.warn({ err }, 'session context write/read failed (Postgres remains the source of truth)');
      }
      return null;
    }
  }

  async _buildView(interview, exam, { currentTurn, totalQuestions, retryPrompt } = {}) {
    const turn = currentTurn !== undefined && currentTurn !== null
      ? currentTurn
      : await this.qaTurnRepository.findLatestByInterview(interview.viva_interview_id);
    const total = totalQuestions != null
      ? totalQuestions
      : (await this.assignedQuestionRepository.listByInterview(interview.viva_interview_id)).length;
    const view = toStudentInterviewView({
      interview,
      examSession: exam,
      currentTurn: turn,
      totalQuestions: total,
      now: this.clock(),
      retryPrompt,
    });
    return assertStudentSafe(view);
  }
}

module.exports = { InterviewService, audioExtension, withTimeout };
