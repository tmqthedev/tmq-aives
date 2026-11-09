const express = require('express');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const { createLogger } = require('./config/logger');
const env = require('./config/env');
const { createDatabase } = require('./db/createDatabase');
const { createAwsClients } = require('./services/awsClients');
const { QuestionRepository } = require('./repositories/questionRepository');
const { QuestionService } = require('./services/questionService');
const { QuestionController } = require('./controllers/questionController');
const { createQuestionRouter } = require('./routes/questionRoutes');
const { RubricRepository } = require('./repositories/rubricRepository');
const { RubricService } = require('./services/rubricService');
const { RubricController } = require('./controllers/rubricController');
const { createRubricRouter } = require('./routes/rubricRoutes');
const { createEmbeddingAdapter } = require('./embedding/embeddingAdapter');
const { SubjectScope } = require('./services/subjectScope');
const { TopicRepository } = require('./repositories/topicRepository');
const { TopicService } = require('./services/topicService');
const { TopicController } = require('./controllers/topicController');
const { createTopicRouter } = require('./routes/topicRoutes');
const { AppUserRepository } = require('./repositories/appUserRepository');
const { AuthSessionRepository } = require('./repositories/authSessionRepository');
const { PasswordTokenRepository } = require('./repositories/passwordTokenRepository');
const { SubjectRepository } = require('./repositories/subjectRepository');
const { BackgroundJobRepository } = require('./repositories/backgroundJobRepository');
const { TokenService } = require('./auth/tokenService');
const passwordHasher = require('./auth/passwordHasher');
const { AuthService } = require('./services/authService');
const { AuthController } = require('./controllers/authController');
const { createAuthRouter } = require('./routes/authRoutes');
const { createAuthMiddleware } = require('./middleware/auth');
const { verifyOrigin } = require('./middleware/csrf');
const { AdminService } = require('./services/adminService');
const { AdminController } = require('./controllers/adminController');
const { createAdminRouter } = require('./routes/adminRoutes');
const { CourseMaterialRepository } = require('./repositories/courseMaterialRepository');
const { MaterialChunkRepository } = require('./repositories/materialChunkRepository');
const { MaterialService } = require('./services/materialService');
const { MaterialController } = require('./controllers/materialController');
const { createMaterialRouter } = require('./routes/materialRoutes');
const { parse } = require('./ingest/parseDocument');
const { createLlmAdapter } = require('./llm/llmAdapter');
const { QuestionGenerationJobRepository } = require('./repositories/questionGenerationJobRepository');
const { QuestionSourceRefRepository } = require('./repositories/questionSourceRefRepository');
const { QuestionGenerationService } = require('./services/questionGenerationService');
const { QuestionGenerationController } = require('./controllers/questionGenerationController');
const { createQuestionGenerationRouter } = require('./routes/questionGenerationRoutes');
const { ExamSessionRepository } = require('./repositories/examSessionRepository');
const { ExamSessionService } = require('./services/examSessionService');
const { ExamLaunchService } = require('./services/examLaunchService');
const { ExamSessionController } = require('./controllers/examSessionController');
const { createExamSessionRouter } = require('./routes/examSessionRoutes');
const { createTtsAdapter } = require('./tts/ttsAdapter');
const { createSttAdapter } = require('./stt/sttAdapter');
const { VivaInterviewRepository } = require('./repositories/vivaInterviewRepository');
const { AssignedQuestionRepository } = require('./repositories/assignedQuestionRepository');
const { QaTurnRepository } = require('./repositories/qaTurnRepository');
const { TranscriptRepository } = require('./repositories/transcriptRepository');
const { ProcessingFailureRepository } = require('./repositories/processingFailureRepository');
const { VivaResultRepository } = require('./repositories/vivaResultRepository');
const { SessionContextStore } = require('./interview/sessionContextStore');
const { InterviewService } = require('./services/interviewService');
const { StudentExamService } = require('./services/studentExamService');
const { StudentExamController } = require('./controllers/studentExamController');
const { createMeRouter } = require('./routes/meRoutes');
const { InterviewController } = require('./controllers/interviewController');
const { createInterviewRouter } = require('./routes/interviewRoutes');
const { attachInterviewSocket } = require('./realtime/interviewSocket');
const { attachBusinessSocket } = require('./realtime/businessSocket');
const { RealtimeBus } = require('./realtime/realtimeBus');
const { GradingService } = require('./services/gradingService');
const { GradingController } = require('./controllers/gradingController');
const { createGradingRouter } = require('./routes/gradingRoutes');
const { AuditLogRepository } = require('./repositories/auditLogRepository');

function createApp(overrides = {}) {
  const app = express();
  const logger = overrides.logger || createLogger();
  const runtimeEnv = overrides.env || env;
  const clients = overrides.clients || createAwsClients(runtimeEnv);
  const database = overrides.database || createDatabase(runtimeEnv);
  const realtimeBus = overrides.realtimeBus || new RealtimeBus();
  const embeddingAdapter = overrides.embeddingAdapter || createEmbeddingAdapter(runtimeEnv);
  const rubricRepository = overrides.rubricRepository || new RubricRepository(database);
  const topicRepository = overrides.topicRepository || new TopicRepository(database);
  const questionRepository = overrides.questionRepository || new QuestionRepository(database);
  const questionSourceRefRepository = overrides.questionSourceRefRepository
    || new QuestionSourceRefRepository(database);
  // Constructed up front so the question/rubric/exam-session services can
  // enforce lecturer->subject scope through the shared SubjectScope helper (the
  // auth wiring below reuses this same subjectRepository instance).
  const subjectRepository = overrides.subjectRepository || new SubjectRepository(database);
  const subjectScope = overrides.subjectScope || new SubjectScope({ subjectRepository });
  const questionService = overrides.questionService || new QuestionService({
    subjectScope,
    repository: questionRepository,
    embeddingAdapter,
    rubricRepository,
    topicRepository,
    db: database,
    questionSourceRefRepository,
    realtimeBus,
    logger,
  });
  const questionController = overrides.questionController || new QuestionController(questionService);
  const rubricService = overrides.rubricService
    || new RubricService({ repository: rubricRepository, subjectScope, realtimeBus });
  const rubricController = overrides.rubricController || new RubricController(rubricService);
  const topicService = overrides.topicService || new TopicService({ repository: topicRepository, subjectScope });
  const topicController = overrides.topicController || new TopicController(topicService);

  // --- Auth wiring (repositories -> service -> controller -> router) ---
  const appUserRepository = overrides.appUserRepository || new AppUserRepository(database);
  const authSessionRepository = overrides.authSessionRepository || new AuthSessionRepository(database);
  const passwordTokenRepository = overrides.passwordTokenRepository || new PasswordTokenRepository(database);
  const backgroundJobRepository = overrides.backgroundJobRepository || new BackgroundJobRepository(database);
  const tokenService = overrides.tokenService
    || new TokenService({
      // Fall back to a non-production placeholder so createApp works in mock/
      // test environments that leave JWT_SECRET unset. server.js hard-fails a
      // missing JWT_SECRET when DB_MOCK_MODE is false, so real deployments
      // never sign sessions with this placeholder.
      secret: runtimeEnv.jwtSecret || 'aives-dev-insecure-secret',
      accessTtlSec: runtimeEnv.jwtAccessTtlSec || 900,
      refreshTtlSec: runtimeEnv.jwtRefreshTtlSec || 604800,
    });
  const authService = overrides.authService
    || new AuthService({
      appUserRepository,
      authSessionRepository,
      passwordTokenRepository,
      backgroundJobRepository,
      passwordHasher: overrides.passwordHasher || passwordHasher,
      tokenService,
      env: runtimeEnv,
    });
  const authController = overrides.authController
    || new AuthController(authService, { env: runtimeEnv });
  const authMiddleware = overrides.authMiddleware
    || createAuthMiddleware({ tokenService, env: runtimeEnv, appUserRepository });

  // --- Admin wiring (service -> controller -> router) ---
  const adminService = overrides.adminService
    || new AdminService({
      appUserRepository,
      subjectRepository,
      passwordTokenRepository,
      backgroundJobRepository,
      authSessionRepository,
      env: runtimeEnv,
      realtimeBus,
    });

  // --- Materials / ingestion wiring (Step 4 FEAT-001) ---
  const courseMaterialRepository = overrides.courseMaterialRepository
    || new CourseMaterialRepository(database);
  const materialChunkRepository = overrides.materialChunkRepository
    || new MaterialChunkRepository(database);
  // Enqueue port: request-time services push jobs via backgroundJobRepository,
  // not a JobQueue handle (which only exists in server.js).
  // Options ({ runAfter, maxAttempts }) pass through for delayed jobs.
  const enqueueJob = overrides.enqueueJob
    || ((type, payload, options) => backgroundJobRepository.enqueue(type, payload, options));
  const materialService = overrides.materialService
    || new MaterialService({
      courseMaterialRepository,
      subjectRepository,
      topicRepository,
      awsClients: clients,
      enqueueJob,
      env: runtimeEnv,
      realtimeBus,
      logger,
    });
  const materialController = overrides.materialController
    || new MaterialController(materialService);

  // --- Question generation wiring (Step 4 FEAT-002) ---
  const llmAdapter = overrides.llmAdapter || createLlmAdapter(runtimeEnv);
  const questionGenerationJobRepository = overrides.questionGenerationJobRepository
    || new QuestionGenerationJobRepository(database);
  const questionGenerationService = overrides.questionGenerationService
    || new QuestionGenerationService({
      questionGenerationJobRepository,
      questionRepository,
      questionSourceRefRepository,
      courseMaterialRepository,
      topicRepository,
      subjectRepository,
      rubricRepository,
      embeddingAdapter,
      enqueueJob,
      realtimeBus,
      logger,
    });
  const questionGenerationController = overrides.questionGenerationController
    || new QuestionGenerationController(questionGenerationService, {
      jobRepository: questionGenerationJobRepository,
    });

  // --- Exam session wiring (Step 5 FEAT-002) ---
  const examSessionRepository = overrides.examSessionRepository
    || new ExamSessionRepository(database);
  const ttsAdapter = overrides.ttsAdapter || createTtsAdapter(runtimeEnv, { awsClients: clients });
  // STT seam shared by the exam launch warm-up and the interview engine.
  const sttAdapter = overrides.sttAdapter || createSttAdapter(runtimeEnv, { awsClients: clients });
  // Admin start side effects (Step 12): STT/TTS warm-up, audio pre-generation
  // and the keep-warm job chain.
  const examLaunchService = overrides.examLaunchService
    || new ExamLaunchService({
      sttAdapter,
      ttsAdapter,
      examSessionRepository,
      enqueueJob,
      ...(overrides.clock ? { clock: overrides.clock } : {}),
      logger,
    });
  const examSessionService = overrides.examSessionService
    || new ExamSessionService({
      examSessionRepository,
      subjectScope,
      subjectRepository,
      topicRepository,
      appUserRepository,
      rubricRepository,
      questionRepository,
      ttsAdapter,
      examLaunchService,
      db: database,
      realtimeBus,
      ...(overrides.clock ? { clock: overrides.clock } : {}),
      logger,
    });
  const examSessionController = overrides.examSessionController
    || new ExamSessionController(examSessionService);
  const auditLogRepository = overrides.auditLogRepository || new AuditLogRepository(database);
  const adminController = overrides.adminController
    || new AdminController(adminService, { examSessionService, auditLogRepository });

  // --- Interview engine wiring (Step 6; ENGINE ONLY, no routes/sockets) ---
  // Step 7 mounts the transport on app.interviewContext. The TTS/STT seams are
  // the same instances the exam launch uses.
  const vivaInterviewRepository = overrides.vivaInterviewRepository
    || new VivaInterviewRepository(database);
  const assignedQuestionRepository = overrides.assignedQuestionRepository
    || new AssignedQuestionRepository(database);
  const qaTurnRepository = overrides.qaTurnRepository || new QaTurnRepository(database);
  const transcriptRepository = overrides.transcriptRepository || new TranscriptRepository(database);
  const processingFailureRepository = overrides.processingFailureRepository
    || new ProcessingFailureRepository(database);
  const vivaResultRepository = overrides.vivaResultRepository || new VivaResultRepository(database);
  const sessionContextStore = overrides.sessionContextStore
    || new SessionContextStore({
      sessionStore: clients.sessionStore,
      ttlGraceSec: runtimeEnv.sessionContextTtlGraceSec,
      ...(overrides.clock ? { clock: overrides.clock } : {}),
      logger,
    });
  const interviewService = overrides.interviewService
    || new InterviewService({
      db: database,
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
      awsClients: clients,
      enqueueJob,
      env: runtimeEnv,
      realtimeBus,
      ...(overrides.clock ? { clock: overrides.clock } : {}),
      ...(overrides.random ? { random: overrides.random } : {}),
      logger,
    });

  const studentExamService = overrides.studentExamService
    || new StudentExamService({
      examSessionRepository,
      vivaInterviewRepository,
      vivaResultRepository,
      clock: overrides.clock || (() => new Date()),
    });
  const studentExamController = overrides.studentExamController
    || new StudentExamController(studentExamService);

  const interviewController = overrides.interviewController
    || new InterviewController(interviewService);

  const gradingService = overrides.gradingService
    || new GradingService({
      db: database,
      vivaResultRepository,
      llmAdapter,
      enqueueJob,
      realtimeBus,
      logger,
    });
  const gradingController = overrides.gradingController
    || new GradingController({
      gradingService,
      awsClients: clients,
      audioBucketName: runtimeEnv.audioBucket,
    });

  app.use(express.json());
  app.use(cookieParser());
  app.use(verifyOrigin([runtimeEnv.appBaseUrl]));
  app.use(pinoHttp({
    logger,
    customProps: (req, res) => {
      const props = {};
      if (res.locals && res.locals.errorCode) {
        props.errorCode = res.locals.errorCode;
      }
      return props;
    },
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      mockMode: runtimeEnv.awsMockMode,
      dbMockMode: runtimeEnv.dbMockMode,
    });
  });

  app.use('/api/auth', createAuthRouter(authController, { requireAuth: authMiddleware.requireAuth }));
  app.use('/api/admin', createAdminRouter(adminController, {
    requireAuth: authMiddleware.requireAuth,
    requireRole: authMiddleware.requireRole,
  }));
  app.use('/api/questions', createQuestionRouter(questionController, {
    requireAuth: authMiddleware.requireAuth,
    requireRole: authMiddleware.requireRole,
  }));
  app.use('/api/rubrics', createRubricRouter(rubricController, {
    requireAuth: authMiddleware.requireAuth,
    requireRole: authMiddleware.requireRole,
  }));
  app.use('/api/materials', createMaterialRouter(materialController, {
    requireAuth: authMiddleware.requireAuth,
    requireRole: authMiddleware.requireRole,
  }));
  app.use('/api/question-generation-jobs', createQuestionGenerationRouter(questionGenerationController, {
    requireAuth: authMiddleware.requireAuth,
    requireRole: authMiddleware.requireRole,
  }));
  app.use('/api/exam-sessions', createExamSessionRouter(examSessionController, {
    requireAuth: authMiddleware.requireAuth,
    requireRole: authMiddleware.requireRole,
  }));
  app.use('/api/me', createMeRouter(studentExamController, authMiddleware));
  app.use('/api/interviews', createInterviewRouter(interviewController, authMiddleware));
  app.use('/api', createGradingRouter(gradingController, authMiddleware));

  // Audio endpoint to serve question TTS audio
  app.get('/api/tts/:filename', authMiddleware.requireAuth, async (req, res, next) => {
    try {
      const { filename } = req.params;
      if (!filename || !/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes('..')) {
        const err = new Error('Invalid filename');
        err.statusCode = 400;
        err.code = 'INVALID_FILENAME';
        return next(err);
      }
      // Real adapters cache under tts-cache/ (Google .mp3, Kokoro .wav); the mock uses tts/.
      const contentType = filename.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
      try {
        let audioBuffer;
        try {
          audioBuffer = await clients.getObject({ bucket: runtimeEnv.audioBucket, key: `tts-cache/${filename}` });
        } catch {
          audioBuffer = await clients.getObject({ bucket: runtimeEnv.audioBucket, key: `tts/${filename}` });
        }
        res.setHeader('Content-Type', contentType);
        return res.send(audioBuffer);
      } catch {
        // The client can use browser speech. Never mask missing audio as a
        // successful response containing synthetic/silent bytes.
        return res.status(502).json({ code: 'TTS_AUDIO_UNAVAILABLE', message: 'Question audio is unavailable.' });
      }
    } catch (err) {
      next(err);
    }
  });

  // Topics: LECTURER or ADMIN; subject scope is enforced in TopicService.
  const topicGuard = [authMiddleware.requireAuth, authMiddleware.requireRole('LECTURER', 'ADMIN')];
  app.use('/api/topics', ...topicGuard, createTopicRouter(topicController));

  app.use((error, req, res, _next) => {
    const status = error.statusCode || 500;
    const body = {
      message: error.message || 'Internal Server Error',
    };
    // Surface the structured error code so the frontend can branch on it
    // (e.g. EMAIL_TAKEN / CODE_TAKEN / VALIDATION_ERROR). Without this the
    // client only ever sees the generic fallback message.
    if (error.code) {
      body.code = error.code;
      if (res.locals) res.locals.errorCode = error.code;
    }
    // Structured context for the client (e.g. NOT_ENOUGH_QUESTIONS byLevel).
    if (error.details) {
      body.details = error.details;
    }
    res.status(status).json(body);
  });

  // Attach realtime Socket.IO to an HTTP server instance.
  // Returns the io Server so /interview and /business share a single instance.
  app.attachRealtime = (server) => {
    const io = attachInterviewSocket(server, {
      interviewService,
      tokenService,
      qaTurnRepository,
    });
    attachBusinessSocket(server, {
      tokenService,
      realtimeBus,
      subjectScope,
      examSessionRepository,
      appUserRepository,
      subjectRepository,
      logger,
      io,
    });
    return io;
  };

  // Expose auth building blocks so later features can reuse the same
  // middleware/service wiring (e.g. requireAuth/requireRole).
  app.authMiddleware = authMiddleware;
  app.authContext = {
    authService,
    authController,
    authMiddleware,
    tokenService,
    appUserRepository,
    authSessionRepository,
    passwordTokenRepository,
    subjectRepository,
    backgroundJobRepository,
    adminService,
    adminController,
  };

  // Interview engine and transport building blocks for Step 7.
  app.interviewContext = {
    interviewService,
    sessionContextStore,
    sttAdapter,
    ttsAdapter,
    studentExamService,
    studentExamController,
    interviewController,
    attachInterviewSocket: app.attachRealtime,
  };

  // Dependencies the background job handlers need. server.js spreads these into
  // registerDefaultHandlers in its DB branch so the real INGEST_MATERIAL
  // handler is built only when a transactional DB is present.
  app.jobContext = {
    db: database,
    courseMaterialRepository,
    materialChunkRepository,
    embeddingAdapter,
    llmAdapter,
    awsClients: clients,
    parse,
    env: runtimeEnv,
    questionRepository,
    questionSourceRefRepository,
    questionGenerationJobRepository,
    interviewService,
    topicRepository,
    realtimeBus,
    gradingService,
    examSessionRepository,
    examLaunchService,
    ttsAdapter,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  };

  app.gradingContext = {
    gradingService,
    gradingController,
    vivaResultRepository,
  };

  app.realtimeContext = {
    realtimeBus,
    attachBusinessSocket,
  };

  return app;
}

module.exports = {
  createApp,
};
