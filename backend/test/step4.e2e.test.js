/**
 * Step 4 full-flow E2E (Jest). Requires a real Postgres with pgvector
 * (pgvector/pgvector:pg16). Self-skips when TEST_DATABASE_URL (or DATABASE_URL)
 * is unset, so `npm run test:e2e` stays green without Docker.
 *
 * Exercises the whole RAG pipeline against real SQL with the OFFLINE mock
 * adapters (mock embeddings + mock LLM, never real Titan/Nova):
 *   migration 013 applied + backfill
 *   upload (MaterialService, mock S3) -> INGEST_MATERIAL handler
 *     -> material_chunk rows persisted with a non-null subject_id
 *   GENERATE_QUESTIONS handler -> PENDING_REVIEW/AI questions carrying
 *     generation_job_id and >=1 question_source_ref
 *   findNearestForTopic spreads retrieval across both materials
 *   questionService.approveBatch flips the batch to APPROVED all-or-nothing
 *
 * Run against the local stack:
 *   docker compose up -d postgres
 *   $env:TEST_DATABASE_URL='postgres://aives:aives@localhost:5432/aives'
 *   npm run test:e2e
 */
const path = require('path');
const { Pool } = require('pg');

const { runMigrations } = require('../src/db/migrationRunner');
const { CourseMaterialRepository } = require('../src/repositories/courseMaterialRepository');
const { MaterialChunkRepository } = require('../src/repositories/materialChunkRepository');
const { QuestionRepository } = require('../src/repositories/questionRepository');
const { QuestionSourceRefRepository } = require('../src/repositories/questionSourceRefRepository');
const { QuestionGenerationJobRepository } = require('../src/repositories/questionGenerationJobRepository');
const { TopicRepository } = require('../src/repositories/topicRepository');
const { SubjectRepository } = require('../src/repositories/subjectRepository');
const { RubricRepository } = require('../src/repositories/rubricRepository');
const { MaterialService } = require('../src/services/materialService');
const { QuestionService } = require('../src/services/questionService');
const { createAwsClients } = require('../src/services/awsClients');
const { createEmbeddingAdapter } = require('../src/embedding/embeddingAdapter');
const { createMockLlmAdapter } = require('../src/llm/mockLlmAdapter');
const { makeIngestMaterialHandler, makeGenerateQuestionsHandler } = require('../src/jobs/handlers');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');

const describeDb = DB_URL ? describe : describe.skip;

// Shared mutable state threaded across the sequential tests below.
const step4State = {
  materialIds: [],
  jobId: null,
  questionIds: [],
};

// Minimal { query, withTransaction } wrapper over a pg Pool, mirroring the
// production PgDatabase so repositories run their real SQL in a transaction.
function wrapPool(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    async withTransaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = { query: (text, params) => client.query(text, params) };
        const result = await callback(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {},
};

describeDb('step4 full-flow e2e (requires Postgres)', () => {
  jest.setTimeout(60000);

  let pool;
  let db;
  let env;
  let awsClients;
  let embeddingAdapter;
  let llmAdapter;

  // Repositories
  let courseMaterialRepository;
  let materialChunkRepository;
  let questionRepository;
  let questionSourceRefRepository;
  let questionGenerationJobRepository;
  let topicRepository;
  let subjectRepository;
  let rubricRepository;

  // Services / handlers
  let materialService;
  let questionService;
  let ingestHandler;
  let generateHandler;

  // Seeded ids
  let lecturerId;
  let subjectId;
  let topicId;
  let rubricId;
  const enqueued = [];

  // A fake parse so the ingest handler exercises the real chunk/embed/persist
  // transaction without needing a valid binary PDF. One segment per page.
  function fakeParse(materialKey) {
    return async function parse() {
      return {
        pageCount: 2,
        segments: [
          { page: 1, text: `${materialKey} page one: threads share memory within a process and must synchronize access to shared state.` },
          { page: 2, text: `${materialKey} page two: deadlock arises when two threads each hold a lock the other needs.` },
        ],
      };
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await runMigrations({ pool, dir: MIGRATIONS_DIR, logger: { info() {} } });
    db = wrapPool(pool);

    env = {
      awsMockMode: true,
      dbMockMode: false,
      materialsBucket: 'step4-e2e-bucket',
      embeddingProvider: 'mock',
      llmProvider: 'mock',
    };
    awsClients = createAwsClients(env);
    embeddingAdapter = createEmbeddingAdapter(env);
    llmAdapter = createMockLlmAdapter();

    courseMaterialRepository = new CourseMaterialRepository(db);
    materialChunkRepository = new MaterialChunkRepository(db);
    questionRepository = new QuestionRepository(db);
    questionSourceRefRepository = new QuestionSourceRefRepository(db);
    questionGenerationJobRepository = new QuestionGenerationJobRepository(db);
    topicRepository = new TopicRepository(db);
    subjectRepository = new SubjectRepository(db);
    rubricRepository = new RubricRepository(db);

    materialService = new MaterialService({
      courseMaterialRepository,
      subjectRepository,
      topicRepository,
      awsClients,
      enqueueJob: async (type, payload) => { enqueued.push({ type, payload }); },
      env,
      logger: silentLogger,
    });

    questionService = new QuestionService({
      repository: questionRepository,
      embeddingAdapter,
      rubricRepository,
      topicRepository,
      db,
      questionSourceRefRepository,
    });

    generateHandler = makeGenerateQuestionsHandler({
      db,
      questionGenerationJobRepository,
      courseMaterialRepository,
      materialChunkRepository,
      questionRepository,
      questionSourceRefRepository,
      topicRepository,
      embeddingAdapter,
      llmAdapter,
      logger: silentLogger,
    });

    // --- Seed lecturer / subject / topic / rubric ---
    const suffix = Date.now();
    const user = await pool.query(
      `INSERT INTO app_user (email, full_name, role, status)
       VALUES ($1, 'Step4 Lecturer', 'LECTURER', 'ACTIVE') RETURNING app_user_id`,
      [`step4-lecturer-${suffix}@aives.local`],
    );
    lecturerId = user.rows[0].app_user_id;

    const subject = await pool.query(
      'INSERT INTO subject (code, name) VALUES ($1, $2) RETURNING subject_id',
      [`S4-${suffix}`, 'Step4 Subject'],
    );
    subjectId = subject.rows[0].subject_id;
    await pool.query(
      'INSERT INTO subject_lecturer (subject_id, lecturer_id) VALUES ($1, $2)',
      [subjectId, lecturerId],
    );

    // Topic name carries the run suffix so the deterministic mock-LLM drafts
    // (which embed the topic name in their content) are unique per run and are
    // never dropped as exact duplicates of a prior run's persisted questions.
    const topic = await pool.query(
      'INSERT INTO topic (name, subject_id) VALUES ($1, $2) RETURNING topic_id',
      [`Concurrency ${suffix}`, subjectId],
    );
    topicId = topic.rows[0].topic_id;

    const rubric = await pool.query(
      'INSERT INTO rubric (max_score, subject_id, created_by) VALUES (10, $1, $2) RETURNING rubric_id',
      [subjectId, lecturerId],
    );
    rubricId = rubric.rows[0].rubric_id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  test('migration 013: material_chunk.subject_id column and material index exist', async () => {
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'material_chunk' AND column_name = 'subject_id'`,
    );
    expect(col.rowCount).toBe(1);

    const idx = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_material_chunk_material'",
    );
    expect(idx.rowCount).toBe(1);
  });

  test('migration 013 backfills subject_id from the parent material', async () => {
    // Insert a material and a legacy chunk with NULL subject_id, then run the
    // backfill statement and assert it is populated from course_material.
    const material = await pool.query(
      `INSERT INTO course_material (subject_id, title, file_key, mime_type, status)
       VALUES ($1, 'Legacy', 'legacy/key', 'application/pdf', 'READY')
       RETURNING course_material_id`,
      [subjectId],
    );
    const legacyMaterialId = material.rows[0].course_material_id;
    const chunk = await pool.query(
      `INSERT INTO material_chunk (material_id, subject_id, chunk_no, content, embedding)
       VALUES ($1, NULL, 1, 'legacy chunk', NULL)
       RETURNING material_chunk_id`,
      [legacyMaterialId],
    );
    const legacyChunkId = chunk.rows[0].material_chunk_id;

    await pool.query(
      `UPDATE material_chunk mc
          SET subject_id = cm.subject_id
         FROM course_material cm
        WHERE cm.course_material_id = mc.material_id
          AND mc.subject_id IS NULL`,
    );

    const after = await pool.query(
      'SELECT subject_id FROM material_chunk WHERE material_chunk_id = $1',
      [legacyChunkId],
    );
    expect(after.rows[0].subject_id).toBe(subjectId);
  });

  test('upload -> ingest persists chunks with a non-null subject_id', async () => {
    // Two materials so retrieval can spread across both.
    const materialIds = [];
    for (let m = 1; m <= 2; m += 1) {
      // eslint-disable-next-line no-await-in-loop
      const material = await materialService.upload({
        user: { id: lecturerId, role: 'LECTURER' },
        subjectId: String(subjectId),
        file: {
          buffer: Buffer.from(`material ${m} payload`),
          originalname: `concurrency-${m}.pdf`,
          mimetype: 'application/pdf',
          size: 20,
        },
      });
      materialIds.push(material.course_material_id);
    }

    expect(enqueued.filter((j) => j.type === 'INGEST_MATERIAL')).toHaveLength(2);

    // Run the real INGEST_MATERIAL handler per material with a fake parser so
    // the chunk/embed/transaction path runs against real SQL.
    for (const materialId of materialIds) {
      ingestHandler = makeIngestMaterialHandler({
        db,
        courseMaterialRepository,
        materialChunkRepository,
        embeddingAdapter,
        awsClients,
        parse: fakeParse(`m${materialId}`),
        env,
        logger: silentLogger,
      });
      // eslint-disable-next-line no-await-in-loop
      await ingestHandler({ background_job_id: 1, payload: { materialId } });
      // eslint-disable-next-line no-await-in-loop
      const material = await courseMaterialRepository.findById(materialId);
      expect(material.status).toBe('READY');
      expect(material.page_count).toBe(2);
    }

    const chunks = await pool.query(
      'SELECT subject_id FROM material_chunk WHERE material_id = ANY($1)',
      [materialIds],
    );
    expect(chunks.rowCount).toBeGreaterThanOrEqual(2);
    expect(chunks.rows.every((r) => r.subject_id === subjectId)).toBe(true);

    // Stash for later tests.
    step4State.materialIds = materialIds;
  });

  test('findNearestForTopic spreads retrieval across both materials', async () => {
    const queryEmbedding = await embeddingAdapter.embed('threads and deadlock');
    const rows = await materialChunkRepository.findNearestForTopic({
      materialIds: step4State.materialIds,
      queryEmbedding,
      limit: 4,
    });
    expect(rows.length).toBeGreaterThan(0);
    const materialsSeen = new Set(rows.map((r) => r.material_id));
    expect(materialsSeen.size).toBe(2);
  });

  test('generation -> PENDING_REVIEW/AI questions with generation_job_id + citations', async () => {
    const job = await questionGenerationJobRepository.create({
      topicId,
      materialIds: step4State.materialIds,
      requestedCount: 3,
      bloomDistribution: null,
      language: 'en',
      status: 'PENDING',
      requestedBy: lecturerId,
    });
    const jobId = job.question_generation_job_id;

    await generateHandler({ background_job_id: 2, payload: { jobId } });

    const after = await questionGenerationJobRepository.findById(jobId);
    expect(after.status).toBe('COMPLETED');
    expect(after.generated_count).toBe(3);

    const questions = await pool.query(
      `SELECT question_id, status, source, generation_job_id
         FROM question WHERE generation_job_id = $1 ORDER BY question_id`,
      [jobId],
    );
    expect(questions.rowCount).toBe(3);
    expect(questions.rows.every((q) => q.status === 'PENDING_REVIEW')).toBe(true);
    expect(questions.rows.every((q) => q.source === 'AI')).toBe(true);

    // Every AI question has at least one source citation, and sources map.
    for (const q of questions.rows) {
      // eslint-disable-next-line no-await-in-loop
      const sources = await questionService.getQuestionSources(q.question_id);
      expect(sources.length).toBeGreaterThanOrEqual(1);
      expect(sources[0].materialTitle).toBeTruthy();
      expect(sources[0].content).toBeTruthy();
    }

    step4State.jobId = jobId;
    step4State.questionIds = questions.rows.map((q) => q.question_id);
  });

  test('approveBatch flips the whole batch to APPROVED all-or-nothing', async () => {
    const approved = await questionService.approveBatch({
      questionIds: step4State.questionIds,
      rubricId,
      reviewedBy: lecturerId,
    });
    expect(approved).toHaveLength(step4State.questionIds.length);
    expect(approved.every((q) => q.status === 'APPROVED')).toBe(true);
    expect(approved.every((q) => q.rubricId === rubricId)).toBe(true);

    const rows = await pool.query(
      'SELECT status, rubric_id FROM question WHERE question_id = ANY($1)',
      [step4State.questionIds],
    );
    expect(rows.rows.every((r) => r.status === 'APPROVED')).toBe(true);
    expect(rows.rows.every((r) => r.rubric_id === rubricId)).toBe(true);
  });

  test('approveBatch rolls the whole batch back when one id is not PENDING_REVIEW', async () => {
    // The questions are already APPROVED now, so re-approving is an illegal
    // transition for ALL of them -> the batch must throw and write nothing new.
    // To make the rollback observable, add a fresh PENDING_REVIEW question and
    // pair it with an already-APPROVED one.
    const fresh = await pool.query(
      `INSERT INTO question (topic_id, content, status, source, reference_answer, key_points)
       VALUES ($1, $2, 'PENDING_REVIEW', 'AI', 'Reference answer.', '["Key point"]'::jsonb)
       RETURNING question_id`,
      [topicId, `rollback-probe ${Date.now()}`],
    );
    const freshId = fresh.rows[0].question_id;
    const approvedId = step4State.questionIds[0];

    await expect(
      questionService.approveBatch({
        questionIds: [freshId, approvedId],
        rubricId,
        reviewedBy: lecturerId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    // The fresh question must still be PENDING_REVIEW with no rubric: the whole
    // batch rolled back (up-front validation rejected before any write).
    const probe = await pool.query(
      'SELECT status, rubric_id FROM question WHERE question_id = $1',
      [freshId],
    );
    expect(probe.rows[0].status).toBe('PENDING_REVIEW');
    expect(probe.rows[0].rubric_id).toBeNull();
  });
});
