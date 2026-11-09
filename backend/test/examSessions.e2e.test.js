/**
 * Step 5 exam-session API E2E (Jest + Supertest).
 *
 * The DB-backed flow requires a real Postgres (the in-memory mock DB does NOT
 * model exam_session SQL). It self-skips when TEST_DATABASE_URL (or
 * DATABASE_URL) is unset, so `npm run test:e2e` stays green offline. Run it:
 *   docker compose up -d postgres
 *   $env:TEST_DATABASE_URL='postgres://aives:aives@localhost:5432/aives'
 *   npm run test:e2e
 *
 * It exercises the real router + controller + service against real SQL with the
 * MOCK adapters only (mock TTS; never a real Google call):
 *   create -> set students (valid + unknown-code 422) -> set examiners
 *   -> window/Bloom update -> schedule (NOT_ENOUGH_QUESTIONS 409 per level,
 *   then SCHEDULED) -> ADMIN start (OPEN + rubric locked + background warm-up
 *   and jobs) -> admin schedule list / re-warm -> close (Step 12)
 *
 * The FEAT-001 F2 assertion (/api/topics returns 401 unauthenticated) runs
 * OFFLINE and so is kept outside the DB gate.
 */
const path = require('path');
const request = require('supertest');
const pino = require('pino');
const { Pool } = require('pg');

const { createApp } = require('../src/app');
const { InMemoryDatabase } = require('../src/db/createDatabase');
const { runMigrations } = require('../src/db/migrationRunner');
const { ACCESS_COOKIE } = require('../src/auth/cookieNames');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');
const describeDb = DB_URL ? describe : describe.skip;

// Minimal { query, withTransaction } wrapper over a pg Pool, mirroring the
// production PgDatabase so the repositories run their real SQL.
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

// --- FEAT-001 F2: /api/topics behind requireAuth (offline-safe) -------------

describe('topic mount requires auth (offline)', () => {
  function offlineApp() {
    return createApp({
      env: { awsMockMode: true, dbMockMode: true },
      database: new InMemoryDatabase({ persist: false }),
      logger: pino({ level: 'silent' }),
    });
  }

  test('GET /api/topics without auth -> 401', async () => {
    const res = await request(offlineApp()).get('/api/topics');
    expect(res.status).toBe(401);
  });
});

describeDb('exam-sessions API e2e (requires Postgres)', () => {
  jest.setTimeout(60000);

  let pool;
  let db;
  let app;
  let cookie;
  let adminCookie;
  let adminId;

  let lecturerId;
  let subjectId;
  let topicId;
  let rubricId;
  const studentCodes = [];
  let examinerId;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await runMigrations({ pool, dir: MIGRATIONS_DIR, logger: { info() {} } });
    db = wrapPool(pool);

    const env = {
      awsMockMode: true,
      dbMockMode: false,
      ttsProvider: 'mock',
    };
    app = createApp({
      env,
      database: db,
      logger: pino({ level: 'silent' }),
    });

    const suffix = Date.now();

    const lecturer = await pool.query(
      `INSERT INTO app_user (email, full_name, role, status)
       VALUES ($1, 'Step5 Lecturer', 'LECTURER', 'ACTIVE') RETURNING app_user_id`,
      [`step5-lecturer-${suffix}@aives.local`],
    );
    lecturerId = lecturer.rows[0].app_user_id;

    const examiner = await pool.query(
      `INSERT INTO app_user (email, full_name, role, status)
       VALUES ($1, 'Step5 Examiner', 'LECTURER', 'ACTIVE') RETURNING app_user_id`,
      [`step5-examiner-${suffix}@aives.local`],
    );
    examinerId = examiner.rows[0].app_user_id;

    // Two students (resolved by code) + a non-student for the roster checks.
    for (let i = 1; i <= 2; i += 1) {
      const code = `STU-${suffix}-${i}`;
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO app_user (code, email, full_name, role, status)
         VALUES ($1, $2, 'Step5 Student', 'STUDENT', 'ACTIVE')`,
        [code, `${code}@aives.local`],
      );
      studentCodes.push(code);
    }

    const subject = await pool.query(
      'INSERT INTO subject (code, name) VALUES ($1, $2) RETURNING subject_id',
      [`S5-${suffix}`, 'Step5 Subject'],
    );
    subjectId = subject.rows[0].subject_id;
    await pool.query(
      'INSERT INTO subject_lecturer (subject_id, lecturer_id) VALUES ($1, $2), ($1, $3)',
      [subjectId, lecturerId, examinerId],
    );

    for (const sc of studentCodes) {
      const u = await pool.query('SELECT app_user_id FROM app_user WHERE code = $1', [sc]);
      await pool.query(
        'INSERT INTO subject_student (subject_id, student_id) VALUES ($1, $2)',
        [subjectId, u.rows[0].app_user_id],
      );
    }

    const topic = await pool.query(
      'INSERT INTO topic (name, subject_id) VALUES ($1, $2) RETURNING topic_id',
      [`Step5 Topic ${suffix}`, subjectId],
    );
    topicId = topic.rows[0].topic_id;

    const rubric = await pool.query(
      'INSERT INTO rubric (max_score, subject_id, created_by) VALUES (10, $1, $2) RETURNING rubric_id',
      [subjectId, lecturerId],
    );
    rubricId = rubric.rows[0].rubric_id;

    const { token } = app.authContext.tokenService.signAccess({ sub: lecturerId, role: 'LECTURER' });
    cookie = `${ACCESS_COOKIE}=${token}`;

    const adminRow = await pool.query(
      `INSERT INTO app_user (email, full_name, role, status)
       VALUES ($1, 'Step12 Admin', 'ADMIN', 'ACTIVE') RETURNING app_user_id`,
      [`step12-admin-${suffix}@aives.local`],
    );
    adminId = adminRow.rows[0].app_user_id;
    const adminToken = app.authContext.tokenService.signAccess({ sub: adminId, role: 'ADMIN' }).token;
    adminCookie = `${ACCESS_COOKIE}=${adminToken}`;
  });

  afterAll(async () => {
    // The launch enqueued KEEP_WARM / PREPARE_EXAM_AUDIO with no worker here;
    // drop them so a local backend sharing this DB does not pick them up.
    if (pool && examSessionId) {
      await pool.query(
        "DELETE FROM background_job WHERE type IN ('KEEP_WARM', 'PREPARE_EXAM_AUDIO') AND payload->>'examSessionId' = $1",
        [String(examSessionId)],
      );
    }
    if (pool) await pool.end();
  });

  let examSessionId;

  test('create -> 409 NO_APPROVED_QUESTIONS while the topic bank is empty (language is derived from it)', async () => {
    const res = await request(app)
      .post('/api/exam-sessions')
      .set('Cookie', cookie)
      .send({ subjectId, topicId, title: 'Too early' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_APPROVED_QUESTIONS');
  });

  test('create -> 201 DRAFT with Nhom-3 defaults', async () => {
    await pool.query(
      `INSERT INTO question (topic_id, rubric_id, content, status, source, bloom_level, language,
                             reference_answer, key_points)
       VALUES ($1, $2, $3, 'APPROVED', 'MANUAL', 'UNDERSTAND', 'en',
               'Reference answer.', '["Key point"]'::jsonb)`,
      [topicId, rubricId, `Seed approved question ${Date.now()}`],
    );
    const res = await request(app)
      .post('/api/exam-sessions')
      .set('Cookie', cookie)
      .send({
        subjectId, topicId, title: 'Midterm Viva', language: 'EN',
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.main_question_count).toBe(3);
    expect(res.body.max_follow_ups_per_question).toBe(2);
    expect(res.body.session_time_limit_sec).toBe(1800);
    // The client-sent language is ignored; the English bank decides it.
    expect(res.body.language).toBe('EN');
    examSessionId = res.body.exam_session_id;
  });

  test('GET /api/exam-sessions/options returns in-scope subjects, topics, students and lecturers', async () => {
    const res = await request(app)
      .get('/api/exam-sessions/options')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.subjects)).toBe(true);
    const sub = res.body.subjects.find((s) => s.subject_id === subjectId);
    expect(sub).toBeDefined();
    expect(sub.topics.some((t) => t.topic_id === topicId)).toBe(true);
    expect(sub.students.length).toBeGreaterThanOrEqual(2);
    expect(sub.lecturers.length).toBeGreaterThanOrEqual(2);
  });

  test('admin PUT /api/admin/subjects/:id/students enrolls students', async () => {
    const res = await request(app)
      .put(`/api/admin/subjects/${subjectId}/students`)
      .set('Cookie', adminCookie)
      .send({ codes: studentCodes.join('\n') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.studentIds.length).toBe(2);
  });

  test('set students: unknown code -> 422 all-or-nothing', async () => {
    const res = await request(app)
      .put(`/api/exam-sessions/${examSessionId}/students`)
      .set('Cookie', cookie)
      .send({ codes: `${studentCodes[0]}\nNO-SUCH-CODE` });
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors[0].code).toBe('NO-SUCH-CODE');

    const after = await pool.query(
      'SELECT COUNT(*)::int AS count FROM exam_session_student WHERE exam_session_id = $1',
      [examSessionId],
    );
    expect(after.rows[0].count).toBe(0);
  });

  test('set students: valid list -> writes roster', async () => {
    const res = await request(app)
      .put(`/api/exam-sessions/${examSessionId}/students`)
      .set('Cookie', cookie)
      .send({ codes: studentCodes.join('\n') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.students).toHaveLength(2);
  });

  test('set examiners -> writes examiner rows', async () => {
    const res = await request(app)
      .put(`/api/exam-sessions/${examSessionId}/examiners`)
      .set('Cookie', cookie)
      .send({ lecturerIds: [examinerId] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.examiners).toContain(examinerId);
  });

  test('update: schedule window, total follow-up cap and Bloom mix', async () => {
    const opensAt = new Date(Date.now() - 60 * 1000).toISOString();
    const closesAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const res = await request(app)
      .put(`/api/exam-sessions/${examSessionId}`)
      .set('Cookie', cookie)
      .send({
        opens_at: opensAt,
        closes_at: closesAt,
        max_follow_ups_total: 3,
        bloom_distribution: { UNDERSTAND: 2, APPLY: 1 },
      });
    expect(res.status).toBe(200);
    expect(new Date(res.body.opens_at).toISOString()).toBe(opensAt);
    expect(res.body.max_follow_ups_total).toBe(3);
    expect(res.body.bloom_distribution).toEqual({ UNDERSTAND: 2, APPLY: 1 });

    const bad = await request(app)
      .put(`/api/exam-sessions/${examSessionId}`)
      .set('Cookie', cookie)
      .send({ closes_at: new Date(Date.now() - 3600 * 1000).toISOString() });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
  });

  test('schedule: NOT_ENOUGH_QUESTIONS 409 with per-level details before enough APPROVED questions', async () => {
    const res = await request(app)
      .post(`/api/exam-sessions/${examSessionId}/schedule`)
      .set('Cookie', cookie)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ENOUGH_QUESTIONS');
    expect(res.body.details.required).toBe(3);
    expect(res.body.details.byLevel.APPLY).toEqual({ required: 1, available: 0 });
  });

  test('schedule: DRAFT -> SCHEDULED once the bank covers the Bloom mix', async () => {
    const levels = ['UNDERSTAND', 'UNDERSTAND', 'APPLY'];
    for (let i = 0; i < levels.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO question (topic_id, rubric_id, content, status, source, bloom_level,
                               reference_answer, key_points)
         VALUES ($1, $2, $3, 'APPROVED', 'AI', $4, 'Reference answer.', '["Key point"]'::jsonb)`,
        [topicId, rubricId, `Approved Q${i} ${Date.now()}`, levels[i]],
      );
    }
    const res = await request(app)
      .post(`/api/exam-sessions/${examSessionId}/schedule`)
      .set('Cookie', cookie)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SCHEDULED');
    expect(res.body.scheduled_by).toBe(lecturerId);
    expect(res.body.scheduled_at).toBeTruthy();
  });

  test('the lecturer can no longer open or start an exam', async () => {
    const open = await request(app)
      .post(`/api/exam-sessions/${examSessionId}/open`)
      .set('Cookie', cookie)
      .send();
    expect(open.status).toBe(404);
    const start = await request(app)
      .post(`/api/admin/exam-sessions/${examSessionId}/start`)
      .set('Cookie', cookie)
      .send();
    expect(start.status).toBe(403);
  });

  test('admin start: SCHEDULED -> OPEN, rubric locked, warm-up and jobs in the background', async () => {
    const before = await pool.query('SELECT opens_at FROM exam_session WHERE exam_session_id = $1', [examSessionId]);
    const res = await request(app)
      .post(`/api/admin/exam-sessions/${examSessionId}/start`)
      .set('Cookie', adminCookie)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('OPEN');
    expect(res.body.session.started_by).toBe(adminId);
    expect(res.body.session.started_at).toBeTruthy();
    expect(new Date(res.body.session.opens_at).getTime()).toBe(new Date(before.rows[0].opens_at).getTime());

    const locked = await pool.query('SELECT is_locked FROM rubric WHERE rubric_id = $1', [rubricId]);
    expect(locked.rows[0].is_locked).toBe(true);

    // The launch is fire-and-forget: poll until the mock warm-ups landed.
    let warm = null;
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const row = await pool.query('SELECT warm_status FROM exam_session WHERE exam_session_id = $1', [examSessionId]);
      warm = row.rows[0].warm_status;
      if (warm && warm.stt && warm.stt.ok === true && warm.tts && warm.tts.ok === true) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    expect(warm.stt.ok).toBe(true);
    expect(warm.tts.ok).toBe(true);
    expect(warm.audio).toEqual({ done: 0, total: 4, state: 'pending' }); // 3 + the seed question
    expect(warm.keepWarm.state).toBe('active');

    const jobs = await pool.query(
      `SELECT type, run_after FROM background_job
       WHERE payload->>'examSessionId' = $1 ORDER BY background_job_id`,
      [String(examSessionId)],
    );
    expect(jobs.rows.map((j) => j.type)).toEqual(['PREPARE_EXAM_AUDIO', 'KEEP_WARM']);
    expect(new Date(jobs.rows[1].run_after).getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    const again = await request(app)
      .post(`/api/admin/exam-sessions/${examSessionId}/start`)
      .set('Cookie', adminCookie)
      .send();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  test('admin schedule list and manual re-warm', async () => {
    const list = await request(app)
      .get(`/api/admin/exam-schedule?status=OPEN&subjectId=${subjectId}`)
      .set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    const row = list.body.sessions.find((s) => s.exam_session_id === examSessionId);
    expect(row).toBeTruthy();
    expect(row.subject_code).toMatch(/^S5-/);
    expect(row.creator_name).toBe('Step5 Lecturer');
    expect(row.student_count).toBe(2);
    expect(row.interviews_started).toBe(0);
    expect(row.interviews_completed).toBe(0);
    expect(row.warm_status.keepWarm.state).toBe('active');

    const lecturerList = await request(app).get('/api/admin/exam-schedule').set('Cookie', cookie);
    expect(lecturerList.status).toBe(403);

    const warm = await request(app)
      .post(`/api/admin/exam-sessions/${examSessionId}/warm`)
      .set('Cookie', adminCookie)
      .send();
    expect(warm.status).toBe(200);
    expect(warm.body.warm_status.stt.ok).toBe(true);
    expect(warm.body.warm_status.audio).toBeTruthy();
  });

  test('close: OPEN -> CLOSED by the lecturer; admin close afterwards -> 409', async () => {
    const res = await request(app)
      .post(`/api/exam-sessions/${examSessionId}/close`)
      .set('Cookie', cookie)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLOSED');
    expect(res.body.closes_at).toBeTruthy();

    const again = await request(app)
      .post(`/api/admin/exam-sessions/${examSessionId}/close`)
      .set('Cookie', adminCookie)
      .send();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });
});
