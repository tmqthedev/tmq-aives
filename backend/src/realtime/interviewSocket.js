const path = require('path');
const { Server } = require('socket.io');
const { calculateSpeechSignals } = require('../services/speechSignals');
const { ACCESS_COOKIE } = require('../auth/cookieNames');

function parseCookies(cookieHeader = '') {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawVal] = part.trim().split('=');
    if (rawKey) {
      cookies[rawKey] = decodeURIComponent(rawVal.join('='));
    }
  }
  return cookies;
}

function buildStudentQuestionPayload(view) {
  if (!view || !view.currentTurn) return null;
  const turn = view.currentTurn;
  const audioKey = turn.audioKey || turn.questionAudioKey;
  const questionAudioUrl = audioKey ? `/api/tts/${path.basename(audioKey)}` : null;

  return {
    turnId: turn.turnId,
    language: view.language,
    questionText: turn.questionText,
    questionAudioUrl,
    thinkTimeSec: view.thinkTimeSec ?? 0,
    answerTimeSec: view.answerTimeLimitSec ?? view.answerTimeSec ?? 120,
    questionNo: (view.questionNumber ?? (view.currentQuestionIndex != null ? view.currentQuestionIndex + 1 : 1)),
    followUpNo: view.followUpNumber ?? view.currentFollowUpCount ?? 0,
    totalQuestions: view.totalQuestions ?? 0,
    maxFollowUps: view.maxFollowUps ?? view.maxFollowUpsPerQuestion ?? 0,
    turnType: turn.turnType,
    retryCount: turn.retryCount ?? 0,
  };
}

function attachInterviewSocket(httpServer, {
  interviewService,
  tokenService,
  corsOrigin = true,
  qaTurnRepository = null,
} = {}) {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
    path: '/socket.io',
  });

  const nsp = io.of('/interview');

  // Authenticate socket handshake using access_token httpOnly cookie
  nsp.use((socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie || '';
      const cookies = parseCookies(cookieHeader);
      const token = cookies[ACCESS_COOKIE] || cookies.access_token;
      if (!token) {
        return next(new Error('AUTHENTICATION_REQUIRED'));
      }

      const payload = tokenService.verify(token, { type: 'access' });
      if (!payload || payload.role !== 'STUDENT') {
        return next(new Error('FORBIDDEN_STUDENT_ONLY'));
      }

      socket.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        code: payload.code,
      };
      return next();
    } catch (err) {
      return next(new Error('INVALID_TOKEN'));
    }
  });

  nsp.on('connection', (socket) => {
    socket.data = {
      interviewId: null,
      currentTurnId: null,
      answerStartedAt: null,
      questionPlayedAt: null,
      audioChunks: [],
    };

    // Client joins an interview room
    socket.on('interview:join', async (data = {}, callback) => {
      try {
        const interviewId = Number(data.interviewId);
        if (!interviewId) throw new Error('interviewId is required');

        const state = await interviewService.getCurrentState({
          user: socket.user,
          interviewId,
        });

        const room = `interview:${interviewId}`;
        socket.join(room);
        socket.data.interviewId = interviewId;
        if (state.currentTurn) {
          socket.data.currentTurnId = state.currentTurn.turnId;
        }

        socket.emit('interview:state', state);
        if (typeof callback === 'function') callback({ ok: true, state });
      } catch (err) {
        if (typeof callback === 'function') {
          callback({ ok: false, error: err.message, code: err.code || 'ERROR' });
        } else {
          socket.emit('error', { message: err.message, code: err.code || 'ERROR' });
        }
      }
    });

    // Client confirms mic ready -> trigger initial or current question
    socket.on('interview:ready', async (data = {}, callback) => {
      try {
        const interviewId = Number(data.interviewId || socket.data.interviewId);
        if (!interviewId) throw new Error('interviewId is required');

        const state = await interviewService.getCurrentState({
          user: socket.user,
          interviewId,
        });

        if (state.currentTurn) {
          socket.data.currentTurnId = state.currentTurn.turnId;
          const qPayload = buildStudentQuestionPayload(state);
          socket.emit('question:new', qPayload);
        } else if (state.status === 'COMPLETED' || state.endedAt) {
          socket.emit('interview:completed', { endReason: state.endReason });
        }

        if (typeof callback === 'function') callback({ ok: true, state });
      } catch (err) {
        if (typeof callback === 'function') callback({ ok: false, error: err.message });
      }
    });

    // Client finished playing the question audio -> marks turn as ANSWERING
    socket.on('question:played', async (data = {}, callback) => {
      try {
        const interviewId = Number(data.interviewId || socket.data.interviewId);
        const turnId = Number(data.turnId || socket.data.currentTurnId);
        if (!interviewId || !turnId) throw new Error('interviewId and turnId are required');

        socket.data.questionPlayedAt = new Date();
        const view = await interviewService.markQuestionPlayed({
          user: socket.user,
          interviewId,
          turnId,
        });

        socket.emit('interview:state', view);
        if (typeof callback === 'function') callback({ ok: true, view });
      } catch (err) {
        if (typeof callback === 'function') callback({ ok: false, error: err.message });
      }
    });

    // Client starts recording answer
    socket.on('answer:start', (data = {}, callback) => {
      socket.data.answerStartedAt = new Date();
      socket.data.audioChunks = [];
      if (typeof callback === 'function') callback({ ok: true });
    });

    // Client streams audio chunk (Buffer or base64)
    socket.on('audio:chunk', (data = {}) => {
      const chunk = data.chunk;
      if (!chunk) return;
      if (Buffer.isBuffer(chunk)) {
        socket.data.audioChunks.push(chunk);
      } else if (typeof chunk === 'string') {
        socket.data.audioChunks.push(Buffer.from(chunk, 'base64'));
      }
    });

    // Client finishes answering -> submits audio / transcript
    socket.on('answer:end', async (data = {}, callback) => {
      try {
        const interviewId = Number(data.interviewId || socket.data.interviewId);
        const turnId = Number(data.turnId || socket.data.currentTurnId);
        if (!interviewId || !turnId) throw new Error('interviewId and turnId are required');

        socket.emit('turn:processing', { turnId });

        const answerEndedAt = new Date();
        const chunks = socket.data.audioChunks;
        const audioBuffer = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        socket.data.audioChunks = [];

        // Compute speech signals
        let playedAt = socket.data.questionPlayedAt;
        if (!playedAt && qaTurnRepository) {
          const row = await qaTurnRepository.findById(turnId);
          if (row && row.played_at) playedAt = row.played_at;
        }

        const signals = calculateSpeechSignals({
          playedAt,
          answerStartedAt: socket.data.answerStartedAt,
          answerEndedAt,
          text: data.transcript ? (data.transcript.text || data.transcript) : undefined,
        });

        const view = await interviewService.submitAnswer({
          user: socket.user,
          interviewId,
          turnId,
          audio: audioBuffer,
          contentType: data.contentType || 'audio/webm',
          transcript: data.transcript,
          timedOut: data.timedOut === true,
          signals,
        });

        // Emit the recognized answer text as soon as it is stored, before the
        // next question, and only on the success path (never while recording
        // and never for an empty-audio retry). Goes to this student's socket only.
        const answered = !(view.currentTurn && view.currentTurn.status === 'ANSWERING');
        if (answered) {
          try {
            const transcribedTurn = await interviewService.getTranscribedTurn({
              user: socket.user,
              interviewId,
              turnId,
            });
            if (transcribedTurn) socket.emit('turn:transcribed', transcribedTurn);
          } catch (err) {
            // Non-fatal: the state already advanced; the client can fetch the
            // transcript via GET /api/interviews/:id/transcript.
          }
        }

        socket.emit('interview:state', view);

        if (view.status === 'COMPLETED' || view.endedAt) {
          socket.emit('interview:completed', { endReason: view.endReason });
        } else if (view.currentTurn && view.currentTurn.status === 'ANSWERING') {
          // A1/A3: Retry granted; student gets 1 chance to repeat answer
          socket.data.currentTurnId = view.currentTurn.turnId;
          socket.emit('turn:retry', {
            turnId: view.currentTurn.turnId,
            message: view.retryPrompt || 'Audio rỗng hoặc lỗi nhận diện. Bạn được nói lại 1 lần.',
            remainingAnswerMs: view.currentTurn.remainingAnswerMs,
          });
        } else if (view.currentTurn) {
          socket.data.currentTurnId = view.currentTurn.turnId;
          socket.data.questionPlayedAt = null;
          socket.data.answerStartedAt = null;
          const qPayload = buildStudentQuestionPayload(view);
          socket.emit('question:new', qPayload);
        }

        if (typeof callback === 'function') callback({ ok: true, view });
      } catch (err) {
        if (err.code === 'STT_FAILED') {
          try {
            const state = await interviewService.getCurrentState({ user: socket.user, interviewId: socket.data.interviewId });
            socket.emit('interview:state', state);
            if (state.endedAt || state.status === 'COMPLETED') {
              socket.emit('interview:completed', { endReason: state.endReason });
            } else {
              socket.emit('turn:retry', { turnId: state.currentTurn?.turnId,
                code: 'STT_FAILED', message: err.message,
                remainingAnswerMs: state.remainingSessionMs, serviceFailure: true });
            }
          } catch (stateError) {
            socket.emit('turn:error', { message: stateError.message,
              code: stateError.code || 'STATE_UNAVAILABLE' });
          }
        } else {
          socket.emit('turn:error', { message: err.message, code: err.code });
        }
        if (typeof callback === 'function') callback({ ok: false, error: err.message, code: err.code });
      }
    });

    socket.on('disconnect', () => {
      socket.data.audioChunks = [];
    });
  });

  return io;
}

module.exports = {
  attachInterviewSocket,
  parseCookies,
  buildStudentQuestionPayload,
};
