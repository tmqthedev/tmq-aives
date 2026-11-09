// Student-owned question/answer history DTO. Built field-by-field with an
// explicit allowlist and never spread from a DB row, so reference answers,
// key points, rubric, rationale, scores, knowledge snapshots and audio keys
// can never reach the student. The student's own recognized answer text is the
// only transcript content here; assertStudentSafe is called with
// `allowedKeys: ['transcript']` for exactly that field.

const ASKED_LIKE_STATUSES = ['ASKED', 'ANSWERING'];

function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapTurn(turn, { answered }) {
  return {
    turnId: turn.qa_turn_id,
    sequenceNo: turn.sequence_no,
    turnType: turn.turn_type,
    questionText: turn.question_text ?? null,
    transcript: answered ? (turn.answer_text ?? null) : null,
    answeredAt: answered ? toIso(turn.answer_ended_at) : null,
    sttDisputed: turn.stt_disputed_at != null,
    sttDisputeNote: turn.stt_dispute_note ?? null,
  };
}

// Only answered turns plus the current asked question (transcript null) are
// shown, ordered by sequenceNo. Open turns marked UNANSWERED at completion and
// failed turns are omitted.
function toStudentTranscriptView({ interview, turns = [] }) {
  const ordered = [...turns].sort((a, b) => (a.sequence_no ?? 0) - (b.sequence_no ?? 0));
  const out = [];
  let currentAsked = null;
  for (const turn of ordered) {
    if (turn.status === 'ANSWERED') {
      out.push(mapTurn(turn, { answered: true }));
    } else if (ASKED_LIKE_STATUSES.includes(turn.status)) {
      currentAsked = turn;
    }
  }
  if (currentAsked) out.push(mapTurn(currentAsked, { answered: false }));

  return {
    interviewId: interview.viva_interview_id,
    status: interview.status,
    turns: out,
  };
}

module.exports = {
  toStudentTranscriptView,
};
