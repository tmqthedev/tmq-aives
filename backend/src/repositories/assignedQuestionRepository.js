// Persistence for assigned_question: the per-student, ordered main questions
// picked when an interview starts (order_no = 1..n).
class AssignedQuestionRepository {
  constructor(db) {
    this.db = db;
  }

  async createMany(interviewId, questionIds, client = this.db, snapshots = []) {
    if (snapshots.length !== questionIds.length || snapshots.some((snapshot, i) => !snapshot
      || snapshot.snapshot_version !== 1 || Number(snapshot.question_id) !== Number(questionIds[i]))) throw new Error('Every assignment requires a knowledge snapshot.');
    const rows = [];
    for (let i = 0; i < questionIds.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await client.query(
        `INSERT INTO assigned_question (interview_id, question_id, order_no, knowledge_snapshot)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING *`,
        [interviewId, questionIds[i], i + 1, JSON.stringify(snapshots[i])],
      );
      rows.push(result.rows[0]);
    }
    return rows;
  }

  async listByInterview(interviewId, client = this.db) {
    const result = await client.query(
      'SELECT * FROM assigned_question WHERE interview_id = $1 ORDER BY order_no',
      [interviewId],
    );
    return result.rows;
  }

  // Question ids of the `limit` most recently started interviews of an exam,
  // newest first: [[qid, ...] per interview]. Feeds the balanced picker's
  // no-overlap window; call on the transaction that holds the exam row lock.
  async listRecentByExam(examSessionId, limit, client = this.db) {
    const n = Math.max(0, Number(limit) || 0);
    if (n === 0) return [];
    const result = await client.query(
      `SELECT vi.viva_interview_id, aq.question_id
       FROM (
         SELECT viva_interview_id, started_at
         FROM viva_interview
         WHERE exam_session_id = $1 AND started_at IS NOT NULL
         ORDER BY started_at DESC, viva_interview_id DESC
         LIMIT $2
       ) vi
       JOIN assigned_question aq ON aq.interview_id = vi.viva_interview_id
       ORDER BY vi.started_at DESC, vi.viva_interview_id DESC, aq.order_no`,
      [examSessionId, n],
    );
    const groups = [];
    let lastId = null;
    for (const row of result.rows) {
      if (row.viva_interview_id !== lastId) {
        groups.push([]);
        lastId = row.viva_interview_id;
      }
      groups[groups.length - 1].push(Number(row.question_id));
    }
    return groups;
  }

  // question_id -> number of times it was assigned in this exam.
  async countUsageByExam(examSessionId, client = this.db) {
    const result = await client.query(
      `SELECT aq.question_id, COUNT(*)::int AS count
       FROM assigned_question aq
       JOIN viva_interview vi ON vi.viva_interview_id = aq.interview_id
       WHERE vi.exam_session_id = $1
       GROUP BY aq.question_id`,
      [examSessionId],
    );
    return new Map(result.rows.map((row) => [Number(row.question_id), Number(row.count)]));
  }

  async markAsked(id, client = this.db) {
    const result = await client.query(
      'UPDATE assigned_question SET is_asked = true WHERE assigned_question_id = $1 RETURNING *',
      [id],
    );
    return result.rows[0] || null;
  }
}

module.exports = { AssignedQuestionRepository };
