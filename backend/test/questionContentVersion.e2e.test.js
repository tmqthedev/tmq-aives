const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = DB_URL ? describe : describe.skip;

describeDb('question content_version trigger (migration 035) on Postgres', () => {
  let pool;
  let client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    client = await pool.connect();
    await client.query('BEGIN');
    // A temp table shadows the real one so the migration's trigger function is
    // exercised without touching test data; the function is rolled back too.
    await client.query(`CREATE TEMP TABLE question (
      question_id int, topic_id int, status text, rubric_id int, content text,
      reference_answer text, key_points jsonb, bloom_level text, language text,
      review_note text, embedding text, content_version int NOT NULL DEFAULT 1
    ) ON COMMIT DROP`);
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/035_question_content_version_scope.sql'), 'utf8');
    await client.query(sql);
    await client.query(`CREATE TRIGGER t BEFORE UPDATE ON pg_temp.question
      FOR EACH ROW EXECUTE FUNCTION bump_question_content_version()`);
    await client.query(`INSERT INTO pg_temp.question (question_id, topic_id, status, rubric_id, content,
      reference_answer, key_points, bloom_level, language) VALUES
      (1, 1, 'APPROVED', 1, 'Q', 'A', '["p"]', 'APPLY', 'vi')`);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  const version = async () => (await client.query('SELECT content_version FROM pg_temp.question WHERE question_id = 1')).rows[0].content_version;

  test('bookkeeping writes keep the version; knowledge and status changes bump it', async () => {
    await client.query("UPDATE pg_temp.question SET review_note = 'ok', embedding = 'v' WHERE question_id = 1");
    expect(await version()).toBe(1);
    await client.query("UPDATE pg_temp.question SET reference_answer = 'A2' WHERE question_id = 1");
    expect(await version()).toBe(2);
    await client.query("UPDATE pg_temp.question SET status = 'ARCHIVED' WHERE question_id = 1");
    expect(await version()).toBe(3);
    await client.query("UPDATE pg_temp.question SET content_version = 99 WHERE question_id = 1");
    expect(await version()).toBe(3);
  });
});
