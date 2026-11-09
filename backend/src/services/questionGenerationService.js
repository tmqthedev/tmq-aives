// Question generation service. Owns BOTH the request path (createJob: validate
// the request, persist a PENDING job, enqueue GENERATE_QUESTIONS) and the
// handler's persist path (grounding + dedup validation of LLM drafts, then
// persisting survivors as PENDING_REVIEW/AI questions with their citations).
//
// The GENERATE_QUESTIONS handler (jobs/handlers.js) orchestrates retrieval and
// the LLM call, then delegates the per-draft validation + persistence to
// persistDrafts() here. This service re-implements the Step-3 dedup directly
// against questionRepository (exact-dup via findByNormalizedContent, near-dup
// via findSubjectEmbeddingsByTopic + cosineSimilarity) and NEVER routes through
// questionService.createQuestion. AI questions are hard-coded PENDING_REVIEW/AI.

const { cosineSimilarity } = require('../embedding/cosineSimilarity');
const {
  BLOOM_LEVELS,
  NEAR_DUPLICATE_THRESHOLD,
  normalizeContent,
} = require('./questionService');
const { normalizeQuestionLanguage } = require('../domain/questionLanguage');

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const MAX_REQUESTED_COUNT = 20;
const RETRIEVE_LIMIT = 12;
const NO_GROUNDABLE_ERROR = 'No groundable questions could be generated from these materials.';

// Whitespace-normalized, case-insensitive comparison used by the excerpt
// substring check so trivial spacing/case differences never reject a true
// citation.
function normalizeForSubstring(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

class QuestionGenerationService {
  constructor({
    questionGenerationJobRepository,
    questionRepository,
    questionSourceRefRepository,
    courseMaterialRepository,
    topicRepository,
    subjectRepository,
    rubricRepository,
    embeddingAdapter,
    enqueueJob,
    db,
    realtimeBus = null,
    logger = console,
  } = {}) {
    this.realtimeBus = realtimeBus;
    this.db = db;
    this.rubricRepository = rubricRepository;
    this.questionGenerationJobRepository = questionGenerationJobRepository;
    this.questionRepository = questionRepository;
    this.questionSourceRefRepository = questionSourceRefRepository;
    this.courseMaterialRepository = courseMaterialRepository;
    this.topicRepository = topicRepository;
    this.subjectRepository = subjectRepository;
    this.embeddingAdapter = embeddingAdapter;
    this.enqueueJob = enqueueJob;
    this.logger = logger;
  }

  // --- Request path --------------------------------------------------------

  async _assertSubjectInScope(user, subjectId) {
    if (user && user.role === 'ADMIN') return;
    if (subjectId == null) return;
    const lecturerId = user ? user.id : undefined;
    const subjectIds = await this.subjectRepository.listSubjectIdsForLecturer(lecturerId);
    if (!subjectIds.includes(Number(subjectId))) {
      throw httpError(403, 'FORBIDDEN', 'You do not have access to this subject.');
    }
  }

  _parsePositiveInt(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  _validateBloomDistribution(bloomDistribution, requestedCount) {
    if (bloomDistribution === undefined || bloomDistribution === null) {
      return null;
    }
    if (typeof bloomDistribution !== 'object' || Array.isArray(bloomDistribution)) {
      throw httpError(400, 'VALIDATION_ERROR', 'bloomDistribution must be an object keyed by Bloom level.');
    }
    let sum = 0;
    for (const [key, raw] of Object.entries(bloomDistribution)) {
      if (!BLOOM_LEVELS.includes(key)) {
        throw httpError(400, 'VALIDATION_ERROR', `bloomDistribution has an unknown Bloom level: ${key}.`);
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'bloomDistribution values must be non-negative integers.');
      }
      sum += n;
    }
    if (sum !== requestedCount) {
      throw httpError(400, 'BLOOM_SUM_MISMATCH', 'bloomDistribution values must sum to requestedCount.');
    }
    return bloomDistribution;
  }

  // Read a job back, subject-scoped through its topic. 404 when missing.
  async getJob({ user, jobId } = {}) {
    const id = this._parsePositiveInt(jobId);
    const job = id == null ? null : await this.questionGenerationJobRepository.findById(id);
    if (!job) {
      throw httpError(404, 'NOT_FOUND', 'Generation job not found.');
    }
    const topic = await this.topicRepository.getById(job.topic_id);
    await this._assertSubjectInScope(user, topic ? topic.subject_id : null);
    return job;
  }

  async createJob({
    user,
    topicId: rawTopicId,
    materialIds: rawMaterialIds,
    requestedCount: rawRequestedCount,
    bloomDistribution: rawBloomDistribution,
    language: rawLanguage,
    rubricId: rawRubricId,
  } = {}) {
    const topicId = this._parsePositiveInt(rawTopicId);
    if (topicId == null) {
      throw httpError(400, 'VALIDATION_ERROR', 'topicId must be a positive integer.');
    }
    const topic = await this.topicRepository.getById(topicId);
    if (!topic) {
      throw httpError(404, 'TOPIC_NOT_FOUND', 'Topic not found.');
    }
    const subjectId = topic.subject_id;
    await this._assertSubjectInScope(user, subjectId);

    if (!Array.isArray(rawMaterialIds) || rawMaterialIds.length === 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'materialIds must be a non-empty array.');
    }
    const materialIds = [];
    for (const raw of rawMaterialIds) {
      const id = this._parsePositiveInt(raw);
      if (id == null) {
        throw httpError(400, 'VALIDATION_ERROR', 'Each materialId must be a positive integer.');
      }
      materialIds.push(id);
    }

    // Every material must be a READY course_material in the topic's subject.
    const notReady = [];
    for (const id of materialIds) {
      // eslint-disable-next-line no-await-in-loop
      const material = await this.courseMaterialRepository.findById(id);
      const ready = material
        && material.status === 'READY'
        && Number(material.subject_id) === Number(subjectId);
      if (!ready) notReady.push(id);
    }
    if (notReady.length > 0) {
      const err = httpError(
        400,
        'MATERIALS_NOT_READY',
        'One or more materials are not READY in this subject.',
      );
      err.materialIds = notReady;
      throw err;
    }

    const requestedCount = this._parsePositiveInt(rawRequestedCount);
    if (requestedCount == null || requestedCount > MAX_REQUESTED_COUNT) {
      throw httpError(400, 'VALIDATION_ERROR', `requestedCount must be an integer between 1 and ${MAX_REQUESTED_COUNT}.`);
    }

    const bloomDistribution = this._validateBloomDistribution(rawBloomDistribution, requestedCount);

    const language = typeof rawLanguage === 'string' ? rawLanguage.trim() : '';
    if (language === '') {
      throw httpError(400, 'VALIDATION_ERROR', 'language is required.');
    }

    // Optional rubric for every draft; it must exist and match the subject.
    let rubricId = null;
    if (rawRubricId !== undefined && rawRubricId !== null && rawRubricId !== '') {
      rubricId = this._parsePositiveInt(rawRubricId);
      const rubric = rubricId != null && this.rubricRepository
        ? await this.rubricRepository.findById(rubricId)
        : null;
      if (!rubric) {
        throw httpError(400, 'VALIDATION_ERROR', 'rubricId does not refer to an existing rubric.');
      }
      if (rubric.subject_id != null && subjectId != null && Number(rubric.subject_id) !== Number(subjectId)) {
        throw httpError(400, 'RUBRIC_SUBJECT_MISMATCH', 'The rubric belongs to a different subject than the topic.');
      }
    }

    const job = await this.questionGenerationJobRepository.create({
      topicId,
      materialIds,
      requestedCount,
      bloomDistribution,
      language,
      status: 'PENDING',
      requestedBy: user ? user.id : null,
      rubricId,
    });

    await this.enqueueJob('GENERATE_QUESTIONS', { jobId: job.question_generation_job_id }, { maxAttempts: 3 });

    if (this.realtimeBus) {
      try {
        const topic = await this.topicRepository.getById(Number(topicId));
        this.realtimeBus.publish('question', {
          action: 'created',
          generationJobId: job.question_generation_job_id,
          topicId,
          subjectId: topic ? topic.subject_id : null,
          status: 'PENDING',
        });
      } catch (err) {
        this.logger?.warn?.({ err }, 'generation realtime publish failed');
      }
    }
    return job;
  }

  // --- Handler persist path ------------------------------------------------

  // Validate every draft against R (the retrieved-chunk map) and the existing
  // question corpus, persisting survivors as PENDING_REVIEW/AI questions with
  // their citations. Returns { survivors, warnings }. The handler owns status
  // transitions and setGeneratedCount; this method only persists questions.
  async persistDrafts({ job, drafts, R }) {
    const survivors = [];
    for (const draft of Array.isArray(drafts) ? drafts : []) {
      // eslint-disable-next-line no-await-in-loop
      const persisted = await this._validateAndPersistDraft({ job, draft, R });
      if (persisted) survivors.push(persisted);
    }
    return { survivors };
  }

  // Returns the persisted question row, or null when the draft was dropped.
  async _validateAndPersistDraft({ job, draft, R }) {
    if (!draft || typeof draft !== 'object') return null;

    // --- Shape validation ---
    const content = typeof draft.content === 'string' ? draft.content.trim() : '';
    if (content === '') return null;
    if (!BLOOM_LEVELS.includes(draft.bloom_level)) return null;
    const keyPoints = Array.isArray(draft.key_points)
      ? draft.key_points.map((k) => String(k).trim()).filter((k) => k !== '')
      : [];
    if (keyPoints.length < 3 || keyPoints.length > 5) return null;
    if (!Array.isArray(draft.citations) || draft.citations.length === 0) return null;

    // --- Citation grounding (Finding 4) + excerpt substring ---
    const validCitations = [];
    for (const citation of draft.citations) {
      if (!citation || citation.chunk_id == null) continue;
      const chunkId = Number(citation.chunk_id);
      const chunk = R[chunkId];
      if (!chunk) continue; // citation not in R -> drop this citation
      const excerpt = typeof citation.excerpt === 'string' ? citation.excerpt : '';
      const haystack = normalizeForSubstring(chunk.content);
      const needle = normalizeForSubstring(excerpt);
      if (needle === '' || !haystack.includes(needle)) continue; // excerpt mismatch -> drop citation
      validCitations.push({ chunkId, excerpt });
    }
    if (validCitations.length === 0) return null; // no groundable citation remains

    // --- Exact-dup: drop drafts that duplicate an existing question verbatim ---
    const normalized = normalizeContent(content);
    const exact = await this.questionRepository.findByNormalizedContent(normalized);
    if (exact) return null;

    // --- Near-dup: non-blocking warning recorded in rationale ---
    const embedding = this.embeddingAdapter
      ? await this.embeddingAdapter.embed(content)
      : null;
    const warnings = [];
    const nearDup = await this._detectNearDuplicate(job.topic_id, embedding);
    if (nearDup) {
      warnings.push(nearDup);
    }

    const rationale = {
      purpose: draft.purpose ?? null,
      synthesis: draft.synthesis ?? null,
      target: { keyPoints, bloom: draft.bloom_level },
    };
    if (warnings.length > 0) {
      rationale.warnings = { nearDuplicateOf: warnings };
    }

    // The question and all of its citations commit together or not at all.
    const persist = async (client) => {
      const created = await this.questionRepository.create({
        topicId: job.topic_id,
        rubricId: job.rubric_id ?? null,
        content,
        status: 'PENDING_REVIEW',
        bloomLevel: draft.bloom_level,
        language: normalizeQuestionLanguage(job.language, content),
        referenceAnswer: typeof draft.reference_answer === 'string' ? draft.reference_answer : null,
        keyPoints,
        source: 'AI',
        rationale,
        generationJobId: job.question_generation_job_id,
        embedding,
        createdBy: job.requested_by,
      }, client);

      for (const citation of validCitations) {
        // eslint-disable-next-line no-await-in-loop
        await this.questionSourceRefRepository.create({
          questionId: created.question_id,
          chunkId: citation.chunkId,
          excerpt: citation.excerpt,
        }, client);
      }
      return created;
    };

    if (this.db && typeof this.db.withTransaction === 'function') {
      return this.db.withTransaction((tx) => persist(tx));
    }
    return persist(undefined);
  }

  async _detectNearDuplicate(topicId, embedding) {
    if (!embedding || !this.questionRepository
      || typeof this.questionRepository.findSubjectEmbeddingsByTopic !== 'function') {
      return null;
    }
    const candidates = await this.questionRepository.findSubjectEmbeddingsByTopic(topicId);
    let best = null;
    for (const candidate of candidates) {
      const similarity = cosineSimilarity(embedding, candidate.embedding);
      if (similarity >= NEAR_DUPLICATE_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { questionId: candidate.question_id, similarity };
      }
    }
    return best;
  }
}

module.exports = {
  QuestionGenerationService,
  NO_GROUNDABLE_ERROR,
  MAX_REQUESTED_COUNT,
  RETRIEVE_LIMIT,
};
