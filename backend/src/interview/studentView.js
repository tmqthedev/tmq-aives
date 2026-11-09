// Student-safe DTO for the interview engine (Step 6). Every public engine
// method returns ONLY this object. It is an explicit allowlist built field by
// field and never spreads a DB row, so rationale, answer text, transcript,
// key points, follow-up reasons and confidence can never reach the student.
// assertStudentSafe is a second, independent guard (defense in depth).

const ENDED_STATUSES = ['COMPLETED', 'TERMINATED'];

const STUDENT_FORBIDDEN_KEYS = [
  'rationale',
  'grounding',
  'unverified_grounding',
  'why',
  'purpose',
  'synthesis',
  'key_points',
  'keyPoints',
  'reference_answer',
  'knowledge_snapshot',
  'rubric_snapshot',
  'source_refs_snapshot',
  'answer_text',
  'answerText',
  'transcript',
  'full_text',
  'follow_up_reason',
  'covered_key_points',
  'missing_key_points',
  'transcript_confidence',
  'target_key_points',
  'target_criteria',
];

function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toMs(value) {
  if (value == null) return null;
  const t = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(t) ? null : t;
}

function toInt(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStudentInterviewView({
  interview, examSession, currentTurn, totalQuestions, now, retryPrompt = null,
}) {
  const nowMs = (now instanceof Date ? now : new Date(now ?? Date.now())).getTime();
  const ended = ENDED_STATUSES.includes(interview.status);
  const thinkTimeSec = toInt(examSession && examSession.think_time_sec) ?? 0;
  const deadlineMs = toMs(interview.deadline_at);

  let turnView = null;
  if (!ended && currentTurn) {
    const playedMs = toMs(currentTurn.played_at);
    const answerDeadlineMs = toMs(currentTurn.answer_deadline_at);
    turnView = {
      turnId: currentTurn.qa_turn_id,
      turnType: currentTurn.turn_type,
      questionText: currentTurn.question_text ?? null,
      audioKey: currentTurn.question_audio_key ?? null,
      status: currentTurn.status ?? null,
      askedAt: toIso(currentTurn.asked_at),
      playedAt: toIso(currentTurn.played_at),
      answerOpensAt: playedMs == null ? null : new Date(playedMs + thinkTimeSec * 1000).toISOString(),
      answerDeadlineAt: toIso(currentTurn.answer_deadline_at),
      remainingAnswerMs: currentTurn.status === 'ANSWERING' && answerDeadlineMs != null
        ? Math.max(0, answerDeadlineMs - nowMs)
        : null,
      retryCount: toInt(currentTurn.retry_count) ?? 0,
      retryPrompt: retryPrompt ?? null,
    };
  }

  return {
    interviewId: interview.viva_interview_id,
    examSessionId: interview.exam_session_id,
    status: interview.status,
    language: (examSession && examSession.language) || null,
    questionNumber: (toInt(interview.current_question_index) ?? 0) + 1,
    totalQuestions: toInt(totalQuestions),
    followUpNumber: toInt(interview.current_follow_up_count) ?? 0,
    maxFollowUps: toInt(examSession && examSession.max_follow_ups_per_question) ?? 0,
    deadlineAt: toIso(interview.deadline_at),
    remainingSessionMs: deadlineMs == null ? null : Math.max(0, deadlineMs - nowMs),
    thinkTimeSec,
    answerTimeLimitSec: toInt(examSession && examSession.answer_time_limit_sec),
    endReason: ended ? (interview.end_reason ?? null) : null,
    pausedAt: toIso(interview.paused_at),
    retryPrompt: retryPrompt ?? null,
    currentTurn: turnView,
  };
}

// Deep key scan: throws when any forbidden key appears anywhere in `obj`.
// `allowedKeys` relaxes specific keys for views where the student is entitled
// to that content (e.g. their own answer transcript in the history view).
function assertStudentSafe(obj, { allowedKeys = [] } = {}) {
  const forbidden = new Set(STUDENT_FORBIDDEN_KEYS);
  for (const key of allowedKeys) forbidden.delete(key);
  const stack = [{ value: obj, path: '$' }];
  while (stack.length > 0) {
    const { value, path } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) {
        const err = new Error(`Student-facing payload contains forbidden key "${key}" at ${path}.`);
        err.statusCode = 500;
        err.code = 'STUDENT_VIEW_LEAK';
        throw err;
      }
      stack.push({ value: child, path: `${path}.${key}` });
    }
  }
  return obj;
}

module.exports = {
  STUDENT_FORBIDDEN_KEYS,
  toStudentInterviewView,
  assertStudentSafe,
};
