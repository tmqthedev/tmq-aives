const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWorld, EXAM_ID, STUDENT, OTHER_STUDENT, KEY_POINTS,
} = require('./helpers/interviewFakes');

const PARTIAL_ANSWER = 'TCP uses sequence numbers to order the bytes it sends.';
const FULL_ANSWER = `TCP relies on the ${KEY_POINTS.join(', the ')} to deliver data reliably.`;

async function start(world, user = STUDENT, service = world.service) {
  return service.startOrResume({ user, examSessionId: EXAM_ID });
}

async function play(world, view, service = world.service) {
  return service.markQuestionPlayed({
    user: STUDENT, interviewId: view.interviewId, turnId: view.currentTurn.turnId,
  });
}

async function answer(world, view, text, extra = {}, service = world.service) {
  return service.submitAnswer({
    user: STUDENT,
    interviewId: view.interviewId,
    turnId: view.currentTurn.turnId,
    transcript: { text },
    ...extra,
  });
}

async function expectError(promise, statusCode, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, statusCode, `status ${err.statusCode} ${err.code}`);
    assert.equal(err.code, code);
    return true;
  });
}

function assertNoForbiddenLeak(view) {
  const json = JSON.stringify(view);
  for (const needle of ['reference_answer', 'key_points', 'rationale', 'rubric', 'score', 'snapshot', 'audio']) {
    assert.equal(json.includes(needle), false, `transcript DTO leaked "${needle}"`);
  }
  return view;
}

// --- transcript history -------------------------------------------------------------

test('getTranscript: answered turns plus the current asked question, ordered, no forbidden keys', async () => {
  const world = buildWorld({ exam: { max_follow_ups_per_question: 1 } });
  let view = await start(world);

  // Before answering: only the current asked question with transcript null.
  const before = assertNoForbiddenLeak(await world.service.getTranscript({
    user: STUDENT, interviewId: view.interviewId,
  }));
  assert.equal(before.interviewId, view.interviewId);
  assert.equal(before.status, 'IN_PROGRESS');
  assert.equal(before.turns.length, 1);
  assert.equal(before.turns[0].turnType, 'MAIN');
  assert.equal(before.turns[0].transcript, null);
  assert.equal(before.turns[0].answeredAt, null);
  assert.equal(before.turns[0].sttDisputed, false);
  assert.equal(before.turns[0].sttDisputeNote, null);

  // Answer the main question; the mock LLM asks one follow-up.
  view = await play(world, view);
  view = await answer(world, view, PARTIAL_ANSWER);
  assert.equal(view.currentTurn.turnType, 'FOLLOW_UP');

  const mid = assertNoForbiddenLeak(await world.service.getTranscript({
    user: STUDENT, interviewId: view.interviewId,
  }));
  assert.equal(mid.turns.length, 2);
  assert.equal(mid.turns[0].turnType, 'MAIN');
  assert.equal(mid.turns[0].sequenceNo, 1);
  assert.equal(mid.turns[0].transcript, PARTIAL_ANSWER);
  assert.equal(mid.turns[0].answeredAt, '2026-03-01T08:00:00.000Z');
  assert.equal(mid.turns[1].turnType, 'FOLLOW_UP');
  assert.equal(mid.turns[1].sequenceNo, 2);
  assert.equal(mid.turns[1].transcript, null);
  assert.equal(mid.turns[1].answeredAt, null);
});

test('getTranscript: completed interview returns every answered turn and no current asked', async () => {
  const world = buildWorld({ exam: { main_question_count: 1, max_follow_ups_per_question: 0 } });
  let view = await start(world);
  view = await answer(world, view, FULL_ANSWER);
  assert.equal(view.status, 'COMPLETED');

  const transcript = assertNoForbiddenLeak(await world.service.getTranscript({
    user: STUDENT, interviewId: view.interviewId,
  }));
  assert.equal(transcript.status, 'COMPLETED');
  assert.equal(transcript.turns.length, 1);
  assert.equal(transcript.turns[0].transcript, FULL_ANSWER);
  assert.equal(transcript.turns[0].sttDisputed, false);
});

test('getTranscript: another student gets 404', async () => {
  const world = buildWorld();
  const view = await start(world);
  await expectError(
    world.service.getTranscript({ user: OTHER_STUDENT, interviewId: view.interviewId }),
    404,
    'INTERVIEW_NOT_FOUND',
  );
});

// --- turn:transcribed payload source ---------------------------------------------------

test('getTranscribedTurn: returns the answer shape only once answered, null before, 404 for others', async () => {
  const world = buildWorld();
  let view = await start(world);
  const turnId = view.currentTurn.turnId;

  assert.equal(await world.service.getTranscribedTurn({
    user: STUDENT, interviewId: view.interviewId, turnId,
  }), null);

  await play(world, view);
  await answer(world, view, PARTIAL_ANSWER);

  assert.deepEqual(await world.service.getTranscribedTurn({
    user: STUDENT, interviewId: view.interviewId, turnId,
  }), {
    interviewId: view.interviewId,
    turnId,
    sequenceNo: 1,
    transcript: PARTIAL_ANSWER,
  });

  await expectError(
    world.service.getTranscribedTurn({ user: OTHER_STUDENT, interviewId: view.interviewId, turnId }),
    404,
    'INTERVIEW_NOT_FOUND',
  );
});

// --- STT dispute -----------------------------------------------------------------------

test('disputeStt: flags an answered turn and idempotently updates the note', async () => {
  const world = buildWorld();
  let view = await start(world);
  const turnId = view.currentTurn.turnId;
  await play(world, view);
  await answer(world, view, PARTIAL_ANSWER);

  const out = await world.service.disputeStt({
    user: STUDENT, interviewId: view.interviewId, turnId, note: 'Misheard the term.',
  });
  assert.deepEqual(out, { turnId, sttDisputed: true, sttDisputeNote: 'Misheard the term.' });

  const row = world.db.turns.get(Number(turnId));
  assert.ok(row.stt_disputed_at);
  assert.equal(row.stt_dispute_note, 'Misheard the term.');

  const out2 = await world.service.disputeStt({
    user: STUDENT, interviewId: view.interviewId, turnId, note: 'Corrected note.',
  });
  assert.deepEqual(out2, { turnId, sttDisputed: true, sttDisputeNote: 'Corrected note.' });
  assert.equal(world.db.turns.get(Number(turnId)).stt_dispute_note, 'Corrected note.');
});

test('disputeStt: other student 404, unanswered 409, long note 400, finalized 409', async () => {
  const world = buildWorld({ exam: { main_question_count: 1, max_follow_ups_per_question: 0 } });
  let view = await start(world);
  const turnId = view.currentTurn.turnId;

  await expectError(
    world.service.disputeStt({ user: OTHER_STUDENT, interviewId: view.interviewId, turnId, note: 'x' }),
    404,
    'INTERVIEW_NOT_FOUND',
  );
  await expectError(
    world.service.disputeStt({ user: STUDENT, interviewId: view.interviewId, turnId, note: 'x' }),
    409,
    'TURN_NOT_ANSWERED',
  );

  await play(world, view);
  view = await answer(world, view, FULL_ANSWER);
  assert.equal(view.status, 'COMPLETED');

  await expectError(
    world.service.disputeStt({ user: STUDENT, interviewId: view.interviewId, turnId, note: 'x'.repeat(501) }),
    400,
    'VALIDATION_ERROR',
  );

  world.db.results.get(view.interviewId).status = 'FINALIZED';
  await expectError(
    world.service.disputeStt({ user: STUDENT, interviewId: view.interviewId, turnId, note: 'ok' }),
    409,
    'RESULT_FINALIZED',
  );
});

test('disputeStt: publishes a realtime invalidation with ids', async () => {
  const published = [];
  const world = buildWorld({ exam: { subject_id: 7, main_question_count: 1, max_follow_ups_per_question: 0 } });
  const service = world.makeService({
    realtimeBus: { publish(entity, payload) { published.push({ entity, payload }); } },
  });

  let view = await start(world, STUDENT, service);
  const turnId = view.currentTurn.turnId;
  await play(world, view, service);
  view = await answer(world, view, FULL_ANSWER, {}, service);

  await service.disputeStt({ user: STUDENT, interviewId: view.interviewId, turnId, note: 'flag' });

  const evt = published.find((p) => p.entity === 'interview' && p.payload.action === 'updated');
  assert.ok(evt, 'expected an interview:updated invalidation');
  assert.equal(evt.payload.interviewId, view.interviewId);
  assert.equal(evt.payload.examSessionId, EXAM_ID);
  assert.equal(evt.payload.subjectId, 7);
});
