/**
 * Step 6 interview engine E2E against real Postgres (Jest).
 *
 * The in-memory mock DB cannot run the engine SQL, so this suite needs a real
 * Postgres and self-skips when TEST_DATABASE_URL (or DATABASE_URL) is unset,
 * keeping `npm run test:e2e` green offline. Run it:
 *   docker compose up -d postgres
 *   $env:TEST_DATABASE_URL='postgres://aives:aives@localhost:5432/aives'
 *   npm run test:e2e
 *
 * It drives app.interviewContext.interviewService (built by createApp) with the
 * MOCK adapters only (mock LLM / STT / TTS, in-memory SessionContext; no AWS
 * calls) through a full interview, then asserts the persisted rows and the
 * migration 016 constraints.
 */
const path = require('path');
const pino = require('pino');
const { Pool } = require('pg');

const { createApp } = require('../src/app');
const { AssignedQuestionRepository } = require('../src/repositories/assignedQuestionRepository');
const { VivaInterviewRepository } = require('../src/repositories/vivaInterviewRepository');
const { runMigrations } = require('../src/db/migrationRunner');
const { fixedClock, seededRandom } = require('./helpers/interviewFakes');

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

describeDb('interview engine e2e (requires Postgres)', () => {
  jest.setTimeout(60000);

  const KEY_POINTS = ['three-way handshake', 'sequence numbers', 'acknowledgements'];
  const PARTIAL = 'TCP uses sequence numbers to order the bytes.';
  const FULL = `TCP relies on the ${KEY_POINTS.join(', the ')}.`;

  let pool;
  let db;
  let service;
  let gradingService;
  let vivaResultRepository;
  let clock;
  let studentId;
  let examSessionId;
  let rubricId;
  let topicId;
  let subjectId;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await runMigrations({ pool, dir: MIGRATIONS_DIR, logger: { info() {} } });
    db = wrapPool(pool);
    clock = fixedClock('2026-03-01T08:00:00.000Z');
    const app = createApp({
      env: {
        awsMockMode: true, dbMockMode: false, audioBucket: 'e2e-audio', followUpLlmTimeoutMs: 5000,
      },
      database: db,
      logger: pino({ level: 'silent' }),
      clock,
      random: seededRandom(3),
    });
    service = app.interviewContext.interviewService;
    gradingService = app.gradingContext.gradingService;
    vivaResultRepository = app.gradingContext.vivaResultRepository;

    const suffix = Date.now();
    const lecturer = await pool.query(
      `INSERT INTO app_user (email, full_name, role, status)
       VALUES ($1, 'Step6 Lecturer', 'LECTURER', 'ACTIVE') RETURNING app_user_id`,
      [`step6-lecturer-${suffix}@aives.local`],
    );
    const lecturerId = lecturer.rows[0].app_user_id;
    const student = await pool.query(
      `INSERT INTO app_user (code, email, full_name, role, status)
       VALUES ($1, $2, 'Step6 Student', 'STUDENT', 'ACTIVE') RETURNING app_user_id`,
      [`S6-${suffix}`, `step6-student-${suffix}@aives.local`],
    );
    studentId = student.rows[0].app_user_id;

    const subject = await pool.query(
      'INSERT INTO subject (code, name) VALUES ($1, $2) RETURNING subject_id',
      [`S6-${suffix}`, 'Step6 Subject'],
    );
    subjectId = subject.rows[0].subject_id;
    const topic = await pool.query(
      'INSERT INTO topic (name, subject_id) VALUES ($1, $2) RETURNING topic_id',
      [`Step6 Topic ${suffix}`, subjectId],
    );
    topicId = topic.rows[0].topic_id;

    const rubric = await pool.query(
      'INSERT INTO rubric (max_score, subject_id, created_by) VALUES (10, $1, $2) RETURNING rubric_id',
      [subjectId, lecturerId],
    );
    rubricId = rubric.rows[0].rubric_id;
    await pool.query(
      `INSERT INTO rubric_criterion (rubric_id, criterion_name, weight_percent)
       VALUES ($1, 'Accuracy', 60), ($1, 'Clarity', 40)`,
      [rubricId],
    );

    const material = await pool.query(
      `INSERT INTO course_material (subject_id, topic_id, title, file_key, status)
       VALUES ($1, $2, 'Networking notes', 'materials/e2e.pdf', 'READY') RETURNING course_material_id`,
      [subjectId, topicId],
    );
    const chunk = await pool.query(
      `INSERT INTO material_chunk (material_id, chunk_no, location, content, subject_id)
       VALUES ($1, 1, 'page 2', 'A TCP connection is established with a three-way handshake.', $2)
       RETURNING material_chunk_id`,
      [material.rows[0].course_material_id, subjectId],
    );

    const insertQuestion = async (source, n, rationale) => {
      const q = await pool.query(
        `INSERT INTO question (topic_id, rubric_id, content, status, source, bloom_level,
                               reference_answer, key_points, rationale)
         VALUES ($1, $2, $3, 'APPROVED', $4, 'UNDERSTAND', $5, $6::jsonb, $7::jsonb)
         RETURNING question_id`,
        [
          topicId,
          rubricId,
          `Step6 Q${n} ${suffix}: explain how TCP provides reliable delivery.`,
          source,
          'TCP combines a handshake, sequence numbers and acknowledgements.',
          JSON.stringify(KEY_POINTS),
          rationale ? JSON.stringify(rationale) : null,
        ],
      );
      return q.rows[0].question_id;
    };
    const aiId = await insertQuestion('AI', 1, { purpose: 'AI purpose', synthesis: 'AI synthesis' });
    await pool.query(
      'INSERT INTO question_source_ref (question_id, chunk_id, excerpt) VALUES ($1, $2, $3)',
      [aiId, chunk.rows[0].material_chunk_id, 'established with a three-way handshake'],
    );
    await insertQuestion('MANUAL', 2, null);
    await insertQuestion('MANUAL', 3, null);

    const exam = await pool.query(
      `INSERT INTO exam_session
         (subject_id, topic_id, title, language, main_question_count, max_follow_ups_per_question,
          answer_time_limit_sec, think_time_sec, status, created_by, session_time_limit_sec)
       VALUES ($1, $2, 'Step6 viva', 'EN', 3, 1, 120, 0, 'OPEN', $3, 600)
       RETURNING exam_session_id`,
      [subjectId, topicId, lecturerId],
    );
    examSessionId = exam.rows[0].exam_session_id;
    await pool.query(
      'INSERT INTO exam_session_student (exam_session_id, student_id) VALUES ($1, $2)',
      [examSessionId, studentId],
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  const user = () => ({ id: studentId, role: 'STUDENT' });

  test('full interview: start -> follow-up -> mains -> COMPLETED with persisted rows', async () => {
    let view = await service.startOrResume({ user: user(), examSessionId });
    expect(view.status).toBe('IN_PROGRESS');
    expect(view.deadlineAt).toBe('2026-03-01T08:10:00.000Z');
    const interviewId = view.interviewId;

    view = await service.markQuestionPlayed({ user: user(), interviewId, turnId: view.currentTurn.turnId });
    expect(view.currentTurn.status).toBe('ANSWERING');

    // Missing key points -> mock LLM asks one follow-up (max 1).
    view = await service.submitAnswer({
      user: user(), interviewId, turnId: view.currentTurn.turnId, transcript: { text: PARTIAL },
    });
    expect(view.currentTurn.turnType).toBe('FOLLOW_UP');

    // Follow-up answered (cap reached) -> next main; then answer the rest.
    view = await service.submitAnswer({
      user: user(), interviewId, turnId: view.currentTurn.turnId, audio: Buffer.from(PARTIAL), contentType: 'audio/webm',
    });
    expect(view.currentTurn.turnType).toBe('MAIN');
    while (view.status === 'IN_PROGRESS') {
      // eslint-disable-next-line no-await-in-loop
      view = await service.submitAnswer({
        user: user(), interviewId, turnId: view.currentTurn.turnId, transcript: { text: FULL },
      });
    }
    expect(view.status).toBe('COMPLETED');
    expect(view.endReason).toBe('QUESTIONS_EXHAUSTED');
    expect(JSON.stringify(view)).not.toContain('rationale');

    const assigned = await pool.query(
      'SELECT * FROM assigned_question WHERE interview_id = $1 ORDER BY order_no', [interviewId],
    );
    expect(assigned.rows.map((r) => r.order_no)).toEqual([1, 2, 3]);
    expect(assigned.rows.every((r) => r.is_asked)).toBe(true);

    const turns = await pool.query(
      'SELECT * FROM qa_turn WHERE interview_id = $1 ORDER BY sequence_no', [interviewId],
    );
    expect(turns.rows.map((t) => t.sequence_no)).toEqual([1, 2, 3, 4]);
    expect(turns.rows.map((t) => t.turn_type)).toEqual(['MAIN', 'FOLLOW_UP', 'MAIN', 'MAIN']);
    expect(turns.rows.every((t) => t.status === 'ANSWERED')).toBe(true);
    expect(turns.rows[0].answer_deadline_at).toBeTruthy();
    expect(turns.rows[1].rationale.kind).toBe('FOLLOW_UP');
    expect(turns.rows[1].answer_audio_key).toBe(
      `interviews/${interviewId}/turns/${turns.rows[1].qa_turn_id}/answer.webm`,
    );
    for (const t of turns.rows.filter((r) => r.turn_type === 'MAIN')) {
      expect(['MAIN_AI', 'MAIN_LECTURER']).toContain(t.rationale.kind);
    }

    const transcript = await pool.query('SELECT * FROM transcript WHERE interview_id = $1', [interviewId]);
    expect(transcript.rows).toHaveLength(1);
    expect(transcript.rows[0].is_complete).toBe(true);

    const result = await pool.query('SELECT * FROM viva_result WHERE interview_id = $1', [interviewId]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('PENDING');

    const jobs = await pool.query(
      "SELECT * FROM background_job WHERE type = 'GRADE_INTERVIEW' AND payload->>'interviewId' = $1",
      [String(interviewId)],
    );
    expect(jobs.rows).toHaveLength(1);
    // Exercise grading against the migrated schema, including performance_level.criterion_id.
    const graded = await gradingService.gradeInterview({ interviewId });
    expect(['AI_SUGGESTED', 'FLAGGED']).toContain(graded.status);
    const detail = await vivaResultRepository.getFullResultDetail(graded.viva_result_id);
    expect(detail.evaluations[0].criteria[0].criterion_name).toBeTruthy();
    expect(Number(detail.evaluations[0].criteria[0].criterion_weight)).toBeGreaterThan(0);

    const locked = await pool.query('SELECT is_locked FROM rubric WHERE rubric_id = $1', [rubricId]);
    expect(locked.rows[0].is_locked).toBe(true);

    const again = await service.startOrResume({ user: user(), examSessionId });
    expect(again.interviewId).toBe(interviewId);
    expect(again.status).toBe('COMPLETED');
    const count = await pool.query(
      'SELECT COUNT(*)::int AS n FROM viva_interview WHERE exam_session_id = $1', [examSessionId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  test('STT dispute: persisted columns, lecturer turn view and finalized guard', async () => {
    const suffix = `${Date.now()}-d`;
    const student = await pool.query(
      `INSERT INTO app_user (code, email, full_name, role, status)
       VALUES ($1, $2, 'Step6 Dispute Student', 'STUDENT', 'ACTIVE') RETURNING app_user_id`,
      [`S6D-${suffix}`, `step6d-${suffix}@aives.local`],
    );
    const sid = student.rows[0].app_user_id;
    const exam = await pool.query(
      `INSERT INTO exam_session
         (subject_id, topic_id, title, language, main_question_count, max_follow_ups_per_question,
          answer_time_limit_sec, think_time_sec, status, session_time_limit_sec)
       VALUES ($1, $2, 'Step6 dispute viva', 'EN', 1, 0, 120, 0, 'OPEN', 600)
       RETURNING exam_session_id`,
      [subjectId, topicId],
    );
    const examId = exam.rows[0].exam_session_id;
    await pool.query(
      'INSERT INTO exam_session_student (exam_session_id, student_id) VALUES ($1, $2)',
      [examId, sid],
    );

    const su = { id: sid, role: 'STUDENT' };
    let view = await service.startOrResume({ user: su, examSessionId: examId });
    const interviewId = view.interviewId;
    const turnId = view.currentTurn.turnId;
    view = await service.markQuestionPlayed({ user: su, interviewId, turnId });
    view = await service.submitAnswer({ user: su, interviewId, turnId, transcript: { text: FULL } });
    expect(view.status).toBe('COMPLETED');

    // Dispute the answered turn.
    const out = await service.disputeStt({ user: su, interviewId, turnId, note: 'Misheard a term.' });
    expect(out).toEqual({ turnId, sttDisputed: true, sttDisputeNote: 'Misheard a term.' });

    const persisted = await pool.query(
      'SELECT stt_disputed_at, stt_dispute_note FROM qa_turn WHERE qa_turn_id = $1',
      [turnId],
    );
    expect(persisted.rows[0].stt_disputed_at).toBeTruthy();
    expect(persisted.rows[0].stt_dispute_note).toBe('Misheard a term.');

    // Grade, then check the lecturer turn view surfaces the dispute.
    const graded = await gradingService.gradeInterview({ interviewId });
    const detail = await vivaResultRepository.getFullResultDetail(graded.viva_result_id);
    const disputedTurn = detail.evaluations
      .flatMap((e) => e.turns || [])
      .find((t) => t.qa_turn_id === turnId);
    expect(disputedTurn).toBeTruthy();
    expect(disputedTurn.sttDisputed).toBe(true);
    expect(disputedTurn.sttDisputeNote).toBe('Misheard a term.');
    expect(disputedTurn.sttDisputedAt).toBeTruthy();

    // Finalized guard: no further disputes after finalization.
    await pool.query("UPDATE viva_result SET status = 'FINALIZED' WHERE interview_id = $1", [interviewId]);
    await expect(
      service.disputeStt({ user: su, interviewId, turnId, note: 'again' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESULT_FINALIZED' });
  });

  test('Step 12: concurrent starts serialize on the exam lock -> no overlap, same Bloom mix', async () => {
    const suffix = `${Date.now()}-c`;
    const topic = await pool.query(
      'INSERT INTO topic (name, subject_id) VALUES ($1, $2) RETURNING topic_id',
      [`Step12 Topic ${suffix}`, subjectId],
    );
    const tId = topic.rows[0].topic_id;
    const levels = ['REMEMBER', 'APPLY', 'APPLY', 'REMEMBER', 'APPLY', 'APPLY'];
    for (let i = 0; i < levels.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO question (topic_id, rubric_id, content, status, source, bloom_level,
                               reference_answer, key_points)
         VALUES ($1, $2, $3, 'APPROVED', 'MANUAL', $4, 'Reference answer.', '["Key point"]'::jsonb)`,
        [tId, rubricId, `Step12 Q${i} ${suffix}`, levels[i]],
      );
    }
    const exam = await pool.query(
      `INSERT INTO exam_session
         (subject_id, topic_id, title, language, main_question_count, max_follow_ups_per_question,
          answer_time_limit_sec, think_time_sec, status, session_time_limit_sec)
       VALUES ($1, $2, 'Step12 viva', 'EN', 3, 1, 120, 0, 'OPEN', 600)
       RETURNING exam_session_id`,
      [subjectId, tId],
    );
    const examId = exam.rows[0].exam_session_id;
    const students = [];
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const s = await pool.query(
        `INSERT INTO app_user (code, email, full_name, role, status)
         VALUES ($1, $2, 'Step12 Student', 'STUDENT', 'ACTIVE') RETURNING app_user_id`,
        [`S12-${suffix}-${i}`, `step12-${suffix}-${i}@aives.local`],
      );
      students.push(s.rows[0].app_user_id);
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        'INSERT INTO exam_session_student (exam_session_id, student_id) VALUES ($1, $2)',
        [examId, s.rows[0].app_user_id],
      );
    }

    const views = await Promise.all(students.map((id) => service.startOrResume({
      user: { id, role: 'STUDENT' }, examSessionId: examId,
    })));
    const picks = [];
    for (const v of views) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await pool.query(
        `SELECT q.question_id, q.bloom_level FROM assigned_question aq
         JOIN question q ON q.question_id = aq.question_id
         WHERE aq.interview_id = $1 ORDER BY aq.order_no`,
        [v.interviewId],
      );
      picks.push(rows.rows);
    }
    // 6 / 3 -> K = 1: the second candidate never repeats the first.
    const first = new Set(picks[0].map((r) => r.question_id));
    expect(picks[1].filter((r) => first.has(r.question_id))).toEqual([]);
    for (const p of picks) {
      expect(p.map((r) => r.bloom_level)).toEqual(['REMEMBER', 'APPLY', 'APPLY']);
    }

    const assignedQuestionRepository = new AssignedQuestionRepository(db);
    const recent = await assignedQuestionRepository.listRecentByExam(examId, 5);
    expect(recent).toHaveLength(2);
    recent.forEach((ids) => expect(ids).toHaveLength(3));
    const usage = await assignedQuestionRepository.countUsageByExam(examId);
    expect(usage.size).toBe(6);
    expect([...usage.values()].every((n) => n === 1)).toBe(true);
  });

  test('migration 016: session_time_limit_sec default + CHECK', async () => {
    const row = await pool.query(
      `INSERT INTO exam_session (subject_id, topic_id, language) VALUES ($1, $2, 'VI')
       RETURNING session_time_limit_sec`,
      [subjectId, topicId],
    );
    expect(row.rows[0].session_time_limit_sec).toBe(1800);
    await expect(pool.query(
      `INSERT INTO exam_session (subject_id, topic_id, language, session_time_limit_sec)
       VALUES ($1, $2, 'VI', 0)`,
      [subjectId, topicId],
    )).rejects.toThrow(/chk_exam_session_time_limit/);
  });

  test('migration 016: qa_turn status CHECK and unique (exam, student) interview', async () => {
    const iv = await pool.query(
      'SELECT viva_interview_id FROM viva_interview WHERE exam_session_id = $1', [examSessionId],
    );
    await expect(pool.query(
      `INSERT INTO qa_turn (interview_id, sequence_no, turn_type, status)
       VALUES ($1, 999, 'MAIN', 'BOGUS')`,
      [iv.rows[0].viva_interview_id],
    )).rejects.toThrow(/chk_qa_turn_status/);
    await expect(pool.query(
      `INSERT INTO viva_interview (exam_session_id, student_id, status)
       VALUES ($1, $2, 'IN_PROGRESS')`,
      [examSessionId, studentId],
    )).rejects.toThrow(/uq_viva_interview_exam_student/);
  });

  test('vivaInterviewRepository.listOverdueActive: queries active overdue interviews with deadline_at ordering and limit', async () => {
    const vivaInterviewRepository = new VivaInterviewRepository(db);

    const esRow = await pool.query(
      `INSERT INTO exam_session (subject_id, topic_id, language, status)
       VALUES ($1, $2, 'EN', 'OPEN') RETURNING exam_session_id`,
      [subjectId, topicId],
    );
    const testExamId = esRow.rows[0].exam_session_id;

    const sweepSuffix = `${Date.now()}-${testExamId}`;
    const uRows = await pool.query(
      `INSERT INTO app_user (email, full_name, role, status) VALUES
       ($1, 'Sweep 1', 'STUDENT', 'ACTIVE'),
       ($2, 'Sweep 2', 'STUDENT', 'ACTIVE'),
       ($3, 'Sweep 3', 'STUDENT', 'ACTIVE'),
       ($4, 'Sweep 4', 'STUDENT', 'ACTIVE')
       RETURNING app_user_id`,
      [1, 2, 3, 4].map((index) => `sweep_s${index}-${sweepSuffix}@aives.test`),
    );
    const [s1, s2, s3, s4] = uRows.rows.map((r) => r.app_user_id);

    const now = new Date();
    // Far in the past so these rows sort ahead of any leftover overdue rows in a
    // shared dev database (the query orders by deadline_at and applies LIMIT).
    const past1 = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
    const past2 = new Date(Date.UTC(2000, 0, 1, 0, 1, 0));
    const future = new Date(now.getTime() + 60000);

    await pool.query(
      `INSERT INTO viva_interview (exam_session_id, student_id, status, deadline_at)
       VALUES ($1, $2, 'IN_PROGRESS', $3)`,
      [testExamId, s1, past1],
    );

    await pool.query(
      `INSERT INTO viva_interview (exam_session_id, student_id, status, deadline_at)
       VALUES ($1, $2, 'PAUSED', $3)`,
      [testExamId, s2, past2],
    );

    await pool.query(
      `INSERT INTO viva_interview (exam_session_id, student_id, status, deadline_at)
       VALUES ($1, $2, 'COMPLETED', $3)`,
      [testExamId, s3, past1],
    );

    await pool.query(
      `INSERT INTO viva_interview (exam_session_id, student_id, status, deadline_at)
       VALUES ($1, $2, 'IN_PROGRESS', $3)`,
      [testExamId, s4, future],
    );

    try {
      const overdue = await vivaInterviewRepository.listOverdueActive({ before: now, limit: 10 });
      const forThisExam = overdue.filter((r) => r.exam_session_id === testExamId);
      expect(forThisExam).toHaveLength(2);
      expect(forThisExam[0].student_id).toBe(s1);
      expect(forThisExam[1].student_id).toBe(s2);

      const limited = await vivaInterviewRepository.listOverdueActive({ before: now, limit: 1 });
      expect(limited.length).toBeLessThanOrEqual(1);
    } finally {
      // Remove the year-2000 rows so repeated runs never accumulate them.
      await pool.query('DELETE FROM viva_interview WHERE exam_session_id = $1', [testExamId]);
      await pool.query('DELETE FROM exam_session WHERE exam_session_id = $1', [testExamId]);
      await pool.query('DELETE FROM app_user WHERE app_user_id = ANY($1::int[])', [[s1, s2, s3, s4]]);
    }
  });
});
