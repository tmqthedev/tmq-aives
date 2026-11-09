// Persistence for qa_turn. Methods used inside the engine's transactions take
// an optional trailing `client` (defaults to this.db).
class QaTurnRepository {
  constructor(db) {
    this.db = db;
  }

  async create({
    interviewId,
    assignedQuestionId,
    sequenceNo,
    turnType,
    followUpReason,
    questionText,
    rationale,
    status,
    questionAudioKey,
    askedAt,
  }, client = this.db) {
    const result = await client.query(
      `INSERT INTO qa_turn
         (interview_id, assigned_question_id, sequence_no, turn_type, follow_up_reason,
          question_text, rationale, status, question_audio_key, asked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        interviewId,
        assignedQuestionId ?? null,
        sequenceNo ?? null,
        turnType ?? null,
        followUpReason ?? null,
        questionText ?? null,
        rationale == null ? null : JSON.stringify(rationale),
        status ?? null,
        questionAudioKey ?? null,
        askedAt ?? null,
      ],
    );
    return result.rows[0];
  }

  async findById(id, client = this.db) {
    const result = await client.query('SELECT * FROM qa_turn WHERE qa_turn_id = $1', [id]);
    return result.rows[0] || null;
  }

  async listByInterview(interviewId, client = this.db) {
    const result = await client.query(
      'SELECT * FROM qa_turn WHERE interview_id = $1 ORDER BY sequence_no',
      [interviewId],
    );
    return result.rows;
  }

  async findLatestByInterview(interviewId, client = this.db) {
    const result = await client.query(
      'SELECT * FROM qa_turn WHERE interview_id = $1 ORDER BY sequence_no DESC LIMIT 1',
      [interviewId],
    );
    return result.rows[0] || null;
  }

  _buildSets(patch, startIdx) {
    const sets = [];
    const values = [];
    let idx = startIdx;
    for (const [key, val] of Object.entries(patch || {})) {
      if (!QaTurnRepository.UPDATABLE_COLUMNS.includes(key) || val === undefined) continue;
      sets.push(`${key} = $${idx++}`);
      values.push(val);
    }
    return { sets, values, idx };
  }

  async update(id, patch, client = this.db) {
    const { sets, values, idx } = this._buildSets(patch, 1);
    if (sets.length === 0) return this.findById(id, client);
    values.push(id);
    const result = await client.query(
      `UPDATE qa_turn SET ${sets.join(', ')} WHERE qa_turn_id = $${idx} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  // Conditional status claim: moves the turn to `toStatus` (plus allowlisted
  // patch columns) only while its status is one of `fromStatuses`. Returns null
  // when the claim lost (e.g. a double submit), so callers can reject cleanly.
  async transitionStatus(id, fromStatuses, toStatus, patch = {}, client = this.db) {
    const { sets, values, idx } = this._buildSets(
      Object.fromEntries(Object.entries(patch || {}).filter(([k]) => k !== 'status')),
      2,
    );
    const params = [toStatus, ...values, id, fromStatuses];
    const result = await client.query(
      `UPDATE qa_turn SET ${['status = $1', ...sets].join(', ')}
        WHERE qa_turn_id = $${idx} AND status = ANY($${idx + 1})
        RETURNING *`,
      params,
    );
    return result.rows[0] || null;
  }

  async markOpenTurnsUnanswered(interviewId, client = this.db) {
    const result = await client.query(
      `UPDATE qa_turn SET status = 'UNANSWERED'
        WHERE interview_id = $1 AND status IN ('ASKED', 'ANSWERING')
        RETURNING *`,
      [interviewId],
    );
    return result.rows;
  }
}

QaTurnRepository.UPDATABLE_COLUMNS = [
  'answer_text',
  'answer_audio_key',
  'transcript_confidence',
  'asked_at',
  'answer_started_at',
  'answer_ended_at',
  'timed_out',
  'status',
  'response_latency_ms',
  'speech_duration_ms',
  'words_per_minute',
  'pause_count',
  'question_audio_key',
  'played_at',
  'answer_deadline_at',
  'processing_started_at',
  'retry_count',
  'stt_disputed_at',
  'stt_dispute_note',
];

module.exports = { QaTurnRepository };
