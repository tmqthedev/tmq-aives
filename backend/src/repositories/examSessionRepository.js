// Keep this predicate aligned with migration 030. Approval status alone is not
// sufficient: legacy rows or later edits may lack grading knowledge.
function eligibleApprovedQuestion(alias = '') {
  const q = alias ? `${alias}.` : '';
  return `${q}status = 'APPROVED'
    AND ${q}rubric_id IS NOT NULL
    AND COALESCE(${q}reference_answer, '') ~ '[^[:space:]]'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${q}key_points) = 'array' THEN ${q}key_points ELSE '[]'::jsonb END
      ) AS kp(value)
      WHERE jsonb_typeof(kp.value) = 'string'
        AND (kp.value #>> '{}') ~ '[^[:space:]]'
    )`;
}

class ExamSessionRepository {
  constructor(db) {
    this.db = db;
  }

  async create({
    subjectId,
    topicId,
    title,
    language,
    mainQuestionCount,
    maxFollowUpsPerQuestion,
    answerTimeLimitSec,
    thinkTimeSec,
    opensAt,
    closesAt,
    status,
    createdBy,
    sessionTimeLimitSec,
    maxFollowUpsTotal,
    bloomDistribution,
  }) {
    // session_time_limit_sec (migration 016) falls back to the column default
    // (1800 s) when the caller omits it. max_follow_ups_total and
    // bloom_distribution (migration 018) are NULL = no cap / bank proportions.
    const result = await this.db.query(
      `INSERT INTO exam_session
         (subject_id, topic_id, title, language, main_question_count, max_follow_ups_per_question,
          answer_time_limit_sec, think_time_sec, opens_at, closes_at, status, created_by,
          session_time_limit_sec, max_follow_ups_total, bloom_distribution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'DRAFT'), $12,
               COALESCE($13, 1800), $14, $15::jsonb)
       RETURNING *`,
      [
        subjectId ?? null,
        topicId ?? null,
        title ?? null,
        language ?? null,
        mainQuestionCount ?? null,
        maxFollowUpsPerQuestion ?? null,
        answerTimeLimitSec ?? null,
        thinkTimeSec ?? null,
        opensAt ?? null,
        closesAt ?? null,
        status ?? null,
        createdBy ?? null,
        sessionTimeLimitSec ?? null,
        maxFollowUpsTotal ?? null,
        bloomDistribution == null ? null : JSON.stringify(bloomDistribution),
      ],
    );
    return result.rows[0];
  }

  // Roster membership check used by the interview engine before a student
  // may start an interview.
  async isStudentOnRoster(examSessionId, studentId) {
    const result = await this.db.query(
      'SELECT 1 FROM exam_session_student WHERE exam_session_id = $1 AND student_id = $2',
      [examSessionId, studentId],
    );
    return result.rows.length > 0;
  }

  async findById(id) {
    const result = await this.db.query('SELECT * FROM exam_session WHERE exam_session_id = $1', [id]);
    return result.rows[0] || null;
  }

  // Per-subject question-bank progress for the lecturer dashboard, one row per
  // ACTIVE subject the lecturer is assigned to.
  async getLecturerProgress(lecturerId) {
    const result = await this.db.query(
      `SELECT s.subject_id, s.code, s.name,
         (SELECT COUNT(*)::int FROM topic t WHERE t.subject_id = s.subject_id) AS topics,
         (SELECT COUNT(*)::int FROM course_material m
           WHERE m.subject_id = s.subject_id AND m.status = 'READY') AS ready_materials,
         (SELECT COUNT(*)::int FROM rubric r WHERE r.subject_id = s.subject_id) AS rubrics,
         (SELECT COUNT(*)::int FROM question q JOIN topic t ON t.topic_id = q.topic_id
           WHERE t.subject_id = s.subject_id AND ${eligibleApprovedQuestion('q')}) AS approved_questions,
         (SELECT COUNT(*)::int FROM question q JOIN topic t ON t.topic_id = q.topic_id
           WHERE t.subject_id = s.subject_id AND q.status IN ('DRAFT', 'PENDING_REVIEW')) AS pending_questions,
         (SELECT COUNT(*)::int FROM exam_session e
           WHERE e.subject_id = s.subject_id AND e.status IN ('SCHEDULED', 'OPEN', 'CLOSED')) AS scheduled_exams,
         (SELECT COUNT(*)::int FROM viva_result vr
           JOIN viva_interview vi ON vi.viva_interview_id = vr.interview_id
           JOIN exam_session e ON e.exam_session_id = vi.exam_session_id
           WHERE e.subject_id = s.subject_id AND vr.status IN ('AI_SUGGESTED', 'FLAGGED')) AS results_to_review
       FROM subject_lecturer sl
       JOIN subject s ON s.subject_id = sl.subject_id
       WHERE sl.lecturer_id = $1 AND s.status = 'ACTIVE'
       ORDER BY s.code`,
      [lecturerId],
    );
    return result.rows;
  }

  async countInterviews(id) {
    const result = await this.db.query(
      'SELECT COUNT(*)::int AS count FROM viva_interview WHERE exam_session_id = $1',
      [id],
    );
    return result.rows[0] ? Number(result.rows[0].count) : 0;
  }

  // Roster, examiners and interviews cascade; callers only delete unused
  // DRAFT/SCHEDULED sessions.
  async remove(id) {
    const result = await this.db.query(
      'DELETE FROM exam_session WHERE exam_session_id = $1 RETURNING *',
      [id],
    );
    return result.rows[0] || null;
  }

  // Counts only: students IN_PROGRESS / COMPLETED per exam. No student data.
  async countInterviewsByExam(examSessionIds = null) {
    const params = [];
    let where = '';
    if (Array.isArray(examSessionIds)) {
      if (examSessionIds.length === 0) return [];
      params.push(examSessionIds);
      where = 'WHERE exam_session_id = ANY($1::bigint[])';
    }
    const result = await this.db.query(
      `SELECT exam_session_id,
              COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
              COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed
       FROM viva_interview ${where}
       GROUP BY exam_session_id`,
      params,
    );
    return result.rows;
  }

  async list() {
    const result = await this.db.query('SELECT * FROM exam_session ORDER BY exam_session_id');
    return result.rows;
  }

  // Row lock on the exam (SELECT ... FOR UPDATE) so concurrent interview starts
  // of the same exam serialize their question picking. Must run on a
  // transaction client to hold the lock until commit.
  async lockForUpdate(id, client = this.db) {
    const result = await client.query(
      'SELECT * FROM exam_session WHERE exam_session_id = $1 FOR UPDATE',
      [id],
    );
    return result.rows[0] || null;
  }

  // Patch an allowlisted set of config/schedule columns on a DRAFT session.
  async update(id, patch, client = this.db) {
    const { sets, values } = ExamSessionRepository._buildSets(patch, ExamSessionRepository.UPDATABLE_COLUMNS);
    if (sets.length === 0) return this.findById(id);
    values.push(id);
    const result = await client.query(
      `UPDATE exam_session SET ${sets.join(', ')} WHERE exam_session_id = $${values.length} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  // Conditional status move: only flips when the row is still in one of
  // `fromStatuses` (a concurrent transition makes this return null). `patch`
  // may also set the lifecycle audit columns (scheduled_*, started_*).
  async transitionStatus(id, fromStatuses, toStatus, patch = {}, client = this.db) {
    const { sets, values } = ExamSessionRepository._buildSets(
      patch,
      ExamSessionRepository.TRANSITION_COLUMNS,
      1,
    );
    const idIdx = values.length + 2;
    const result = await client.query(
      `UPDATE exam_session SET status = $1${sets.length ? `, ${sets.join(', ')}` : ''}
       WHERE exam_session_id = $${idIdx} AND status = ANY($${idIdx + 1})
       RETURNING *`,
      [toStatus, ...values, id, fromStatuses],
    );
    return result.rows[0] || null;
  }

  // Shallow JSONB merge into warm_status: top-level keys (stt, tts, audio,
  // keepWarm) are replaced, others are kept, so concurrent writers that own
  // different keys do not clobber each other.
  async mergeWarmStatus(id, partial, client = this.db) {
    const result = await client.query(
      `UPDATE exam_session
       SET warm_status = COALESCE(warm_status, '{}'::jsonb) || $2::jsonb
       WHERE exam_session_id = $1
       RETURNING *`,
      [id, JSON.stringify(partial || {})],
    );
    return result.rows[0] || null;
  }

  // Admin exam schedule: sessions with subject, creator and progress counts.
  // Filters are optional; `statuses` is an array, `from`/`to` bound opens_at.
  async listSchedule({
    statuses, subjectId, from, to,
  } = {}) {
    const where = [];
    const values = [];
    if (Array.isArray(statuses) && statuses.length > 0) {
      values.push(statuses);
      where.push(`es.status = ANY($${values.length})`);
    }
    if (subjectId != null) {
      values.push(subjectId);
      where.push(`es.subject_id = $${values.length}`);
    }
    if (from != null) {
      values.push(from);
      where.push(`es.opens_at >= $${values.length}`);
    }
    if (to != null) {
      values.push(to);
      where.push(`es.opens_at < $${values.length}`);
    }
    const result = await this.db.query(
      `SELECT es.*,
              s.code AS subject_code, s.name AS subject_name,
              t.name AS topic_name,
              u.full_name AS creator_name, u.email AS creator_email,
              (SELECT COUNT(*)::int FROM exam_session_student ess
                WHERE ess.exam_session_id = es.exam_session_id) AS student_count,
              (SELECT COUNT(*)::int FROM viva_interview vi
                WHERE vi.exam_session_id = es.exam_session_id AND vi.started_at IS NOT NULL)
                AS interviews_started,
              (SELECT COUNT(*)::int FROM viva_interview vi
                WHERE vi.exam_session_id = es.exam_session_id AND vi.status = 'COMPLETED')
                AS interviews_completed
       FROM exam_session es
       LEFT JOIN subject s ON es.subject_id = s.subject_id
       LEFT JOIN topic t ON es.topic_id = t.topic_id
       LEFT JOIN app_user u ON es.created_by = u.app_user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY es.opens_at ASC NULLS LAST, es.exam_session_id`,
      values,
    );
    return result.rows;
  }

  async listByCreator(createdBy) {
    const result = await this.db.query(
      'SELECT * FROM exam_session WHERE created_by = $1 ORDER BY exam_session_id',
      [createdBy],
    );
    return result.rows;
  }

  async listBySubjectIds(ids) {
    const subjectIds = Array.from(new Set((ids || []).filter((id) => id != null)));
    if (subjectIds.length === 0) return [];
    const result = await this.db.query(
      'SELECT * FROM exam_session WHERE subject_id = ANY($1) ORDER BY exam_session_id',
      [subjectIds],
    );
    return result.rows;
  }

  async findByIdWithParticipants(id) {
    const session = await this.findById(id);
    if (!session) return null;
    const students = await this.db.query(
      `SELECT ess.*, u.code, u.full_name
       FROM exam_session_student ess
       JOIN app_user u ON u.app_user_id = ess.student_id
       WHERE ess.exam_session_id = $1
       ORDER BY ess.exam_session_student_id`,
      [id],
    );
    const examiners = await this.db.query(
      `SELECT ese.*, u.code, u.full_name
       FROM exam_session_examiner ese
       JOIN app_user u ON u.app_user_id = ese.lecturer_id
       WHERE ese.exam_session_id = $1
       ORDER BY ese.exam_session_examiner_id`,
      [id],
    );
    return { ...session, students: students.rows, examiners: examiners.rows };
  }

  // Replace the full student roster for a session in a single transaction:
  // clear existing rows then insert the given ids. Mirrors
  // subjectRepository.setLecturers.
  async setStudents(examSessionId, studentIds) {
    const ids = Array.from(new Set((studentIds || []).filter((id) => id != null)));
    return this.db.withTransaction(async (tx) => {
      await tx.query('DELETE FROM exam_session_student WHERE exam_session_id = $1', [examSessionId]);
      for (const studentId of ids) {
        await tx.query(
          'INSERT INTO exam_session_student (exam_session_id, student_id) VALUES ($1, $2)',
          [examSessionId, studentId],
        );
      }
      const result = await tx.query(
        `SELECT student_id FROM exam_session_student
         WHERE exam_session_id = $1
         ORDER BY student_id`,
        [examSessionId],
      );
      return result.rows.map((row) => row.student_id);
    });
  }

  // Replace the full examiner set for a session in a single transaction.
  async setExaminers(examSessionId, lecturerIds) {
    const ids = Array.from(new Set((lecturerIds || []).filter((id) => id != null)));
    return this.db.withTransaction(async (tx) => {
      await tx.query('DELETE FROM exam_session_examiner WHERE exam_session_id = $1', [examSessionId]);
      for (const lecturerId of ids) {
        await tx.query(
          'INSERT INTO exam_session_examiner (exam_session_id, lecturer_id) VALUES ($1, $2)',
          [examSessionId, lecturerId],
        );
      }
      const result = await tx.query(
        `SELECT lecturer_id FROM exam_session_examiner
         WHERE exam_session_id = $1
         ORDER BY lecturer_id`,
        [examSessionId],
      );
      return result.rows.map((row) => row.lecturer_id);
    });
  }

  async countApprovedByTopicsAndBloom(topicIds) {
    if (!topicIds || topicIds.length === 0) return [];
    const result = await this.db.query(
      `SELECT topic_id, bloom_level, COUNT(*)::int AS count
       FROM question
       WHERE topic_id = ANY($1::int[]) AND ${eligibleApprovedQuestion()}
       GROUP BY topic_id, bloom_level`,
      [topicIds],
    );
    return result.rows;
  }

  async countApprovedByTopicsAndLanguage(topicIds) {
    if (!topicIds || topicIds.length === 0) return [];
    const result = await this.db.query(
      `SELECT topic_id, language, COUNT(*)::int AS count
       FROM question
       WHERE topic_id = ANY($1::int[]) AND ${eligibleApprovedQuestion()}
       GROUP BY topic_id, language`,
      [topicIds],
    );
    return result.rows;
  }

  async countApprovedQuestionsInTopic(topicId) {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS count FROM question WHERE topic_id = $1 AND ${eligibleApprovedQuestion()}`,
      [topicId],
    );
    return result.rows[0] ? Number(result.rows[0].count) : 0;
  }

  // APPROVED bank of a topic with what the balanced picker, the rubric lock
  // and the audio pre-generation need.
  async listApprovedQuestionsInTopic(topicId, client = this.db) {
    const result = await client.query(
      `SELECT question_id, bloom_level, rubric_id, content, language
       FROM question
       WHERE topic_id = $1 AND ${eligibleApprovedQuestion()}
       ORDER BY question_id`,
      [topicId],
    );
    return result.rows;
  }

  async listApprovedQuestionIdsInTopic(topicId) {
    const result = await this.db.query(
      `SELECT question_id FROM question WHERE topic_id = $1 AND ${eligibleApprovedQuestion()} ORDER BY question_id`,
      [topicId],
    );
    return result.rows.map((row) => row.question_id);
  }

  async addStudent(examSessionId, studentId) {
    const result = await this.db.query(
      `INSERT INTO exam_session_student (exam_session_id, student_id)
       VALUES ($1, $2)
       RETURNING *`,
      [examSessionId, studentId],
    );
    return result.rows[0];
  }

  async addExaminer(examSessionId, lecturerId) {
    const result = await this.db.query(
      `INSERT INTO exam_session_examiner (exam_session_id, lecturer_id)
       VALUES ($1, $2)
       RETURNING *`,
      [examSessionId, lecturerId],
    );
    return result.rows[0];
  }

  async setStatus(id, status) {
    const result = await this.db.query(
      'UPDATE exam_session SET status = $1 WHERE exam_session_id = $2 RETURNING *',
      [status, id],
    );
    return result.rows[0] || null;
  }

  async listByStudent(studentId) {
    const result = await this.db.query(
      `SELECT es.*, s.name AS subject_name, s.code AS subject_code,
              t.name AS topic_name,
              vi.viva_interview_id, vi.status AS interview_status,
              vi.started_at AS interview_started_at, vi.deadline_at AS interview_deadline_at
       FROM exam_session es
       JOIN exam_session_student ess ON es.exam_session_id = ess.exam_session_id
       LEFT JOIN subject s ON es.subject_id = s.subject_id
       LEFT JOIN topic t ON es.topic_id = t.topic_id
       LEFT JOIN viva_interview vi ON es.exam_session_id = vi.exam_session_id AND vi.student_id = $1
       WHERE ess.student_id = $1
       ORDER BY es.exam_session_id DESC`,
      [studentId],
    );
    return result.rows;
  }
}

ExamSessionRepository.UPDATABLE_COLUMNS = [
  'title',
  'language',
  'main_question_count',
  'max_follow_ups_per_question',
  'answer_time_limit_sec',
  'think_time_sec',
  'opens_at',
  'closes_at',
  'session_time_limit_sec',
  'max_follow_ups_total',
  'bloom_distribution',
];

// Columns a status transition may also write (lifecycle audit + window close).
ExamSessionRepository.TRANSITION_COLUMNS = [
  'scheduled_at',
  'scheduled_by',
  'started_at',
  'started_by',
  'closes_at',
];

ExamSessionRepository.JSONB_COLUMNS = ['bloom_distribution', 'warm_status'];

// Build "col = $n" fragments for the allowlisted, defined keys of `patch`.
// JSONB values are serialized explicitly (pg would turn arrays into PG arrays).
ExamSessionRepository._buildSets = (patch, allowed, offset = 0) => {
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(patch || {})) {
    if (!allowed.includes(key) || val === undefined) continue;
    const isJson = ExamSessionRepository.JSONB_COLUMNS.includes(key);
    values.push(isJson && val !== null ? JSON.stringify(val) : val);
    sets.push(`${key} = $${values.length + offset}${isJson ? '::jsonb' : ''}`);
  }
  return { sets, values };
};

module.exports = { ExamSessionRepository };
