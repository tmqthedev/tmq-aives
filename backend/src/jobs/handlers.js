// Background job handlers. INGEST_MATERIAL / GENERATE_QUESTIONS /
// GRADE_INTERVIEW remain no-op stubs (implemented in later work); SEND_EMAIL is
// a real handler that sends via the injected emailService and THROWS on failure
// so the queue retries with backoff. KEEP_WARM / PREPARE_EXAM_AUDIO (Step 12)
// support the admin exam start.

const {
  renderSetPasswordEmail,
  renderResetPasswordEmail,
} = require('../services/emailService');
const { examLanguageOf } = require('../domain/questionLanguage');

function makeStubHandler(type, logger) {
  return async function stubHandler(job) {
    logger.info(
      { jobId: job.background_job_id, type },
      'stub handler invoked (no-op)',
    );
  };
}

// Minimum extracted characters for a document to count as having a real text
// layer. Below this we treat it as a scanned/image-only file and mark FAILED
// without throwing (no amount of retrying will add a text layer).
const MIN_EXTRACTED_CHARS = 20;

/**
 * Build the INGEST_MATERIAL handler. Downloads the uploaded file from S3,
 * parses it into segments, chunks + embeds each chunk, then atomically replaces
 * the material's chunks, persists the page count (Finding 1), and flips status
 * to READY. Terminal/content problems (no text layer, parse failure) mark the
 * material FAILED and resolve WITHOUT throwing so the queue does not retry;
 * transient problems (missing object in S3, embedding error) rethrow so the
 * queue retries with backoff.
 */
function makeIngestMaterialHandler({
  db,
  courseMaterialRepository,
  materialChunkRepository,
  embeddingAdapter,
  awsClients,
  parse,
  env,
  logger = console,
}) {
  const { chunkSegments } = require('../ingest/chunkText');
  const bucket = (env && env.materialsBucket) || 'local-materials-bucket';

  return async function ingestMaterialHandler(job) {
    const materialId = job && job.payload ? job.payload.materialId : undefined;
    const material = await courseMaterialRepository.findById(materialId);
    if (!material) {
      throw new Error(`INGEST_MATERIAL: material ${materialId} not found`);
    }
    if (material.status === 'READY') {
      logger.info({ jobId: job.background_job_id, materialId }, 'material already READY; skipping');
      return;
    }

    const subjectId = material.subject_id;
    await courseMaterialRepository.updateStatus(materialId, 'PROCESSING', null);

    // Download then parse. A parse failure is a terminal content problem.
    const buffer = await awsClients.getObject({ bucket, key: material.file_key });

    let parsed;
    try {
      parsed = await parse(material.mime_type, buffer);
    } catch (err) {
      logger.warn({ jobId: job.background_job_id, materialId, err }, 'parse failed; marking FAILED');
      await courseMaterialRepository.updateStatus(materialId, 'FAILED', 'Could not parse the document.');
      return;
    }

    const { segments, pageCount } = parsed;
    const extractedChars = (segments || [])
      .reduce((sum, seg) => sum + String(seg && seg.text ? seg.text : '').length, 0);
    if (extractedChars < MIN_EXTRACTED_CHARS) {
      logger.warn({ jobId: job.background_job_id, materialId }, 'no text layer; marking FAILED');
      await courseMaterialRepository.updateStatus(
        materialId,
        'FAILED',
        'This document needs a text layer; no extractable text was found.',
      );
      return;
    }

    const chunks = chunkSegments(segments);
    // Embed each chunk sequentially; an embedding error is transient -> rethrow.
    for (const chunk of chunks) {
      chunk.embedding = await embeddingAdapter.embed(chunk.content);
    }

    await db.withTransaction(async (tx) => {
      await materialChunkRepository.deleteByMaterial(materialId, tx);
      await materialChunkRepository.insertMany(materialId, subjectId, chunks, tx);
      await courseMaterialRepository.setPageCount(materialId, pageCount, tx);
      await courseMaterialRepository.updateStatus(materialId, 'READY', null, tx);
    });

    logger.info(
      { jobId: job.background_job_id, materialId, chunks: chunks.length, pageCount },
      'material ingested',
    );
  };
}

/**
 * Build the GENERATE_QUESTIONS handler. Loads the generation job, embeds the
 * topic name, retrieves the nearest chunks across the job's materials (building
 * R: chunk_id -> {content,location,materialId}), calls the LLM to draft
 * questions, then delegates per-draft grounding/dedup validation + persistence
 * to QuestionGenerationService.persistDrafts. On success it writes the survivor
 * count absolutely (setGeneratedCount) and flips the domain job to COMPLETED
 * (recording the no-groundable error when zero survived); on ANY error it marks
 * the domain job FAILED then rethrows so the queue owns retry/backoff.
 */
function makeGenerateQuestionsHandler({
  db,
  questionGenerationJobRepository,
  courseMaterialRepository,
  materialChunkRepository,
  questionRepository,
  questionSourceRefRepository,
  topicRepository,
  embeddingAdapter,
  llmAdapter,
  realtimeBus = null,
  logger = console,
}) {
  // Invalidation after the status write; never fails the job.
  async function publishJobStatus(domainJob, status) {
    if (!realtimeBus) return;
    try {
      const topic = domainJob.topic_id != null && topicRepository
        ? await topicRepository.getById(Number(domainJob.topic_id)) : null;
      realtimeBus.publish('question', {
        action: 'status_changed',
        generationJobId: domainJob.question_generation_job_id,
        topicId: domainJob.topic_id,
        subjectId: topic ? topic.subject_id : null,
        status,
      });
    } catch (err) {
      logger.warn({ err }, 'generation realtime publish failed');
    }
  }
  // eslint-disable-next-line global-require
  const {
    QuestionGenerationService,
    NO_GROUNDABLE_ERROR,
    RETRIEVE_LIMIT,
  } = require('../services/questionGenerationService');

  const generationService = new QuestionGenerationService({
    questionGenerationJobRepository,
    questionRepository,
    questionSourceRefRepository,
    courseMaterialRepository,
    topicRepository,
    embeddingAdapter,
    db,
    logger,
  });

  return async function generateQuestionsHandler(job) {
    const jobId = job && job.payload ? job.payload.jobId : undefined;
    const domainJob = await questionGenerationJobRepository.findById(jobId);
    if (!domainJob) {
      throw new Error(`GENERATE_QUESTIONS: job ${jobId} not found`);
    }

    try {
      await questionGenerationJobRepository.updateStatus(
        domainJob.question_generation_job_id,
        'RUNNING',
        null,
      );
      await publishJobStatus(domainJob, 'RUNNING');

      // A retried or recovered run starts clean: drop whatever an earlier
      // attempt left unreviewed so questions are not duplicated.
      if (typeof questionRepository.deleteUnreviewedByGenerationJob === 'function') {
        await questionRepository.deleteUnreviewedByGenerationJob(
          domainJob.question_generation_job_id,
        );
      }

      const topic = await topicRepository.getById(domainJob.topic_id);
      if (!topic) {
        throw new Error(`GENERATE_QUESTIONS: topic ${domainJob.topic_id} not found`);
      }

      const materialIds = parseJsonMaybe(domainJob.material_ids) || [];
      const bloomDistribution = parseJsonMaybe(domainJob.bloom_distribution);

      const queryEmbedding = await embeddingAdapter.embed(topic.name);
      const chunkRows = await materialChunkRepository.findNearestForTopic({
        materialIds,
        queryEmbedding,
        limit: RETRIEVE_LIMIT,
      });

      // R: the authoritative retrieved-chunk map. Citations are validated and
      // persisted ONLY against keys of R (Finding 4 citation-in-scope).
      const R = {};
      const chunks = [];
      for (const row of chunkRows) {
        R[row.material_chunk_id] = {
          content: row.content,
          location: row.location,
          materialId: row.material_id,
        };
        chunks.push({
          chunk_id: row.material_chunk_id,
          content: row.content,
          location: row.location,
        });
      }

      const drafts = await llmAdapter.generateQuestions({
        language: domainJob.language,
        topic: { name: topic.name },
        bloomDistribution,
        requestedCount: domainJob.requested_count,
        chunks,
      });

      const { survivors } = await generationService.persistDrafts({
        job: domainJob,
        drafts,
        R,
      });

      // Absolute write so a retried run never double-counts.
      await questionGenerationJobRepository.setGeneratedCount(
        domainJob.question_generation_job_id,
        survivors.length,
      );
      await questionGenerationJobRepository.updateStatus(
        domainJob.question_generation_job_id,
        'COMPLETED',
        survivors.length === 0 ? NO_GROUNDABLE_ERROR : null,
      );
      await publishJobStatus(domainJob, 'COMPLETED');

      logger.info(
        {
          jobId: domainJob.question_generation_job_id,
          survivors: survivors.length,
          requested: domainJob.requested_count,
        },
        'question generation completed',
      );
    } catch (err) {
      logger.error(
        { jobId: domainJob.question_generation_job_id, err },
        'question generation failed',
      );
      // Only report FAILED once the queue has no retries left; while one is
      // pending keep the job RUNNING (with the last error) so the UI keeps
      // polling instead of showing a failure that may still recover.
      const maxAttempts = job && job.max_attempts != null ? job.max_attempts : (job && job.attempts != null ? 3 : 1);
      const attempts = (job && job.attempts != null) ? job.attempts : 1;
      const attemptsLeft = attempts < maxAttempts;
      await questionGenerationJobRepository.updateStatus(
        domainJob.question_generation_job_id,
        attemptsLeft ? 'RUNNING' : 'FAILED',
        err && err.message ? err.message : 'Question generation failed.',
      );
      await publishJobStatus(domainJob, attemptsLeft ? 'RUNNING' : 'FAILED');
      // Rethrow so the queue owns retry/backoff.
      throw err;
    }
  };
}

// Parse a JSONB column that pg may return as a string (real DB) or as an
// already-parsed value (in-memory mock / fakes).
function parseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Build the SEND_EMAIL handler. Reads job.payload and sends through
 * emailService. The payload may carry a ready-made {to,subject,html,text} or
 * the enqueue contract {to,subject,template,variables:{link,...}} produced by
 * authService; in the latter case the body is rendered from the template.
 * Rethrows on any send failure so the queue schedules a retry.
 */
function makeSendEmailHandler(emailService, logger) {
  return async function sendEmailHandler(job) {
    const payload = job.payload || {};
    const { to, template, variables } = payload;
    let { subject, html, text } = payload;

    if ((!html || !text) && template) {
      const link = variables && variables.link;
      const rendered = template === 'SET_PASSWORD'
        ? renderSetPasswordEmail(link)
        : renderResetPasswordEmail(link);
      subject = subject || rendered.subject;
      html = html || rendered.html;
      text = text || rendered.text;
    }

    if (!to) {
      throw new Error('SEND_EMAIL payload is missing a recipient (to).');
    }

    try {
      await emailService.sendMail({ to, subject, html, text });
      logger.info({ jobId: job.background_job_id, to }, 'email sent');
    } catch (err) {
      // Rethrow so JobQueue marks the job for retry with backoff.
      logger.error({ jobId: job.background_job_id, err }, 'email send failed');
      throw err;
    }
  };
}

/**
 * Build the GRADE_INTERVIEW handler. Reads job.payload.interviewId and calls
 * gradingService.gradeInterview. Rethrows transient errors so JobQueue can retry.
 * On the LAST attempt it marks the result FLAGGED/FAILED (never stuck in
 * AI_SCORING); on an earlier attempt it marks stage RETRYING.
 */
function makeGradeInterviewHandler(gradingService, logger = console, env = {}) {
  return async function gradeInterviewHandler(job) {
    const payload = job.payload || {};
    const { interviewId } = payload;
    if (!interviewId) {
      logger.warn({ jobId: job.background_job_id }, 'GRADE_INTERVIEW payload missing interviewId; discarding');
      return;
    }
    logger.info({ jobId: job.background_job_id, interviewId }, 'processing GRADE_INTERVIEW job');
    try {
      await gradingService.gradeInterview({ interviewId: Number(interviewId) });
      logger.info({ jobId: job.background_job_id, interviewId }, 'GRADE_INTERVIEW completed successfully');
    } catch (err) {
      logger.error({ jobId: job.background_job_id, interviewId, err }, 'GRADE_INTERVIEW failed');
      const maxAttempts = Number(job.max_attempts ?? (env && env.jobMaxAttempts) ?? 3);
      const attempts = Number(job.attempts) || 0;
      const last = attempts >= maxAttempts;
      try {
        if (last) {
          await gradingService.markGradingFailed({ interviewId: Number(interviewId) });
        } else if (typeof gradingService.markGradingRetrying === 'function') {
          await gradingService.markGradingRetrying({ interviewId: Number(interviewId) });
        }
      } catch (markErr) {
        logger.error({ jobId: job.background_job_id, interviewId, err: markErr }, 'GRADE_INTERVIEW progress-failure marking failed');
      }
      throw err;
    }
  };
}

/**
 * Build the KEEP_WARM handler (Step 12). While the exam is OPEN and before
 * closes_at it re-warms STT + TTS (examLaunchService.warm writes
 * warm_status.stt/tts) and re-enqueues itself `interval` later; otherwise it
 * marks warm_status.keepWarm stopped and ends the chain. Warm-up failures are
 * captured in warm_status (adapters never throw), so only a DB failure throws
 * and is retried.
 */
function makeKeepWarmHandler({
  examSessionRepository,
  examLaunchService,
  enqueueJob,
  clock = () => new Date(),
  logger = console,
}) {
  return async function keepWarmHandler(job) {
    const examSessionId = Number(job && job.payload ? job.payload.examSessionId : NaN);
    if (!Number.isInteger(examSessionId) || examSessionId <= 0) {
      logger.warn({ jobId: job.background_job_id }, 'KEEP_WARM payload missing examSessionId; discarding');
      return;
    }
    const session = await examSessionRepository.findById(examSessionId);
    if (!session) {
      logger.warn({ jobId: job.background_job_id, examSessionId }, 'KEEP_WARM exam session not found; stopping');
      return;
    }
    const now = clock();
    const closesMs = session.closes_at ? new Date(session.closes_at).getTime() : null;
    if (session.status !== 'OPEN' || (closesMs != null && now.getTime() >= closesMs)) {
      await examSessionRepository.mergeWarmStatus(examSessionId, {
        keepWarm: { state: 'stopped', nextAt: null, stoppedAt: now.toISOString() },
      });
      logger.info({ examSessionId, status: session.status }, 'KEEP_WARM stopped');
      return;
    }

    await examLaunchService.warm(session);
    const nextAt = examLaunchService.nextKeepWarmAt();
    await enqueueJob('KEEP_WARM', { examSessionId }, { runAfter: nextAt });
    // Past the re-enqueue a throw would retry this job and fork a second
    // chain, so the status write is best-effort.
    try {
      await examSessionRepository.mergeWarmStatus(examSessionId, {
        keepWarm: { state: 'active', nextAt: nextAt.toISOString() },
      });
    } catch (err) {
      logger.error({ err, examSessionId }, 'KEEP_WARM status write failed');
    }
  };
}

/**
 * Build the PREPARE_EXAM_AUDIO handler (Step 12). Synthesizes TTS for every
 * APPROVED question of the exam topic in the exam language (the adapter skips
 * cached audio, so a retry only pays for what is missing) and tracks progress
 * in warm_status.audio {done,total,state}. A TTS error THROWS so the queue
 * retries; the last attempt marks the audio state 'failed' first.
 */
/**
 * Build the EXPIRE_INTERVIEWS handler (Step 13). Sweeps active interviews whose
 * deadline has passed (plus grace period) and ends them via interviewService.expireOverdueInterviews.
 * Re-enqueues itself `interval` later. Past the sweep a throw would retry this job
 * and fork a second chain, so re-enqueue is placed at the very end.
 */
function makeExpireInterviewsHandler({
  interviewService,
  enqueueJob,
  env = {},
  clock = () => new Date(),
  logger = console,
}) {
  const intervalSec = Number(env.interviewSweepIntervalSec) || 60;
  const graceSec = Number(env.interviewSweepGraceSec) || 30;

  return async function expireInterviewsHandler(job) {
    let result = { ended: 0 };
    try {
      result = await interviewService.expireOverdueInterviews({ graceSec });
      logger.info({ jobId: job && job.background_job_id, ...result }, 'EXPIRE_INTERVIEWS sweep completed');
    } catch (err) {
      logger.error({ err, jobId: job && job.background_job_id }, 'EXPIRE_INTERVIEWS sweep error');
      throw err;
    }

    const nextAt = new Date(clock().getTime() + intervalSec * 1000);
    await enqueueJob('EXPIRE_INTERVIEWS', {}, { runAfter: nextAt });
  };
}

function makePrepareExamAudioHandler({
  examSessionRepository,
  ttsAdapter,
  env = {},
  logger = console,
}) {
  return async function prepareExamAudioHandler(job) {
    const examSessionId = Number(job && job.payload ? job.payload.examSessionId : NaN);
    if (!Number.isInteger(examSessionId) || examSessionId <= 0) {
      logger.warn({ jobId: job.background_job_id }, 'PREPARE_EXAM_AUDIO payload missing examSessionId; discarding');
      return;
    }
    const session = await examSessionRepository.findById(examSessionId);
    if (!session) {
      logger.warn({ jobId: job.background_job_id, examSessionId }, 'PREPARE_EXAM_AUDIO exam session not found');
      return;
    }
    if (session.status === 'CLOSED') {
      await examSessionRepository.mergeWarmStatus(examSessionId, {
        audio: { ...((session.warm_status && session.warm_status.audio) || {}), state: 'skipped' },
      });
      return;
    }

    const bank = (await examSessionRepository.listApprovedQuestionsInTopic(session.topic_id))
      .filter((q) => examLanguageOf(q) === session.language);
    const total = bank.length;
    let done = 0;
    await examSessionRepository.mergeWarmStatus(examSessionId, {
      audio: { done, total, state: total > 0 ? 'running' : 'done' },
    });
    for (const question of bank) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await ttsAdapter.synthesize({ text: question.content || '', language: session.language });
      } catch (err) {
        const maxAttempts = job.max_attempts ?? (env && env.jobMaxAttempts) ?? 3;
        const last = (Number(job.attempts) || 0) >= maxAttempts;
        // eslint-disable-next-line no-await-in-loop
        await examSessionRepository.mergeWarmStatus(examSessionId, {
          audio: {
            done,
            total,
            state: last ? 'failed' : 'retrying',
            error: err && err.message ? err.message : String(err),
          },
        });
        logger.error({ err, examSessionId, questionId: question.question_id }, 'PREPARE_EXAM_AUDIO synthesis failed');
        throw err;
      }
      done += 1;
      // eslint-disable-next-line no-await-in-loop
      await examSessionRepository.mergeWarmStatus(examSessionId, {
        audio: { done, total, state: done === total ? 'done' : 'running' },
      });
    }
    logger.info({ examSessionId, total }, 'PREPARE_EXAM_AUDIO completed');
  };
}

/**
 * Register handlers for every job type on the queue.
 * @param {import('./jobQueue').JobQueue} queue
 * @param {{logger?: object, emailService?: object}} [deps]
 */
function registerDefaultHandlers(queue, deps = {}) {
  const logger = deps.logger || queue.logger || console;

  // Build the real INGEST_MATERIAL handler only when a transactional DB and the
  // ingestion deps are present (the server.js DB branch spreads app.jobContext
  // in). Otherwise fall back to the no-op stub so the queue stays functional.
  const canBuildHandlers = !!(deps.db && typeof deps.db.withTransaction === 'function');
  if (canBuildHandlers && deps.courseMaterialRepository && deps.materialChunkRepository
      && deps.embeddingAdapter && deps.awsClients && deps.parse) {
    queue.registerHandler('INGEST_MATERIAL', makeIngestMaterialHandler({
      db: deps.db,
      courseMaterialRepository: deps.courseMaterialRepository,
      materialChunkRepository: deps.materialChunkRepository,
      embeddingAdapter: deps.embeddingAdapter,
      awsClients: deps.awsClients,
      parse: deps.parse,
      env: deps.env,
      logger,
    }));
  } else {
    queue.registerHandler('INGEST_MATERIAL', makeStubHandler('INGEST_MATERIAL', logger));
  }

  // Build the real GENERATE_QUESTIONS handler only when a transactional DB and
  // its deps are present (server.js spreads app.jobContext in). Otherwise fall
  // back to the no-op stub so the queue stays functional.
  if (canBuildHandlers && deps.questionGenerationJobRepository && deps.courseMaterialRepository
      && deps.materialChunkRepository && deps.questionRepository && deps.questionSourceRefRepository
      && deps.topicRepository && deps.embeddingAdapter && deps.llmAdapter) {
    queue.registerHandler('GENERATE_QUESTIONS', makeGenerateQuestionsHandler({
      db: deps.db,
      questionGenerationJobRepository: deps.questionGenerationJobRepository,
      courseMaterialRepository: deps.courseMaterialRepository,
      materialChunkRepository: deps.materialChunkRepository,
      questionRepository: deps.questionRepository,
      questionSourceRefRepository: deps.questionSourceRefRepository,
      topicRepository: deps.topicRepository,
      embeddingAdapter: deps.embeddingAdapter,
      llmAdapter: deps.llmAdapter,
      realtimeBus: deps.realtimeBus,
      logger,
    }));
  } else {
    queue.registerHandler('GENERATE_QUESTIONS', makeStubHandler('GENERATE_QUESTIONS', logger));
  }
  if (deps.gradingService) {
    queue.registerHandler('GRADE_INTERVIEW', makeGradeInterviewHandler(deps.gradingService, logger, deps.env));
  } else {
    queue.registerHandler('GRADE_INTERVIEW', makeStubHandler('GRADE_INTERVIEW', logger));
  }

  if (deps.emailService) {
    queue.registerHandler('SEND_EMAIL', makeSendEmailHandler(deps.emailService, logger));
  } else {
    queue.registerHandler('SEND_EMAIL', makeStubHandler('SEND_EMAIL', logger));
  }

  // Exam launch (Step 12): keep-warm chain and audio pre-generation. The
  // re-enqueue goes through the queue so the delayed job keeps its defaults.
  const enqueueJob = deps.enqueueJob
    || ((type, payload, opts) => queue.enqueue(type, payload, opts));
  if (deps.examSessionRepository && deps.examLaunchService) {
    queue.registerHandler('KEEP_WARM', makeKeepWarmHandler({
      examSessionRepository: deps.examSessionRepository,
      examLaunchService: deps.examLaunchService,
      enqueueJob,
      clock: deps.clock,
      logger,
    }));
  } else {
    queue.registerHandler('KEEP_WARM', makeStubHandler('KEEP_WARM', logger));
  }
  if (deps.examSessionRepository && deps.ttsAdapter) {
    queue.registerHandler('PREPARE_EXAM_AUDIO', makePrepareExamAudioHandler({
      examSessionRepository: deps.examSessionRepository,
      ttsAdapter: deps.ttsAdapter,
      env: deps.env,
      logger,
    }));
  } else {
    queue.registerHandler('PREPARE_EXAM_AUDIO', makeStubHandler('PREPARE_EXAM_AUDIO', logger));
  }
  if (deps.interviewService) {
    queue.registerHandler('EXPIRE_INTERVIEWS', makeExpireInterviewsHandler({
      interviewService: deps.interviewService,
      enqueueJob,
      env: deps.env,
      clock: deps.clock,
      logger,
    }));
  } else {
    queue.registerHandler('EXPIRE_INTERVIEWS', makeStubHandler('EXPIRE_INTERVIEWS', logger));
  }
  return queue;
}

module.exports = {
  registerDefaultHandlers,
  makeStubHandler,
  makeSendEmailHandler,
  makeIngestMaterialHandler,
  makeGenerateQuestionsHandler,
  makeGradeInterviewHandler,
  makeKeepWarmHandler,
  makePrepareExamAudioHandler,
  makeExpireInterviewsHandler,
  MIN_EXTRACTED_CHARS,
};
