/**
 * Step 14 admin repositories against real Postgres (migrations 025-027):
 * user list filters and soft delete, open-exam involvement, admin audit log,
 * subject dependents / code lookup / archive. Everything runs inside one
 * transaction that is rolled back. Self-skips without TEST_DATABASE_URL.
 */
const path = require('path');
const { Pool } = require('pg');

const { runMigrations } = require('../src/db/migrationRunner');
const { AppUserRepository } = require('../src/repositories/appUserRepository');
const { AuditLogRepository } = require('../src/repositories/auditLogRepository');
const { SubjectRepository } = require('../src/repositories/subjectRepository');
const { ExamSessionRepository } = require('../src/repositories/examSessionRepository');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');
const describeDb = DB_URL ? describe : describe.skip;

describeDb('admin repositories (requires Postgres)', () => {
  let pool;
  let client;
  let users;
  let audit;
  let subjects;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await runMigrations({ pool, dir: MIGRATIONS_DIR, logger: { info() {} } });
    client = await pool.connect();
    await client.query('BEGIN');
    const db = { query: (text, params) => client.query(text, params) };
    users = new AppUserRepository(db);
    audit = new AuditLogRepository(db);
    subjects = new SubjectRepository(db);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  const suffix = `${Date.now()}`;

  test('list filters by role and hides soft-deleted users', async () => {
    const u = await users.create({
      code: `ADMREPO${suffix}`, email: `admrepo${suffix}@aives.test`, fullName: 'x', passwordHash: null, role: 'STUDENT', status: 'ACTIVE',
    });
    const students = await users.list({ role: 'STUDENT' });
    expect(students.some((r) => r.app_user_id === u.app_user_id)).toBe(true);
    expect(students.every((r) => r.role === 'STUDENT')).toBe(true);

    await users.update(u.app_user_id, { status: 'DELETED' });
    expect((await users.list({ role: 'STUDENT' })).some((r) => r.app_user_id === u.app_user_id)).toBe(false);
    expect((await users.list({ includeDeleted: true })).some((r) => r.app_user_id === u.app_user_id)).toBe(true);
    expect(await users.listOpenExamInvolvement(u.app_user_id)).toEqual([]);
    await users.clearSubjectAssignments(u.app_user_id);
    expect(await users.countActiveAdmins()).toBeGreaterThanOrEqual(0);
  });

  test('audit log records ids and lists newest first with filters', async () => {
    await audit.record({ actorId: null, action: 'SUBJECT_CREATE', entityType: 'SUBJECT', entityId: 999001 });
    await audit.record({ actorId: null, action: 'SUBJECT_ARCHIVE', entityType: 'SUBJECT', entityId: 999001 });
    const { entries, total } = await audit.list({ entityType: 'SUBJECT', entityId: 999001, limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(entries.map((e) => e.action)).toEqual(['SUBJECT_ARCHIVE', 'SUBJECT_CREATE']);
  });

  test('subject dependents, case-insensitive code lookup and archive', async () => {
    const s = await subjects.create({ code: `SQL${suffix}`, name: 'Repo test' });
    expect(s.status).toBe('ACTIVE');
    expect(await subjects.countDependents(s.subject_id)).toEqual({
      topics: 0, materials: 0, rubrics: 0, examSessions: 0,
    });
    await client.query('INSERT INTO topic (name, subject_id) VALUES ($1, $2)', [`T ${suffix}`, s.subject_id]);
    expect((await subjects.countDependents(s.subject_id)).topics).toBe(1);
    expect((await subjects.findByCode(`  sql${suffix} `)).subject_id).toBe(s.subject_id);
    expect((await subjects.setStatus(s.subject_id, 'ARCHIVED')).status).toBe('ARCHIVED');
    // Savepoint so the expected constraint error does not abort the shared
    // transaction used by the following tests.
    await client.query('SAVEPOINT bad_status');
    await expect(client.query("UPDATE subject SET status = 'GONE' WHERE subject_id = $1", [s.subject_id]))
      .rejects.toThrow(/chk_subject_status/);
    await client.query('ROLLBACK TO SAVEPOINT bad_status');
  });

  test('search filters by role/status/q/subject and pages; assignments and subject counts', async () => {
    const sub = await subjects.create({ code: `SRCH${suffix}`, name: 'Search subject' });
    const lec = await users.create({
      code: `LSRCH${suffix}`, email: `lsrch${suffix}@aives.test`, fullName: 'Nguyen Search', passwordHash: null, role: 'LECTURER', status: 'ACTIVE',
    });
    await client.query('INSERT INTO subject_lecturer (subject_id, lecturer_id) VALUES ($1, $2)', [sub.subject_id, lec.app_user_id]);

    const byQ = await users.search({ role: 'LECTURER', q: `lsrch${suffix}`, limit: 10, offset: 0 });
    expect(byQ.total).toBe(1);
    expect(byQ.users[0].app_user_id).toBe(lec.app_user_id);
    const byName = await users.search({ q: 'nguyen search', limit: 10, offset: 0 });
    expect(byName.users.some((u) => u.app_user_id === lec.app_user_id)).toBe(true);
    const bySubject = await users.search({ subjectId: sub.subject_id, limit: 10, offset: 0 });
    expect(bySubject.users.map((u) => u.app_user_id)).toEqual([lec.app_user_id]);
    const page2 = await users.search({ subjectId: sub.subject_id, limit: 10, offset: 10 });
    expect(page2.users).toEqual([]);
    expect(page2.total).toBe(1);

    const a = await users.listAssignments(lec.app_user_id);
    expect(a.subjectsTaught.map((x) => x.subject_id)).toEqual([sub.subject_id]);
    expect(a.subjectsEnrolled).toEqual([]);

    const listed = (await subjects.listWithCounts()).find((x) => x.subject_id === sub.subject_id);
    expect(listed.lecturer_count).toBe(1);
    expect(listed.student_count).toBe(0);
  });

  test('lecturer progress counts per ACTIVE assigned subject; delete helpers', async () => {
    const db = { query: (text, params) => client.query(text, params) };
    const exams = new ExamSessionRepository(db);
    const sub = await subjects.create({ code: `PROG${suffix}`, name: 'Progress' });
    const lec = await users.create({
      code: `LPROG${suffix}`, email: `lprog${suffix}@aives.test`, fullName: 'x', passwordHash: null, role: 'LECTURER', status: 'ACTIVE',
    });
    await client.query('INSERT INTO subject_lecturer (subject_id, lecturer_id) VALUES ($1, $2)', [sub.subject_id, lec.app_user_id]);
    const topic = await client.query('INSERT INTO topic (name, subject_id) VALUES ($1, $2) RETURNING topic_id', [`PT ${suffix}`, sub.subject_id]);
    // An approved question only counts when it is complete (rubric, reference answer, key points).
    const rubric = await client.query(
      'INSERT INTO rubric (max_score, subject_id) VALUES (10, $1) RETURNING rubric_id',
      [sub.subject_id],
    );
    await client.query(
      `INSERT INTO question (topic_id, rubric_id, content, status, source, language, reference_answer, key_points)
       VALUES ($1, $3, $2, 'APPROVED', 'MANUAL', 'en', 'Reference answer.', '["Key point"]'::jsonb)`,
      [topic.rows[0].topic_id, `Approved ${suffix}`, rubric.rows[0].rubric_id],
    );
    await client.query(
      "INSERT INTO question (topic_id, content, status, source, language) VALUES ($1, $2, 'PENDING_REVIEW', 'AI', 'en')",
      [topic.rows[0].topic_id, `Pending ${suffix}`],
    );
    // An approved but incomplete (legacy) question must not be counted.
    await client.query(
      "INSERT INTO question (topic_id, content, status, source, language) VALUES ($1, $2, 'APPROVED', 'MANUAL', 'en')",
      [topic.rows[0].topic_id, `Incomplete ${suffix}`],
    );
    const rows = await exams.getLecturerProgress(lec.app_user_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_id: sub.subject_id, topics: 1, ready_materials: 0, rubrics: 1,
      approved_questions: 1, pending_questions: 1, scheduled_exams: 0, results_to_review: 0,
    });
    await subjects.setStatus(sub.subject_id, 'ARCHIVED');
    expect(await exams.getLecturerProgress(lec.app_user_id)).toEqual([]);

    const es = await client.query(
      "INSERT INTO exam_session (subject_id, topic_id, language, status) VALUES ($1, $2, 'EN', 'DRAFT') RETURNING exam_session_id",
      [sub.subject_id, topic.rows[0].topic_id],
    );
    expect(await exams.countInterviews(es.rows[0].exam_session_id)).toBe(0);
    expect((await exams.remove(es.rows[0].exam_session_id)).exam_session_id).toBe(es.rows[0].exam_session_id);
  });
});
