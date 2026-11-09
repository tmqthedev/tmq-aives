const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: Client } = require('socket.io-client');
const { TokenService } = require('../src/auth/tokenService');
const { attachInterviewSocket } = require('../src/realtime/interviewSocket');

const tokenService = new TokenService({ secret: 'test-secret-that-is-at-least-32-chars-long!!' });

function mintCookie(role = 'STUDENT', sub = 10) {
  const { token } = tokenService.signAccess({ sub, role, code: `U${sub}` });
  return `access_token=${token}`;
}

test('Socket.IO rejects connection without access_token cookie', async () => {
  const server = http.createServer();
  attachInterviewSocket(server, {
    interviewService: {},
    tokenService,
  });

  await new Promise((resolve) => {
    server.listen(0, resolve);
  });
  const port = server.address().port;

  const client = Client(`http://localhost:${port}/interview`, {
    transports: ['websocket'],
    autoConnect: false,
  });

  const err = await new Promise((resolve) => {
    client.on('connect_error', (error) => {
      resolve(error);
    });
    client.connect();
  });

  assert.match(err.message, /AUTHENTICATION_REQUIRED/);
  client.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('Socket.IO rejects connection when user role is not STUDENT', async () => {
  const server = http.createServer();
  attachInterviewSocket(server, {
    interviewService: {},
    tokenService,
  });

  await new Promise((resolve) => {
    server.listen(0, resolve);
  });
  const port = server.address().port;

  const client = Client(`http://localhost:${port}/interview`, {
    transports: ['websocket'],
    autoConnect: false,
    extraHeaders: {
      cookie: mintCookie('LECTURER', 99),
    },
  });

  const err = await new Promise((resolve) => {
    client.on('connect_error', (error) => {
      resolve(error);
    });
    client.connect();
  });

  assert.match(err.message, /FORBIDDEN_STUDENT_ONLY/);
  client.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('Socket.IO connects and handles interview lifecycle events', async () => {
  const fakeState = {
    interviewId: 100,
    status: 'IN_PROGRESS',
    currentQuestionIndex: 0,
    currentFollowUpCount: 0,
    totalQuestions: 3,
    maxFollowUpsPerQuestion: 2,
    thinkTimeSec: 15,
    answerTimeSec: 120,
    currentTurn: {
      turnId: 501,
      turnType: 'MAIN',
      questionText: 'What is Encapsulation?',
      questionAudioKey: 'tts/encap.mp3',
    },
  };

  const playedState = {
    ...fakeState,
    currentTurn: {
      ...fakeState.currentTurn,
      status: 'ANSWERING',
    },
  };

  const answeredState = {
    ...fakeState,
    currentQuestionIndex: 0,
    currentFollowUpCount: 1,
    currentTurn: {
      turnId: 502,
      turnType: 'FOLLOW_UP',
      questionText: 'Can you provide an example?',
      questionAudioKey: null,
    },
  };

  let submittedSignals = null;

  const fakeInterviewService = {
    async getCurrentState({ user, interviewId }) {
      assert.equal(user.id, 10);
      assert.equal(interviewId, 100);
      return fakeState;
    },
    async markQuestionPlayed({ user, interviewId, turnId }) {
      assert.equal(user.id, 10);
      assert.equal(interviewId, 100);
      assert.equal(turnId, 501);
      return playedState;
    },
    async submitAnswer({ user, interviewId, turnId, signals, audio, contentType }) {
      assert.equal(user.id, 10);
      assert.equal(interviewId, 100);
      assert.equal(turnId, 501);
      submittedSignals = signals;
      assert.ok(audio);
      assert.equal(contentType, 'audio/webm');
      return answeredState;
    },
  };

  const server = http.createServer();
  attachInterviewSocket(server, {
    interviewService: fakeInterviewService,
    tokenService,
  });

  await new Promise((resolve) => {
    server.listen(0, resolve);
  });
  const port = server.address().port;

  const client = Client(`http://localhost:${port}/interview`, {
    transports: ['websocket'],
    autoConnect: false,
    extraHeaders: {
      cookie: mintCookie('STUDENT', 10),
    },
  });

  await new Promise((resolve, reject) => {
    client.on('connect', resolve);
    client.on('connect_error', reject);
    client.connect();
  });

  // 1. Join interview
  const joinRes = await new Promise((resolve) => {
    client.emit('interview:join', { interviewId: 100 }, resolve);
  });
  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.state.interviewId, 100);

  // 2. Ready -> receives question:new
  const newQuestion = await new Promise((resolve) => {
    client.on('question:new', resolve);
    client.emit('interview:ready', { interviewId: 100 });
  });
  assert.equal(newQuestion.turnId, 501);
  assert.equal(newQuestion.questionText, 'What is Encapsulation?');
  assert.equal(newQuestion.questionAudioUrl, '/api/tts/encap.mp3');
  assert.equal(newQuestion.thinkTimeSec, 15);
  assert.equal(newQuestion.answerTimeSec, 120);

  // 3. Question played
  const playedRes = await new Promise((resolve) => {
    client.emit('question:played', { interviewId: 100, turnId: 501 }, resolve);
  });
  assert.equal(playedRes.ok, true);
  assert.equal(playedRes.view.currentTurn.status, 'ANSWERING');

  // 4. Start answering & send audio chunk
  client.emit('answer:start', { interviewId: 100, turnId: 501 });
  client.emit('audio:chunk', {
    interviewId: 100,
    turnId: 501,
    chunk: Buffer.from('fake-audio-pcm-data'),
  });

  // 5. Submit answer
  const endRes = await new Promise((resolve) => {
    client.emit('answer:end', {
      interviewId: 100,
      turnId: 501,
      contentType: 'audio/webm',
    }, resolve);
  });

  assert.equal(endRes.ok, true);
  assert.equal(endRes.view.currentFollowUpCount, 1);
  assert.equal(endRes.view.currentTurn.turnId, 502);
  assert.ok(submittedSignals);
  assert.equal(typeof submittedSignals.speechDurationMs, 'number');

  client.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

function connect(client) {
  return new Promise((resolve, reject) => {
    client.on('connect', resolve);
    client.on('connect_error', reject);
    client.connect();
  });
}

test('answer:end emits turn:transcribed to the answering student only', async () => {
  const fakeState = {
    interviewId: 200,
    status: 'IN_PROGRESS',
    currentTurn: { turnId: 601, turnType: 'MAIN', questionText: 'What is a promise?' },
  };
  const answeredState = {
    ...fakeState,
    currentTurn: { turnId: 602, turnType: 'FOLLOW_UP', questionText: 'Give an example.' },
  };
  const transcribedPayload = { interviewId: 200, turnId: 601, sequenceNo: 1, transcript: 'Synthetic answer' };

  let onTranscribedCalls = 0;

  const fakeInterviewService = {
    async getCurrentState() { return fakeState; },
    async submitAnswer({ onTranscribed }) {
      assert.equal(typeof onTranscribed, 'function');
      onTranscribedCalls += 1;
      onTranscribed(transcribedPayload);
      return answeredState;
    },
  };

  const server = http.createServer();
  attachInterviewSocket(server, { interviewService: fakeInterviewService, tokenService });

  await new Promise((resolve) => { server.listen(0, resolve); });
  const port = server.address().port;

  const owner = Client(`http://localhost:${port}/interview`, {
    transports: ['websocket'],
    autoConnect: false,
    extraHeaders: { cookie: mintCookie('STUDENT', 10) },
  });
  const other = Client(`http://localhost:${port}/interview`, {
    transports: ['websocket'],
    autoConnect: false,
    extraHeaders: { cookie: mintCookie('STUDENT', 20) },
  });

  await Promise.all([connect(owner), connect(other)]);

  const ownerEvents = [];
  const otherEvents = [];
  owner.on('turn:transcribed', (payload) => ownerEvents.push(payload));
  other.on('turn:transcribed', (payload) => otherEvents.push(payload));

  await new Promise((resolve) => {
    owner.emit('answer:end', { interviewId: 200, turnId: 601, contentType: 'audio/webm' }, resolve);
  });

  // Give the other student's socket a moment in case of a (buggy) broadcast.
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(ownerEvents, [transcribedPayload]);
  assert.deepEqual(otherEvents, []);
  assert.equal(onTranscribedCalls, 1, 'the engine callback is passed exactly once');

  owner.disconnect();
  other.disconnect();
  await new Promise((resolve) => server.close(resolve));
});
