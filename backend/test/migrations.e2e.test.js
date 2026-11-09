/**
 * Migration-runner E2E (Jest). Requires a real Postgres with the `vector`
 * extension available (pgvector/pgvector:pg16).
 *
 * Self-skips when TEST_DATABASE_URL (or DATABASE_URL) is unset, so
 * `npm run test:e2e` stays green without Docker. Run against the local stack:
 *   docker compose up -d postgres
 *   $env:TEST_DATABASE_URL='postgres://aives:aives@localhost:5432/aives'
 *   npm run test:e2e
 */
const path = require('path');
const { Pool } = require('pg');
const { runMigrations } = require('../src/db/migrationRunner');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');

// Every table authored across the unified-model migrations (FEAT-001).
const EXPECTED_TABLES = [
  'app_user',
  'auth_session',
  'password_token',
  'subject',
  'subject_lecturer',
  'subject_student',
  'course_material',
  'material_chunk',
  'performance_level',
  'question_generation_job',
  'question_source_ref',
  'exam_session',
  'exam_session_student',
  'exam_session_examiner',
  'viva_interview',
  'assigned_question',
  'qa_turn',
  'transcript',
  'processing_failure',
  'viva_result',
  'question_evaluation',
  'criterion_score',
  'score_adjustment',
  'background_job',
];

const describeOrSkip = DB_URL ? describe : describe.skip;

describeOrSkip('migrations e2e (requires Postgres)', () => {
  jest.setTimeout(60000);
  let pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await runMigrations({ pool, dir: MIGRATIONS_DIR, logger: { info() {} } });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  test('every unified-model table exists', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    const present = new Set(rows.map((r) => r.table_name));
    for (const table of EXPECTED_TABLES) {
      expect(present.has(table)).toBe(true);
    }
  });

  test('migration 032 adds STT dispute columns to qa_turn', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'qa_turn' AND column_name IN ('stt_disputed_at', 'stt_dispute_note')`,
    );
    const cols = new Map(rows.map((r) => [r.column_name, r]));
    expect(cols.has('stt_disputed_at')).toBe(true);
    expect(cols.get('stt_disputed_at').data_type).toBe('timestamp with time zone');
    expect(cols.get('stt_disputed_at').is_nullable).toBe('YES');
    expect(cols.has('stt_dispute_note')).toBe(true);
    expect(cols.get('stt_dispute_note').data_type).toBe('text');
    expect(cols.get('stt_dispute_note').is_nullable).toBe('YES');
  });

  test('pgvector extension and material_chunk HNSW index exist', async () => {
    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(ext.rowCount).toBe(1);

    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'material_chunk' AND indexdef ILIKE '%hnsw%'`,
    );
    expect(idx.rowCount).toBeGreaterThanOrEqual(1);
    expect(idx.rows[0].indexdef.toLowerCase()).toContain('hnsw');
  });

  test('re-running migrations applies zero new versions (idempotent)', async () => {
    const result = await runMigrations({ pool, dir: MIGRATIONS_DIR, logger: { info() {} } });
    expect(result.applied).toEqual([]);
  });

  test('migration 021 backfills subject_student from exam_session_student and is idempotent', async () => {
    const fs = require('fs');
    const suffix = Date.now();

    // 1. Seed user (STUDENT)
    const userRes = await pool.query(
      `INSERT INTO app_user (code, email, full_name, role, status)
       VALUES ($1, $2, 'Backfill Student', 'STUDENT', 'ACTIVE')
       RETURNING app_user_id`,
      [`BF_${suffix}`, `bf_${suffix}@aives.local`],
    );
    const studentId = userRes.rows[0].app_user_id;

    // 2. Seed subject
    const subRes = await pool.query(
      `INSERT INTO subject (code, name)
       VALUES ($1, 'Backfill Subject')
       RETURNING subject_id`,
      [`SUB_${suffix}`],
    );
    const subjectId = subRes.rows[0].subject_id;

    // 3. Seed topic
    const topicRes = await pool.query(
      `INSERT INTO topic (name, subject_id)
       VALUES ('Backfill Topic', $1)
       RETURNING topic_id`,
      [subjectId],
    );
    const topicId = topicRes.rows[0].topic_id;

    // 4. Seed exam_session
    const esRes = await pool.query(
      `INSERT INTO exam_session (subject_id, topic_id, title, language)
       VALUES ($1, $2, 'Backfill Session', 'EN')
       RETURNING exam_session_id`,
      [subjectId, topicId],
    );
    const examSessionId = esRes.rows[0].exam_session_id;

    // 5. Seed exam_session_student
    await pool.query(
      `INSERT INTO exam_session_student (exam_session_id, student_id)
       VALUES ($1, $2)`,
      [examSessionId, studentId],
    );

    try {
      // 6. Delete any existing enrollment
      await pool.query(
        `DELETE FROM subject_student WHERE subject_id = $1 AND student_id = $2`,
        [subjectId, studentId],
      );

      // 7. Read and run migration 021 SQL
      const sql021 = fs.readFileSync(path.join(MIGRATIONS_DIR, '021_backfill_subject_student.sql'), 'utf8');
      await pool.query(sql021);

      // 8. Assert row was backfilled into subject_student
      const checkRes1 = await pool.query(
        `SELECT * FROM subject_student WHERE subject_id = $1 AND student_id = $2`,
        [subjectId, studentId],
      );
      expect(checkRes1.rowCount).toBe(1);

      // 9. Re-run migration SQL to verify idempotency (no duplicate error)
      await pool.query(sql021);
      const checkRes2 = await pool.query(
        `SELECT * FROM subject_student WHERE subject_id = $1 AND student_id = $2`,
        [subjectId, studentId],
      );
      expect(checkRes2.rowCount).toBe(1);
    } finally {
      // 10. Clean up
      await pool.query(`DELETE FROM exam_session_student WHERE exam_session_id = $1`, [examSessionId]);
      await pool.query(`DELETE FROM subject_student WHERE subject_id = $1`, [subjectId]);
      await pool.query(`DELETE FROM exam_session WHERE exam_session_id = $1`, [examSessionId]);
      await pool.query(`DELETE FROM topic WHERE topic_id = $1`, [topicId]);
      await pool.query(`DELETE FROM subject WHERE subject_id = $1`, [subjectId]);
      await pool.query(`DELETE FROM app_user WHERE app_user_id = $1`, [studentId]);
    }
  });

  test('question status CHECK accepts APPROVED and rejects legacy Active', async () => {
    // A fresh topic to satisfy the NOT NULL FK on question.topic_id.
    const topic = await pool.query(
      "INSERT INTO topic (name) VALUES ('migration-e2e-topic') RETURNING topic_id",
    );
    const topicId = topic.rows[0].topic_id;

    const approved = await pool.query(
      `INSERT INTO question (topic_id, content, status)
       VALUES ($1, $2, 'APPROVED') RETURNING question_id, status`,
      [topicId, `migration-e2e approved ${Date.now()}`],
    );
    expect(approved.rows[0].status).toBe('APPROVED');

    await expect(
      pool.query(
        `INSERT INTO question (topic_id, content, status)
         VALUES ($1, $2, 'Active')`,
        [topicId, `migration-e2e legacy ${Date.now()}`],
      ),
    ).rejects.toThrow();
  });
});
