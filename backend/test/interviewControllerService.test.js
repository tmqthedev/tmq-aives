const test = require('node:test');
const assert = require('node:assert/strict');

const { InterviewController } = require('../src/controllers/interviewController');

test('submitAnswer parses multipart JSON signals and transcript before calling the service', async () => {
  let serviceArgs;
  let responseBody;
  let nextError;
  const controller = new InterviewController({
    async submitAnswer(args) {
      serviceArgs = args;
      return { status: 'COMPLETED' };
    },
    async getTranscribedTurn({ user, interviewId, turnId }) {
      return { interviewId, turnId, sequenceNo: 1, transcript: 'Synthetic answer' };
    },
  });

  await controller.submitAnswer({
    body: {
      transcript: JSON.stringify({ text: 'Synthetic answer', confidence: 0.9 }),
      signals: JSON.stringify({
        response_latency_ms: 1250,
        speech_duration_ms: 6100,
        words_per_minute: 187,
        pause_count: 3,
      }),
      timedOut: 'false',
    },
    file: { buffer: Buffer.from('synthetic audio'), mimetype: 'audio/wav' },
    params: { id: '13', turnId: '23' },
    user: { id: 33, role: 'STUDENT' },
  }, {
    json(value) { responseBody = value; },
  }, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.deepEqual(serviceArgs.transcript, { text: 'Synthetic answer', confidence: 0.9 });
  assert.deepEqual(serviceArgs.signals, {
    response_latency_ms: 1250,
    speech_duration_ms: 6100,
    words_per_minute: 187,
    pause_count: 3,
  });
  assert.equal(serviceArgs.audio.toString(), 'synthetic audio');
  assert.equal(serviceArgs.contentType, 'audio/wav');
  assert.equal(serviceArgs.timedOut, false);
  assert.deepEqual(responseBody, {
    status: 'COMPLETED',
    transcribedTurn: { interviewId: '13', turnId: '23', sequenceNo: 1, transcript: 'Synthetic answer' },
  });
});

test('submitAnswer keeps JSON request objects intact', async () => {
  let serviceArgs;
  const signals = { responseLatencyMs: 500, speechDurationMs: 2000, wordsPerMinute: 120, pauseCount: 1 };
  const transcript = { text: 'JSON answer' };
  const controller = new InterviewController({
    async submitAnswer(args) {
      serviceArgs = args;
      return {};
    },
    async getTranscribedTurn() {
      return null;
    },
  });

  await controller.submitAnswer({
    body: { transcript, signals },
    params: { id: '1', turnId: '2' },
    user: { id: 3 },
  }, { json() {} }, (error) => { throw error; });

  assert.equal(serviceArgs.transcript, transcript);
  assert.equal(serviceArgs.signals, signals);
});

test('submitAnswer reports malformed multipart JSON fields as validation errors', async () => {
  let serviceCalled = false;
  let nextError;
  const controller = new InterviewController({
    async submitAnswer() { serviceCalled = true; },
  });

  await controller.submitAnswer({
    body: { signals: '{invalid-json' },
    params: { id: '1', turnId: '2' },
    user: { id: 3 },
  }, { json() {} }, (error) => { nextError = error; });

  assert.equal(serviceCalled, false);
  assert.equal(nextError?.statusCode, 400);
  assert.equal(nextError?.code, 'VALIDATION_ERROR');
});
