const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { ExamSessionRepository } = require('../src/repositories/examSessionRepository');

const DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = DB_URL ? describe : describe.skip;

describeDb('legacy question eligibility on Postgres', () => {
  let pool;
  let client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    // A temporary table exercises the actual migration against all JSONB shapes
    // without changing production-like test data or migration history.
    await client.query(`CREATE TEMP TABLE question (
      question_id int, topic_id int, status text, rubric_id int,
      reference_answer text, key_points jsonb, bloom_level text,
      content text, language text
    ) ON COMMIT DROP`);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  test('migration and exam bank queries agree for complete and incomplete approved questions', async () => {
    const rows = [
      [1, 100, 'answer', '["point"]'],
      [2, 100, 'answer', '[]'],
      [3, 100, 'answer', '{"point":"value"}'],
      [4, 100, 'answer', 'null'],
      [5, 100, 'answer', null],
      [6, 100, '   ', '["point"]'],
      [7, 100, 'answer', '[42,"  ","valid"]'],
      [8, null, 'answer', '["point"]'],
    ];
    for (const [id, rubricId, answer, points] of rows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO question (question_id, topic_id, status, rubric_id,
          reference_answer, key_points, bloom_level, content, language)
         VALUES ($1, 10, 'APPROVED', $2, $3, $4::jsonb, 'REMEMBER', 'Q', 'EN')`,
        [id, rubricId, answer, points],
      );
    }
    const repo = new ExamSessionRepository(client);
    expect(await repo.listApprovedQuestionIdsInTopic(10)).toEqual([1, 7]);

    const migration = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '030_legacy_question_eligibility.sql'),
      'utf8',
    );
    await client.query(migration);
    const result = await client.query('SELECT question_id, status FROM question ORDER BY question_id');
    expect(result.rows.filter((row) => row.status === 'APPROVED').map((row) => row.question_id)).toEqual([1, 7]);
    expect(result.rows.filter((row) => row.status === 'PENDING_REVIEW').map((row) => row.question_id))
      .toEqual([2, 3, 4, 5, 6, 8]);
    expect(await repo.countApprovedQuestionsInTopic(10)).toBe(2);
    expect(await repo.listApprovedQuestionIdsInTopic(10)).toEqual([1, 7]);
    expect((await repo.countApprovedByTopicsAndBloom([10]))[0].count).toBe(2);
    expect((await repo.countApprovedByTopicsAndLanguage([10]))[0].count).toBe(2);
  });
});
