const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWorld, EXAM_ID, STUDENT, OTHER_STUDENT, KEY_POINTS, START_ISO,
} = require('./helpers/interviewFakes');
const { STUDENT_FORBIDDEN_KEYS } = require('../src/interview/studentView');
const { UNVERIFIED_NOTE } = require('../src/interview/groundingValidator');

const FULL_ANSWER = `TCP relies on the ${KEY_POINTS.join(', the ')} to deliver data reliably.`;
const PARTIAL_ANSWER = 'TCP uses sequence numbers to order the bytes it sends.';

// --- helpers -------------------------------------------------------------------

function rationaleStrings(db) {
  const out = new Set();
  const walk = (value, key) => {
    if (value == null) return;
    if (typeof value === 'string') {
      if (key !== 'snapshot_at' && value.length >= 12) out.add(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, key)); return; }
    if (typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  for (const t of db.turns.values()) walk(t.rationale, null);
  for (const t of db.turns.values()) if (t.answer_text && t.answer_text.length >= 12) out.add(t.answer_text);
  return out;
}

// Student-safety scan applied to EVERY engine return value in these tests.
function assertStudentSafeView(world, view) {
  const json = JSON.stringify(view);
  for (const key of STUDENT_FORBIDDEN_KEYS) {
    assert.equal(json.includes(`"${key}"`), false, `student payload leaked key ${key}`);
  }
  for (const value of rationaleStrings(world.db)) {
    assert.equal(json.includes(value), false, `student payload leaked value: ${value}`);
  }
  return view;
}

async function start(world, user = STUDENT, service = world.service) {
  return assertStudentSafeView(world, await service.startOrResume({ user, examSessionId: EXAM_ID }));
}

async function play(world, view, service = world.service) {
  return assertStudentSafeView(world, await service.markQuestionPlayed({
    user: STUDENT, interviewId: view.interviewId, turnId: view.currentTurn.turnId,
  }));
}

async function answer(world, view, text, extra = {}, service = world.service) {
  return assertStudentSafeView(world, await service.submitAnswer({
    user: STUDENT,
    interviewId: view.interviewId,
    turnId: view.currentTurn.turnId,
    transcript: { text },
    ...extra,
  }));
}

function row(world, view) {
  return world.db.interviews.get(view.interviewId);
}

function turns(world, view) {
  return world.db.turnsOf(view.interviewId);
}

function failures(world, stage) {
  return world.db.failures.filter((f) => !stage || f.stage === stage);
}

function validAsk(over = {}) {
  return {
    next_action: 'ASK_FOLLOW_UP',
    follow_up_reason: 'INCOMPLETE',
    covered_key_points: ['sequence numbers'],
    missing_key_points: ['three-way handshake', 'acknowledgements'],
    follow_up_question: 'Can you say more about how a connection starts and how delivery is confirmed?',
    rationale: {
      why: 'Connection setup and confirmation are missing.',
      purpose: 'Probe the missing steps.',
      target_key_points: ['three-way handshake', 'acknowledgements'],
      target_criteria: ['Accuracy'],
      grounding: [
        { type: 'STUDENT_QUOTE', ref: null, text: 'uses sequence numbers to order' },
        { type: 'STUDENT_QUOTE', ref: null, text: 'UDP is always faster than TCP' },
      ],
      synthesis: 'Ordering covered; setup missing.',
    },
    ...over,
  };
}

async function expectError(promise, statusCode, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, statusCode, `status ${err.statusCode} ${err.code}`);
    assert.equal(err.code, code);
    return true;
  });
}

// --- start ---------------------------------------------------------------------

test('start: IN_PROGRESS with deadline = start + session_time_limit_sec', async () => {
  const world = buildWorld();
  const view = await start(world);
  const iv = row(world, view);
  assert.equal(view.status, 'IN_PROGRESS');
  assert.equal(iv.status, 'IN_PROGRESS');
  assert.equal(new Date(iv.started_at).toISOString(), START_ISO);
  assert.equal(new Date(iv.deadline_at).toISOString(), '2026-03-01T08:30:00.000Z');
  assert.equal(view.deadlineAt, '2026-03-01T08:30:00.000Z');
  assert.equal(view.remainingSessionMs, 1800 * 1000);
});

test('start: deadline capped by an earlier closes_at; a later closes_at is ignored', async () => {
  const early = buildWorld({ exam: { closes_at: '2026-03-01T08:10:00.000Z' } });
  assert.equal((await start(early)).deadlineAt, '2026-03-01T08:10:00.000Z');
  const late = buildWorld({ exam: { closes_at: '2026-03-01T09:00:00.000Z' } });
  assert.equal((await start(late)).deadlineAt, '2026-03-01T08:30:00.000Z');
});

test('start: closes_at already passed -> 409 EXAM_CLOSED', async () => {
  const world = buildWorld({ exam: { closes_at: '2026-03-01T07:59:00.000Z' } });
  await expectError(start(world), 409, 'EXAM_CLOSED');
  assert.equal(world.db.interviews.size, 0);
});

test('start: main_question_count honored, order_no 1..n, picks only APPROVED questions of the topic', async () => {
  const world = buildWorld({ approvedCount: 6, exam: { main_question_count: 4 } });
  const view = await start(world);
  const assigned = [...world.db.assigned.values()].filter((a) => a.interview_id === view.interviewId);
  assert.equal(assigned.length, 4);
  assert.equal(view.totalQuestions, 4);
  assert.deepEqual(assigned.map((a) => a.order_no).sort(), [1, 2, 3, 4]);
  const approved = [101, 102, 103, 104, 105, 106];
  assigned.forEach((a) => assert.ok(approved.includes(a.question_id), `picked ${a.question_id}`));
  assert.equal(new Set(assigned.map((a) => a.question_id)).size, 4);
});

test('start: selection is deterministic per seed', async () => {
  const pick = async (seed) => {
    const world = buildWorld({ approvedCount: 8, seed });
    const view = await start(world);
    return [...world.db.assigned.values()]
      .filter((a) => a.interview_id === view.interviewId)
      .sort((a, b) => a.order_no - b.order_no)
      .map((a) => a.question_id);
  };
  assert.deepEqual(await pick(7), await pick(7));
  assert.notDeepEqual(await pick(7), await pick(8));
});

test('start: NOT_ENOUGH_QUESTIONS writes nothing', async () => {
  const world = buildWorld({ approvedCount: 2 });
  await expectError(start(world), 409, 'NOT_ENOUGH_QUESTIONS');
  assert.equal(world.db.interviews.size, 0);
  assert.equal(world.db.assigned.size, 0);
  assert.equal(world.db.turns.size, 0);
  assert.equal(world.tts.calls.length, 0);
});

test('start: exam not OPEN -> 409, not on roster -> 403, LECTURER -> 403', async () => {
  await expectError(start(buildWorld({ exam: { status: 'DRAFT' } })), 409, 'EXAM_NOT_OPEN');
  await expectError(start(buildWorld({ exam: { status: 'CLOSED' } })), 409, 'EXAM_NOT_OPEN');
  await expectError(start(buildWorld(), { id: 77, role: 'STUDENT' }), 403, 'NOT_ON_ROSTER');
  await expectError(start(buildWorld(), { id: 1, role: 'LECTURER' }), 403, 'FORBIDDEN');
  await expectError(buildWorld().service.startOrResume({ user: STUDENT, examSessionId: 999 }), 404, 'EXAM_SESSION_NOT_FOUND');
});

test("start: another student's interview id -> 404", async () => {
  const world = buildWorld();
  const view = await start(world);
  await expectError(
    world.service.getCurrentState({ user: OTHER_STUDENT, interviewId: view.interviewId }),
    404,
    'INTERVIEW_NOT_FOUND',
  );
  await expectError(
    world.service.getCurrentState({ user: { id: 1, role: 'LECTURER' }, interviewId: view.interviewId }),
    403,
    'FORBIDDEN',
  );
});

test('start: rubrics of every assigned question are locked', async () => {
  const world = buildWorld({ approvedCount: 6 });
  const view = await start(world);
  const rubricIds = new Set([...world.db.assigned.values()]
    .filter((a) => a.interview_id === view.interviewId)
    .map((a) => world.db.questions.get(a.question_id).rubric_id));
  assert.deepEqual([...world.db.lockedRubrics].sort(), [...rubricIds].sort());
});

test('start: first turn is MAIN/ASKED with rationale snapshot and TTS audio key in exam language', async () => {
  const world = buildWorld({ exam: { language: 'VI' } });
  const view = await start(world);
  const [turn] = turns(world, view);
  assert.equal(turn.turn_type, 'MAIN');
  assert.equal(turn.status, 'ASKED');
  assert.equal(turn.sequence_no, 1);
  assert.ok(turn.rationale && turn.rationale.kind);
  assert.equal(turn.question_audio_key, 'tts/1.mp3');
  assert.equal(world.tts.calls[0].language, 'VI');
  assert.equal(world.tts.calls[0].text, turn.question_text);
  assert.equal(view.currentTurn.audioKey, 'tts/1.mp3');
  assert.equal(view.currentTurn.turnType, 'MAIN');
  assert.equal(view.questionNumber, 1);
  const aq = world.db.assigned.get(turn.assigned_question_id);
  assert.equal(aq.is_asked, true);
  assert.equal(aq.order_no, 1);
});

// --- resume ----------------------------------------------------------------------

test('resume: a second start returns the same interview and turn with no new rows', async () => {
  const world = buildWorld();
  const first = await start(world);
  const second = await start(world);
  assert.equal(second.interviewId, first.interviewId);
  assert.equal(second.currentTurn.turnId, first.currentTurn.turnId);
  assert.equal(world.db.interviews.size, 1);
  assert.equal(world.db.turns.size, 1);
  assert.equal(world.db.assigned.size, 3);
});

test('resume: remaining answer time comes from the stored deadline (not reset)', async () => {
  const world = buildWorld();
  const view = await start(world);
  await play(world, view);
  world.clock.advance(30 * 1000);
  const resumed = await start(world);
  // think 5 s + answer 120 s from 08:00:00 -> 08:02:05; now 08:00:30.
  assert.equal(resumed.currentTurn.remainingAnswerMs, 95 * 1000);
  assert.equal(resumed.currentTurn.answerDeadlineAt, '2026-03-01T08:02:05.000Z');
});

test('resume: a COMPLETED interview returns the ended view and never a second attempt', async () => {
  const world = buildWorld({ exam: { main_question_count: 1, max_follow_ups_per_question: 0 } });
  const view = await start(world);
  const ended = await answer(world, view, FULL_ANSWER);
  assert.equal(ended.status, 'COMPLETED');
  const again = await start(world);
  assert.equal(again.interviewId, view.interviewId);
  assert.equal(again.status, 'COMPLETED');
  assert.equal(again.currentTurn, null);
  assert.equal(world.db.interviews.size, 1);
});

test('resume: a concurrent-start unique violation resolves to the winner', async () => {
  const world = buildWorld();
  let fired = false;
  world.db.hooks.beforeInterviewCreate = async () => {
    if (fired) return;
    fired = true;
    // Another request for the same student commits first.
    await world.db.vivaInterviewRepository.create({
      examSessionId: EXAM_ID,
      studentId: STUDENT.id,
      status: 'IN_PROGRESS',
      startedAt: new Date(START_ISO),
      deadlineAt: new Date('2026-03-01T08:30:00.000Z'),
    });
  };
  const view = await start(world);
  assert.equal(world.db.interviews.size, 1);
  assert.equal(view.interviewId, [...world.db.interviews.keys()][0]);
  assert.equal(world.db.assigned.size, 0, 'the losing start wrote nothing');
});

// --- markQuestionPlayed ----------------------------------------------------------

test('markQuestionPlayed: answer deadline = played + think + answer limit; replay does not extend', async () => {
  const world = buildWorld();
  const view = await start(world);
  world.clock.advance(3000);
  const played = await play(world, view);
  const turn = turns(world, view)[0];
  assert.equal(turn.status, 'ANSWERING');
  assert.equal(new Date(turn.played_at).toISOString(), '2026-03-01T08:00:03.000Z');
  assert.equal(new Date(turn.answer_deadline_at).toISOString(), '2026-03-01T08:02:08.000Z');
  assert.equal(played.currentTurn.answerOpensAt, '2026-03-01T08:00:08.000Z');
  world.clock.advance(10 * 1000);
  const replay = await play(world, view);
  assert.equal(replay.currentTurn.answerDeadlineAt, '2026-03-01T08:02:08.000Z');
  assert.equal(new Date(turns(world, view)[0].played_at).toISOString(), '2026-03-01T08:00:03.000Z');
});

test('markQuestionPlayed: answer deadline capped by the session deadline', async () => {
  const world = buildWorld({ exam: { session_time_limit_sec: 60 } });
  const view = await start(world);
  const played = await play(world, view);
  assert.equal(played.currentTurn.answerDeadlineAt, '2026-03-01T08:01:00.000Z');
});

test('markQuestionPlayed: non-current turn -> 409 TURN_NOT_CURRENT', async () => {
  const world = buildWorld();
  const view = await start(world);
  await expectError(
    world.service.markQuestionPlayed({ user: STUDENT, interviewId: view.interviewId, turnId: 99999 }),
    409,
    'TURN_NOT_CURRENT',
  );
});

// --- Decision branch 1: deadline ------------------------------------------------------

test('branch 1: deadline passed at submit -> COMPLETED/DEADLINE_REACHED, LLM not called, answer persisted', async () => {
  const world = buildWorld();
  const view = await start(world);
  await play(world, view);
  world.clock.set('2026-03-01T08:31:00.000Z');
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(after.status, 'COMPLETED');
  assert.equal(after.endReason, 'DEADLINE_REACHED');
  assert.equal(after.currentTurn, null);
  assert.equal(world.llm.calls.length, 0);
  const [turn] = turns(world, view);
  assert.equal(turn.status, 'ANSWERED');
  assert.equal(turn.answer_text, PARTIAL_ANSWER);
  assert.equal(turn.timed_out, true);
  assert.equal(turns(world, view).length, 1);
});

test('branch 1: deadline passed then getCurrentState -> COMPLETED lazily, open turn UNANSWERED', async () => {
  const world = buildWorld();
  const view = await start(world);
  world.clock.set('2026-03-01T08:30:00.000Z');
  const state = assertStudentSafeView(world, await world.service.getCurrentState({
    user: STUDENT, interviewId: view.interviewId,
  }));
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.endReason, 'DEADLINE_REACHED');
  assert.equal(turns(world, view)[0].status, 'UNANSWERED');
  // A submit after the lazy end is not accepted.
  const late = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(late.status, 'COMPLETED');
  assert.equal(turns(world, view)[0].answer_text, null);
});

test('branch 1: deadline crossed during the LLM call -> END, no follow-up turn', async () => {
  const world = buildWorld({
    llmScript: [() => { world.clock.set('2026-03-01T08:30:00.000Z'); return validAsk(); }],
  });
  const view = await start(world);
  await play(world, view);
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(world.llm.calls.length, 1);
  assert.equal(after.status, 'COMPLETED');
  assert.equal(after.endReason, 'DEADLINE_REACHED');
  assert.equal(turns(world, view).length, 1);
});

test('final gate: deadline crossed during follow-up TTS -> END, follow-up discarded', async () => {
  const world = buildWorld({ llmScript: [validAsk()] });
  const view = await start(world);
  await play(world, view);
  world.tts.onCall = () => { world.clock.set('2026-03-01T08:30:00.000Z'); };
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(world.llm.calls.length, 1);
  assert.equal(after.status, 'COMPLETED');
  assert.equal(after.endReason, 'DEADLINE_REACHED');
  assert.equal(after.currentTurn, null);
  assert.equal(turns(world, view).length, 1);
  assert.equal(row(world, view).current_follow_up_count, 0);
});

test('final gate: deadline crossed while preparing the next MAIN -> END, no new turn', async () => {
  const world = buildWorld();
  const view = await start(world);
  await play(world, view);
  world.tts.onCall = () => { world.clock.set('2026-03-01T08:30:00.000Z'); };
  // Empty answer -> branch 2 (next main), so only main-question preparation runs.
  const after = await answer(world, view, '');
  assert.equal(world.llm.calls.length, 0);
  assert.equal(after.status, 'COMPLETED');
  assert.equal(after.endReason, 'DEADLINE_REACHED');
  assert.equal(turns(world, view).length, 1);
  // Only the first assigned question was ever asked.
  const asked = [...world.db.assigned.values()]
    .filter((a) => a.interview_id === view.interviewId && a.is_asked);
  assert.equal(asked.length, 1);
  assert.equal(row(world, view).current_question_index, 0);
});

test('final gate: deadline crossed during first-question TTS -> EXAM_CLOSED, no interview row', async () => {
  const world = buildWorld({ exam: { closes_at: '2026-03-01T08:05:00.000Z' } });
  world.tts.onCall = () => { world.clock.set('2026-03-01T08:05:00.000Z'); };
  await expectError(
    world.service.startOrResume({ user: STUDENT, examSessionId: EXAM_ID }),
    409,
    'EXAM_CLOSED',
  );
  assert.equal(world.db.interviews.size, 0);
  assert.equal(world.db.turns.size, 0);
});

// --- Decision branch 2: empty answer ---------------------------------------------------

test('branch 2: empty answer (STT "" with timedOut) -> next MAIN, LLM never called', async () => {
  const world = buildWorld();
  const view = await start(world);
  await play(world, view);
  world.stt.enqueueResult({ text: '' });
  const after = await answer(world, view, undefined, {
    transcript: undefined, audio: Buffer.from('noise'), contentType: 'audio/webm', timedOut: true,
  });
  assert.equal(world.llm.calls.length, 0);
  assert.equal(after.currentTurn.turnType, 'MAIN');
  assert.equal(after.questionNumber, 2);
  assert.equal(after.followUpNumber, 0);
  const [first, second] = turns(world, view);
  assert.equal(first.answer_text, '');
  assert.equal(first.timed_out, true);
  assert.equal(second.turn_type, 'MAIN');
});

test('branch 2: whitespace-only transcript -> next MAIN', async () => {
  const world = buildWorld();
  const view = await start(world);
  const after = await answer(world, view, '   \n ');
  assert.equal(world.llm.calls.length, 0);
  assert.equal(after.currentTurn.turnType, 'MAIN');
});

// --- Decision branch 3: follow-up -------------------------------------------------------

test('branch 3: LLM ASK with follow-ups remaining -> FOLLOW_UP turn with validated rationale', async () => {
  const world = buildWorld({ llmScript: [validAsk()] });
  const view = await start(world);
  await play(world, view);
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(after.currentTurn.turnType, 'FOLLOW_UP');
  assert.equal(after.followUpNumber, 1);
  assert.equal(after.questionNumber, 1);
  assert.equal(row(world, view).current_follow_up_count, 1);
  const followUp = turns(world, view)[1];
  assert.equal(followUp.turn_type, 'FOLLOW_UP');
  assert.equal(followUp.follow_up_reason, 'INCOMPLETE');
  assert.equal(followUp.sequence_no, 2);
  assert.equal(followUp.assigned_question_id, turns(world, view)[0].assigned_question_id);
  assert.equal(followUp.question_text, validAsk().follow_up_question);
  assert.ok(followUp.question_audio_key);
  const r = followUp.rationale;
  assert.equal(r.kind, 'FOLLOW_UP');
  assert.equal(r.why, 'Connection setup and confirmation are missing.');
  assert.deepEqual(r.grounding.map((g) => g.text), ['uses sequence numbers to order']);
  assert.equal(r.unverified_grounding.length, 1);
  assert.equal(r.unverified_grounding[0].note, UNVERIFIED_NOTE);
  assert.equal(JSON.stringify(r).includes('UDP is always faster'), false);
  // The LLM saw the main question, key points and the answer as history.
  const input = world.llm.calls[0];
  assert.deepEqual(input.mainQuestion.keyPoints, KEY_POINTS);
  assert.equal(input.history.at(-1).answerText, PARTIAL_ANSWER);
  assert.equal(input.followUpsUsed, 0);
  assert.equal(input.maxFollowUps, 2);
});

// --- Decision branch 4: next main / end -------------------------------------------------

test('branch 4: follow-up cap reached -> next MAIN and the LLM is not consulted on the capped turn', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 1 } });
  const view = await start(world);
  const fu = await answer(world, view, PARTIAL_ANSWER); // mock LLM: missing points -> ASK
  assert.equal(fu.currentTurn.turnType, 'FOLLOW_UP');
  assert.equal(world.llm.calls.length, 1);
  const next = await answer(world, fu, PARTIAL_ANSWER); // cap reached
  assert.equal(world.llm.calls.length, 1, 'LLM not called once follow-ups are exhausted');
  assert.equal(next.currentTurn.turnType, 'MAIN');
  assert.equal(next.questionNumber, 2);
  assert.equal(next.followUpNumber, 0);
  assert.equal(row(world, view).current_question_index, 1);
  assert.equal(row(world, view).current_follow_up_count, 0);
});

test('branch 4: LLM proposing ASK when the cap is reached cannot extend it', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 1 }, llmScript: [validAsk(), validAsk()] });
  const view = await start(world);
  const fu = await answer(world, view, PARTIAL_ANSWER);
  const next = await answer(world, fu, PARTIAL_ANSWER);
  assert.equal(next.currentTurn.turnType, 'MAIN');
  assert.equal(turns(world, view).filter((t) => t.turn_type === 'FOLLOW_UP').length, 1);
});

test('branch 4: LLM NEXT_MAIN_QUESTION -> next MAIN, index +1, follow-ups reset', async () => {
  const world = buildWorld();
  const view = await start(world);
  const next = await answer(world, view, FULL_ANSWER); // mock: all covered -> NEXT
  assert.equal(world.llm.calls.length, 1);
  assert.equal(next.currentTurn.turnType, 'MAIN');
  assert.equal(next.questionNumber, 2);
  assert.equal(row(world, view).current_question_index, 1);
  assert.equal(row(world, view).current_follow_up_count, 0);
});

test('branch 4: max_follow_ups 0 -> never a follow-up, LLM never called; last main -> QUESTIONS_EXHAUSTED', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 0 } });
  let view = await start(world);
  view = await answer(world, view, PARTIAL_ANSWER);
  view = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(view.questionNumber, 3);
  view = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(view.status, 'COMPLETED');
  assert.equal(view.endReason, 'QUESTIONS_EXHAUSTED');
  assert.equal(world.llm.calls.length, 0);
  assert.ok(turns(world, view).every((t) => t.turn_type === 'MAIN'));
  assert.equal(turns(world, view).length, 3);
});

// --- A4: LLM failures ----------------------------------------------------------------

test('A4: malformed then valid -> follow-up asked after 2 calls, no processing_failure', async () => {
  const world = buildWorld({ llmScript: ['{"next_action": "ASK_FOLLOW_UP",', validAsk()] });
  const view = await start(world);
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(world.llm.calls.length, 2);
  assert.equal(after.currentTurn.turnType, 'FOLLOW_UP');
  assert.equal(failures(world).length, 0);
});

test('A4: malformed twice -> next MAIN + one FOLLOW_UP_LLM / LLM_INVALID_OUTPUT failure, exam continues', async () => {
  const world = buildWorld({ llmScript: ['{bad json', 'still not json'] });
  const view = await start(world);
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(world.llm.calls.length, 2);
  assert.equal(after.status, 'IN_PROGRESS');
  assert.equal(after.currentTurn.turnType, 'MAIN');
  assert.equal(after.questionNumber, 2);
  const f = failures(world);
  assert.equal(f.length, 1);
  assert.equal(f[0].stage, 'FOLLOW_UP_LLM');
  assert.equal(f[0].error_code, 'LLM_INVALID_OUTPUT');
  assert.equal(f[0].retry_count, 1);
  assert.equal(f[0].resolved, false);
  assert.equal(f[0].turn_id, turns(world, view)[0].qa_turn_id);
});

test('A4: LLM throws twice -> LLM_ERROR fallback', async () => {
  const world = buildWorld({ llmScript: [new Error('throttled'), new Error('throttled')] });
  const view = await start(world);
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(after.currentTurn.turnType, 'MAIN');
  assert.equal(failures(world, 'FOLLOW_UP_LLM')[0].error_code, 'LLM_ERROR');
});

test('A4: a never-resolving LLM times out and is treated as an error', async () => {
  const world = buildWorld({ llmScript: ['NEVER', 'NEVER'], env: { followUpLlmTimeoutMs: 20 } });
  const view = await start(world);
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(world.llm.calls.length, 2);
  assert.equal(after.currentTurn.turnType, 'MAIN');
  const [f] = failures(world, 'FOLLOW_UP_LLM');
  assert.equal(f.error_code, 'LLM_ERROR');
  assert.match(f.message, /exceeded 20 ms/);
});

test('A4: a question leaking the reference answer twice -> fallback', async () => {
  const world = buildWorld();
  const view = await start(world);
  const firstQuestion = world.db.questions.get(
    world.db.assigned.get(turns(world, view)[0].assigned_question_id).question_id,
  );
  const leak = validAsk({ follow_up_question: `Is it true that ${firstQuestion.reference_answer}` });
  world.llm.script.push(leak, leak);
  const after = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(after.currentTurn.turnType, 'MAIN');
  assert.equal(failures(world, 'FOLLOW_UP_LLM')[0].error_code, 'LLM_INVALID_OUTPUT');
});

// --- Answer inputs ----------------------------------------------------------------------

test('answer: audio is stored to S3 then transcribed with language + key-point hints', async () => {
  const world = buildWorld({ exam: { language: 'VI' } });
  const sttCalls = [];
  const original = world.stt.transcribe.bind(world.stt);
  world.stt.transcribe = async (args) => { sttCalls.push(args); return original(args); };
  const view = await start(world);
  await play(world, view);
  const audio = Buffer.from(PARTIAL_ANSWER);
  await answer(world, view, undefined, { transcript: undefined, audio, contentType: 'audio/webm;codecs=opus' });
  const turnId = view.currentTurn.turnId;
  assert.equal(world.s3.puts.length, 1);
  assert.equal(world.s3.puts[0].bucket, 'test-audio-bucket');
  assert.equal(world.s3.puts[0].key, `interviews/${view.interviewId}/turns/${turnId}/answer.webm`);
  assert.equal(world.s3.puts[0].body, audio);
  assert.equal(sttCalls.length, 1);
  assert.equal(sttCalls[0].audio, audio);
  assert.equal(sttCalls[0].language, 'VI');
  assert.deepEqual(sttCalls[0].hints, KEY_POINTS);
  const turn = world.db.turns.get(turnId);
  assert.equal(turn.answer_audio_key, `interviews/${view.interviewId}/turns/${turnId}/answer.webm`);
  assert.equal(turn.answer_text, PARTIAL_ANSWER);
  assert.equal(turn.transcript_confidence, 0.95);
});

test('answer: a client transcript skips S3 and STT', async () => {
  const world = buildWorld();
  let sttCalled = false;
  world.stt.transcribe = async () => { sttCalled = true; return { text: 'x' }; };
  const view = await start(world);
  await answer(world, view, PARTIAL_ANSWER, { transcript: { text: PARTIAL_ANSWER, confidence: 0.8 } });
  assert.equal(world.s3.puts.length, 0);
  assert.equal(sttCalled, false);
  const turn = world.db.turns.get(view.currentTurn.turnId);
  assert.equal(turn.answer_text, PARTIAL_ANSWER);
  assert.equal(turn.transcript_confidence, 0.8);
  assert.equal(turn.answer_audio_key, null);
});

test('answer: STT retries end at the exam deadline without creating another turn', async () => {
  const world = buildWorld();
  const view = await play(world, await start(world));
  world.stt.transcribe = async () => { throw new Error('provider unavailable'); };
  const args = { user: STUDENT, interviewId: view.interviewId, turnId: view.currentTurn.turnId,
    audio: Buffer.from('audio'), contentType: 'audio/webm' };
  await assert.rejects(() => world.service.submitAnswer(args), { code: 'STT_FAILED' });
  world.clock.advance(1801 * 1000);
  const ended = assertStudentSafeView(world, await world.service.submitAnswer(args));
  assert.equal(ended.status, 'COMPLETED');
  assert.equal(ended.endReason, 'DEADLINE_REACHED');
  assert.equal(ended.currentTurn, null);
  assert.equal(world.db.turns.size, 1);
});

test('answer: partial segments only -> joined text is used, then cleared', async () => {
  const world = buildWorld();
  const view = await start(world);
  await play(world, view);
  const base = { user: STUDENT, interviewId: view.interviewId, turnId: view.currentTurn.turnId };
  const r1 = await world.service.appendPartialTranscript({ ...base, text: 'TCP uses sequence numbers', confidence: 0.7 });
  const r2 = await world.service.appendPartialTranscript({ ...base, text: 'to order bytes' });
  assertStudentSafeView(world, r1);
  assert.deepEqual(r1, { accepted: true });
  assert.deepEqual(r2, { accepted: true });
  assert.equal((await world.sessionContextStore.get(view.interviewId)).partialSegments.length, 2);
  await answer(world, view, undefined, { transcript: undefined });
  assert.equal(world.db.turns.get(view.currentTurn.turnId).answer_text, 'TCP uses sequence numbers to order bytes');
  assert.deepEqual((await world.sessionContextStore.get(view.interviewId)).partialSegments, []);
});

test('answer: partial transcript for a non-current turn -> 409', async () => {
  const world = buildWorld();
  const view = await start(world);
  await expectError(world.service.appendPartialTranscript({
    user: STUDENT, interviewId: view.interviewId, turnId: 4242, text: 'x',
  }), 409, 'TURN_NOT_CURRENT');
});

test('answer: STT failure -> 502 STT_FAILED, turn released, failure recorded, resubmit succeeds', async () => {
  const world = buildWorld();
  const view = await start(world);
  await play(world, view);
  const original = world.stt.transcribe.bind(world.stt);
  world.stt.transcribe = async () => { throw new Error('stt down'); };
  await expectError(
    answer(world, view, undefined, { transcript: undefined, audio: Buffer.from(PARTIAL_ANSWER) }),
    502,
    'STT_FAILED',
  );
  assert.equal(world.db.turns.get(view.currentTurn.turnId).status, 'ANSWERING');
  assert.equal(failures(world, 'STT').length, 1);
  world.stt.transcribe = original;
  const after = await answer(world, view, undefined, { transcript: undefined, audio: Buffer.from(PARTIAL_ANSWER) });
  assert.equal(world.db.turns.get(view.currentTurn.turnId).status, 'ANSWERED');
  assert.ok(after.currentTurn.turnId !== view.currentTurn.turnId);
});

test('answer: S3 failure -> continues with a null audio key + AUDIO_STORE failure', async () => {
  const world = buildWorld();
  world.s3.failWith = new Error('s3 down');
  const view = await start(world);
  await answer(world, view, undefined, { transcript: undefined, audio: Buffer.from(PARTIAL_ANSWER) });
  const turn = world.db.turns.get(view.currentTurn.turnId);
  assert.equal(turn.answer_audio_key, null);
  assert.equal(turn.answer_text, PARTIAL_ANSWER);
  assert.equal(failures(world, 'AUDIO_STORE').length, 1);
});

test('answer: TTS failure -> question still asked with a null audio key + TTS failure', async () => {
  const world = buildWorld();
  world.tts.failWith = new Error('tts down');
  const view = await start(world);
  assert.equal(view.status, 'IN_PROGRESS');
  assert.equal(view.currentTurn.audioKey, null);
  assert.equal(turns(world, view)[0].question_audio_key, null);
  const [f] = failures(world, 'TTS');
  assert.equal(f.turn_id, view.currentTurn.turnId);
});

// --- Concurrency / state --------------------------------------------------------------

test('state: a concurrent double submit -> one wins, the other gets 409 TURN_NOT_ACTIVE', async () => {
  const world = buildWorld();
  const view = await start(world);
  const results = await Promise.allSettled([
    answer(world, view, PARTIAL_ANSWER),
    answer(world, view, PARTIAL_ANSWER),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.code, 'TURN_NOT_ACTIVE');
  assert.equal(rejected.reason.statusCode, 409);
});

test('state: a submit for a non-current turn -> 409 TURN_NOT_CURRENT', async () => {
  const world = buildWorld();
  const view = await start(world);
  const next = await answer(world, view, FULL_ANSWER);
  assert.ok(next.currentTurn.turnId !== view.currentTurn.turnId);
  await expectError(answer(world, view, PARTIAL_ANSWER), 409, 'TURN_NOT_CURRENT');
});

test('state: a late submit after the answer deadline is accepted with timed_out = true', async () => {
  const world = buildWorld();
  const view = await start(world);
  await play(world, view);
  world.clock.advance(200 * 1000);
  await answer(world, view, PARTIAL_ANSWER);
  const turn = world.db.turns.get(view.currentTurn.turnId);
  assert.equal(turn.status, 'ANSWERED');
  assert.equal(turn.timed_out, true);
  assert.equal(turn.answer_text, PARTIAL_ANSWER);
});

test('state: a fresh service instance continues the interview (no in-memory state)', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 0 } });
  const view = await start(world);
  const other = world.makeService();
  await play(world, view, other);
  const next = await answer(world, view, PARTIAL_ANSWER, {}, world.makeService());
  assert.equal(next.questionNumber, 2);
  assert.equal(next.currentTurn.turnType, 'MAIN');
});

test('state: a deleted DynamoDB context is rebuilt from Postgres on the next call', async () => {
  const world = buildWorld();
  const view = await start(world);
  const next = await answer(world, view, FULL_ANSWER);
  await world.sessionContextStore.delete(view.interviewId);
  assert.equal(await world.sessionContextStore.get(view.interviewId), null);
  const state = await world.service.getCurrentState({ user: STUDENT, interviewId: view.interviewId });
  assert.equal(state.currentTurn.turnId, next.currentTurn.turnId);
  const ctx = await world.sessionContextStore.get(view.interviewId);
  assert.equal(ctx.currentTurnId, next.currentTurn.turnId);
  assert.equal(ctx.currentQuestionIndex, 1);
  assert.equal(ctx.deadlineAt, '2026-03-01T08:30:00.000Z');
});

test('state: context holds current turn, deadline and covered key points after an LLM decision', async () => {
  const world = buildWorld();
  const view = await start(world);
  const firstTurn = turns(world, view)[0];
  const after = await answer(world, view, PARTIAL_ANSWER); // mock covers 'sequence numbers'
  const ctx = await world.sessionContextStore.get(view.interviewId);
  assert.equal(ctx.sessionId, `interview#${view.interviewId}`);
  assert.equal(ctx.currentTurnId, after.currentTurn.turnId);
  assert.equal(ctx.currentFollowUpCount, 1);
  assert.equal(ctx.deadlineAt, '2026-03-01T08:30:00.000Z');
  assert.deepEqual(ctx.coveredKeyPoints[String(firstTurn.assigned_question_id)], ['sequence numbers']);
  assert.equal(ctx.expiresAt, Math.floor(Date.parse('2026-03-01T08:30:00.000Z') / 1000) + 3600);
});

// --- Rationale --------------------------------------------------------------------------

test('rationale: stored on every MAIN (AI and lecturer-authored) and FOLLOW_UP turn', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 1 } });
  let view = await start(world);
  while (view.status === 'IN_PROGRESS') {
    // eslint-disable-next-line no-await-in-loop
    view = await answer(world, view, PARTIAL_ANSWER);
  }
  const all = turns(world, view);
  assert.ok(all.some((t) => t.turn_type === 'FOLLOW_UP'));
  for (const t of all) {
    assert.ok(t.rationale, `turn ${t.sequence_no} has rationale`);
    if (t.turn_type === 'FOLLOW_UP') {
      assert.equal(t.rationale.kind, 'FOLLOW_UP');
    } else {
      const q = world.db.questions.get(world.db.assigned.get(t.assigned_question_id).question_id);
      assert.equal(t.rationale.kind, q.source === 'AI' ? 'MAIN_AI' : 'MAIN_LECTURER');
      if (q.source === 'AI') {
        assert.equal(t.rationale.purpose, `AI purpose ${q.question_id}`);
        assert.equal(t.rationale.grounding[0].material_title, 'Networking notes');
      } else {
        assert.equal(t.rationale.label, 'Câu do giảng viên soạn');
      }
    }
  }
  const kinds = new Set(all.map((t) => t.rationale.kind));
  assert.ok(kinds.has('MAIN_LECTURER') || kinds.has('MAIN_AI'));
});

test('rationale: snapshot is not affected by later question edits', async () => {
  const world = buildWorld();
  const view = await start(world);
  const turn = turns(world, view)[0];
  const before = structuredClone(turn.rationale);
  const q = world.db.questions.get(world.db.assigned.get(turn.assigned_question_id).question_id);
  q.rationale = { purpose: 'EDITED LATER', synthesis: 'EDITED' };
  q.key_points = ['edited point'];
  await world.service.getCurrentState({ user: STUDENT, interviewId: view.interviewId });
  assert.deepEqual(turns(world, view)[0].rationale, before);
});

// --- Completion ---------------------------------------------------------------------------

test('completion: transcript complete, viva_result PENDING once, GRADE_INTERVIEW enqueued once', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 0 } });
  let view = await start(world);
  const answers = ['first answer text', 'second answer text', 'third answer text'];
  for (const text of answers) {
    // eslint-disable-next-line no-await-in-loop
    view = await answer(world, view, text);
  }
  assert.equal(view.status, 'COMPLETED');
  const transcript = world.db.transcripts.get(view.interviewId);
  assert.equal(transcript.is_complete, true);
  for (const t of turns(world, view)) {
    assert.ok(transcript.full_text.includes(`Q: ${t.question_text}`));
  }
  answers.forEach((a) => assert.ok(transcript.full_text.includes(`A: ${a}`)));
  assert.equal(world.db.results.get(view.interviewId).status, 'PENDING');
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await world.service.getCurrentState({ user: STUDENT, interviewId: view.interviewId });
    // eslint-disable-next-line no-await-in-loop
    await start(world);
  }
  assert.deepEqual(world.enqueueJob.jobs, [{ type: 'GRADE_INTERVIEW', payload: { interviewId: view.interviewId } }]);
  assert.equal(world.db.results.size, 1);
  assert.ok(row(world, view).ended_at);
  const ctx = await world.sessionContextStore.get(view.interviewId);
  assert.equal(ctx.status, 'COMPLETED');
  assert.equal(ctx.currentTurnId, null);
});

test('completion: an enqueue failure records GRADE_ENQUEUE and the interview stays COMPLETED', async () => {
  const world = buildWorld({ exam: { main_question_count: 1, max_follow_ups_per_question: 0 } });
  world.enqueueJob.failWith = new Error('queue down');
  const view = await start(world);
  const ended = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(ended.status, 'COMPLETED');
  assert.equal(row(world, view).status, 'COMPLETED');
  assert.equal(failures(world, 'GRADE_ENQUEUE').length, 1);
});

// --- Student safety across every public method ----------------------------------------------

test('student safety: no engine return value exposes rationale, answers or key points', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 1 } });
  // startOrResume / markQuestionPlayed / appendPartialTranscript / submitAnswer
  // and getCurrentState all go through assertStudentSafeView in the helpers;
  // walk a full interview (main, follow-up, completed) to cover every state.
  let view = await start(world);
  view = await play(world, view);
  assertStudentSafeView(world, await world.service.appendPartialTranscript({
    user: STUDENT, interviewId: view.interviewId, turnId: view.currentTurn.turnId, text: 'partial',
  }));
  view = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(view.currentTurn.turnType, 'FOLLOW_UP');
  assertStudentSafeView(world, await world.service.getCurrentState({ user: STUDENT, interviewId: view.interviewId }));
  while (view.status === 'IN_PROGRESS') {
    // eslint-disable-next-line no-await-in-loop
    view = await answer(world, view, FULL_ANSWER);
  }
  assert.equal(view.status, 'COMPLETED');
  assertStudentSafeView(world, await world.service.getCurrentState({ user: STUDENT, interviewId: view.interviewId }));
  assertStudentSafeView(world, await start(world));
});

// --- Step 12: schedule window, balanced picking, total follow-up cap ----------------

test('start: OPEN but before opens_at -> 409 EXAM_NOT_STARTED, nothing written', async () => {
  const world = buildWorld({ exam: { opens_at: '2026-03-01T08:30:00.000Z' } });
  await expectError(start(world), 409, 'EXAM_NOT_STARTED');
  assert.equal(world.db.interviews.size, 0);
  world.clock.set('2026-03-01T08:30:00.000Z');
  const view = await start(world);
  assert.equal(view.status, 'IN_PROGRESS');
});

test('start: exam row locked, STT warmed in the exam language without blocking', async () => {
  const world = buildWorld({ exam: { language: 'VI' } });
  const warmCalls = [];
  let release;
  world.stt.warmUp = (lang) => {
    warmCalls.push(lang);
    return new Promise((resolve) => { release = resolve; });
  };
  const view = await start(world);
  assert.equal(view.status, 'IN_PROGRESS');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(warmCalls, ['vi']);
  assert.deepEqual(world.db.examLocks, [EXAM_ID]);
  release({ ok: true });
});

test('start: an STT warm-up failure does not affect the start', async () => {
  const world = buildWorld();
  world.stt.warmUp = async () => { throw new Error('lambda down'); };
  const view = await start(world);
  assert.equal(view.status, 'IN_PROGRESS');
});

function assignedIds(world, interviewId) {
  return [...world.db.assigned.values()]
    .filter((a) => a.interview_id === interviewId)
    .sort((a, b) => a.order_no - b.order_no)
    .map((a) => a.question_id);
}

test('start: consecutive candidates get no overlap and the same Bloom mix', async () => {
  const world = buildWorld({
    approvedCount: 12,
    bloomLevels: ['REMEMBER', 'UNDERSTAND', 'APPLY'],
    exam: { main_question_count: 3 },
  });
  const ids = [];
  for (let s = 0; s < 6; s += 1) {
    const student = { id: 500 + s, role: 'STUDENT' };
    world.db.rosters.get(EXAM_ID).add(student.id);
    world.clock.advance(60 * 1000);
    // eslint-disable-next-line no-await-in-loop
    const view = await start(world, student);
    ids.push(assignedIds(world, view.interviewId));
  }
  const levelOf = (qid) => world.db.questions.get(qid).bloom_level;
  for (let c = 0; c < ids.length; c += 1) {
    assert.deepEqual(ids[c].map(levelOf), ['REMEMBER', 'UNDERSTAND', 'APPLY']);
    // 12 / 3 -> K = 3 previous candidates never overlap.
    for (let back = 1; back <= 3 && c - back >= 0; back += 1) {
      assert.deepEqual(ids[c].filter((q) => ids[c - back].includes(q)), [], `candidate ${c} vs ${c - back}`);
    }
  }
  // Least-used first: after 4 candidates every question was used once.
  const usage = new Map();
  ids.slice(0, 4).flat().forEach((q) => usage.set(q, (usage.get(q) || 0) + 1));
  assert.equal(usage.size, 12);
});

test('start: bloom_distribution of the exam is honored', async () => {
  const world = buildWorld({
    approvedCount: 8,
    bloomLevels: ['REMEMBER', 'APPLY'],
    exam: { main_question_count: 3, bloom_distribution: { APPLY: 2, REMEMBER: 1 } },
  });
  const view = await start(world);
  const levels = assignedIds(world, view.interviewId).map((q) => world.db.questions.get(q).bloom_level);
  assert.deepEqual(levels, ['REMEMBER', 'APPLY', 'APPLY']);
});

test('follow-up total cap: max_follow_ups_total stops follow-ups across main questions', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 2, max_follow_ups_total: 1 } });
  const view = await start(world);
  const fu = await answer(world, view, PARTIAL_ANSWER); // mock LLM -> ASK
  assert.equal(fu.currentTurn.turnType, 'FOLLOW_UP');
  assert.equal(world.llm.calls[0].maxFollowUps, 1, 'prompt budget is the tighter cap');
  const next = await answer(world, fu, PARTIAL_ANSWER); // total cap reached
  assert.equal(next.currentTurn.turnType, 'MAIN');
  assert.equal(world.llm.calls.length, 1, 'LLM not consulted once the total cap is reached');
  const third = await answer(world, next, PARTIAL_ANSWER);
  assert.equal(third.currentTurn.turnType, 'MAIN');
  assert.equal(world.llm.calls.length, 1);
  assert.equal(turns(world, view).filter((t) => t.turn_type === 'FOLLOW_UP').length, 1);
});

test('follow-up total cap: null keeps the per-question behaviour', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 1, max_follow_ups_total: null } });
  const view = await start(world);
  const fu = await answer(world, view, PARTIAL_ANSWER);
  const next = await answer(world, fu, PARTIAL_ANSWER);
  const fu2 = await answer(world, next, PARTIAL_ANSWER);
  assert.equal(fu2.currentTurn.turnType, 'FOLLOW_UP');
});

test('F9 sweep: expireOverdueInterviews ends overdue active interviews and enqueues grading', async () => {
  const world = buildWorld();
  const v1 = await start(world, STUDENT);
  const interview1 = world.db.interviews.get(v1.interviewId);
  interview1.deadline_at = new Date(Date.parse(START_ISO) + 1800 * 1000);

  const v2 = await start(world, OTHER_STUDENT);
  const interview2 = world.db.interviews.get(v2.interviewId);
  interview2.deadline_at = new Date(Date.parse(START_ISO) + 3600 * 1000);

  world.clock.set(new Date(Date.parse(START_ISO) + 1835 * 1000).toISOString());

  const res1 = await world.service.expireOverdueInterviews({ graceSec: 30 });
  assert.equal(res1.ended, 1);

  assert.equal(interview1.status, 'COMPLETED');
  assert.equal(interview1.end_reason, 'DEADLINE_REACHED');

  const result1 = world.db.results.get(v1.interviewId);
  assert.ok(result1, 'viva_result should exist');
  assert.equal(result1.status, 'PENDING');

  const gradeJobs = world.enqueueJob.jobs.filter((c) => c.type === 'GRADE_INTERVIEW');
  assert.equal(gradeJobs.length, 1);
  assert.equal(gradeJobs[0].payload.interviewId, v1.interviewId);

  assert.equal(interview2.status, 'IN_PROGRESS');
  assert.equal(world.db.results.has(v2.interviewId), false);

  const res2 = await world.service.expireOverdueInterviews({ graceSec: 30 });
  assert.equal(res2.ended, 0);
  assert.equal(world.enqueueJob.jobs.filter((c) => c.type === 'GRADE_INTERVIEW').length, 1);
});

test('F9 sweep: records failure when ending a single overdue interview fails and proceeds', async () => {
  const world = buildWorld();
  const v = await start(world, STUDENT);
  const iv = world.db.interviews.get(v.interviewId);
  iv.deadline_at = new Date(Date.parse(START_ISO) + 1000);
  world.clock.set(new Date(Date.parse(START_ISO) + 60000).toISOString());

  const origComplete = world.db.vivaInterviewRepository.completeIfActive;
  world.db.vivaInterviewRepository.completeIfActive = async () => {
    throw new Error('simulated DB complete failure');
  };

  const res = await world.service.expireOverdueInterviews({ graceSec: 30 });
  assert.equal(res.ended, 0);
  assert.equal(world.db.failures.length, 1);
  assert.equal(world.db.failures[0].stage, 'EXPIRE_SWEEP');
  assert.equal(world.db.failures[0].interview_id, v.interviewId);

  world.db.vivaInterviewRepository.completeIfActive = origComplete;
});

test('submitAnswer persists speech signals including pause_count into qaTurnRepository', async () => {
  const world = buildWorld();
  const v0 = await start(world);
  const v1 = await play(world, v0);
  const turnId = v1.currentTurn.turnId;

  await answer(world, v1, FULL_ANSWER, {
    signals: {
      responseLatencyMs: 1200,
      speechDurationMs: 15000,
      wordsPerMinute: 110,
      pause_count: 3,
    },
  });

  const turnRow = world.db.turns.get(Number(turnId));
  assert.equal(turnRow.response_latency_ms, 1200);
  assert.equal(turnRow.speech_duration_ms, 15000);
  assert.equal(turnRow.words_per_minute, 110);
  assert.equal(turnRow.pause_count, 3);
});


test('assigned knowledge freezes later main text, follow-up reference/rubric/source context and student privacy', async () => {
  const world = buildWorld();
  for (const q of world.db.questions.values()) { q.future_private_field = 'UNRELATED'; q.review_note = 'NOT SNAPSHOT CONTENT'; }
  const view = await start(world);
  const assigned = [...world.db.assigned.values()].filter(a => a.interview_id === view.interviewId).sort((a, b) => a.order_no - b.order_no);
  const original = structuredClone(assigned[0].knowledge_snapshot);
  assert.equal(Object.hasOwn(original, 'future_private_field'), false);
  assert.equal(Object.hasOwn(original, 'review_note'), false);
  assert.equal(Object.hasOwn(original, 'embedding'), false);
  const nextText = assigned[1].knowledge_snapshot.content;
  for (const question of world.db.questions.values()) {
    question.content = 'MUTATED BANK TEXT'; question.reference_answer = 'MUTATED SECRET';
    question.key_points = ['MUTATED POINT'];
  }
  world.db.rubrics.clear(); world.db.sourceRefs.clear();
  world.db.questionRepository.findById = async () => { throw new Error('mutable question read'); };
  world.db.rubricRepository.findById = async () => { throw new Error('mutable rubric read'); };
  const follow = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(world.llm.calls[0].mainQuestion.referenceAnswer, original.reference_answer);
  assert.deepEqual(world.llm.calls[0].mainQuestion.keyPoints, original.key_points);
  assert.deepEqual(world.llm.calls[0].rubricCriteria, original.rubric_snapshot.criteria.map(c => c.criterion_name));
  assert.equal(JSON.stringify(follow).includes('MUTATED SECRET'), false);
  // Empty response skips any follow-up and advances to the original next main.
  const next = await answer(world, follow, '');
  assert.equal(next.currentTurn.questionText, nextText);
  assertStudentSafeView(world, next);
});

test('legacy in-progress assignments continue frozen operational prompts without consulting mutable knowledge', async () => {
  const world = buildWorld();
  const view = await start(world);
  const originalTurn = structuredClone(world.db.turnsOf(view.interviewId)[0]);
  const assigned = [...world.db.assigned.values()].filter(a => a.interview_id === view.interviewId).sort((a, b) => a.order_no - b.order_no);
  const nextText = assigned[1].knowledge_snapshot.content;
  for (const row of assigned) {
    row.legacy_question_text = row.knowledge_snapshot.content;
    row.legacy_prompt_source = 'BANK_AT_MIGRATION';
    row.knowledge_snapshot = null;
  }
  world.db.questionRepository.findById = async () => { throw new Error('mutable question read'); };
  const next = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(world.llm.calls.length, 0);
  assert.equal(next.currentTurn.questionText, nextText);
  assert.equal(world.db.turnsOf(view.interviewId)[0].question_text, originalTurn.question_text);
});
