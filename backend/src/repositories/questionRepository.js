// Serialize a JS number[] into the pgvector text literal `[a,b,c]`. Null/empty
// arrays become NULL so the column is left unset.
function toVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return null;
  }
  return `[${embedding.map((n) => Number(n)).join(',')}]`;
}

// Parse a pgvector value back into a number[]. pg returns the column as a
// string like "[0.1,0.2]"; the in-memory mock stores the raw array.
function fromVectorValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  const text = String(value).trim();
  if (text === '' || text === '[]') return [];
  const inner = text.replace(/^\[/, '').replace(/\]$/, '');
  if (inner === '') return [];
  return inner.split(',').map((n) => Number(n));
}

// New question columns (beyond topic_id/rubric_id/content/status) that the
// Step-3 model writes on insert/update.
const NEW_COLUMNS = [
  ['bloomLevel', 'bloom_level'],
  ['language', 'language'],
  ['referenceAnswer', 'reference_answer'],
  ['keyPoints', 'key_points'],
  ['source', 'source'],
  ['rationale', 'rationale'],
  ['generationJobId', 'generation_job_id'],
  ['createdBy', 'created_by'],
  ['reviewedBy', 'reviewed_by'],
  ['reviewedAt', 'reviewed_at'],
  ['reviewNote', 'review_note'],
];

function serializeJson(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.stringify(value);
}

class QuestionRepository {
  constructor(database) {
    this.db = database;
  }

  async findByIdForUpdate(questionId, client) {
    const result = await client.query('SELECT * FROM question WHERE question_id = $1 FOR UPDATE', [questionId]);
    return result.rows[0] || null;
  }

  async findPendingRevision(questionId, client = this.db) {
    const result = await client.query(
      "SELECT * FROM question_revision WHERE question_id = $1 AND status = 'PENDING_REVIEW'",
      [questionId],
    );
    return result.rows[0] || null;
  }

  // Caller holds the question row lock: every save/publish takes this same lock
  // before reading the pending revision, including the first-draft race.
  async savePendingRevision(questionId, { baseVersion, content, actorId, revision }, client) {
    if (revision) {
      const result = await client.query(
        `UPDATE question_revision SET content = $1::jsonb, version = version + 1,
         updated_by = $2, updated_at = now()
         WHERE question_revision_id = $3 AND version = $4 AND status = 'PENDING_REVIEW' RETURNING *`,
        [JSON.stringify(content), actorId, revision.question_revision_id, revision.version],
      );
      return result.rows[0] || null;
    }
    const result = await client.query(
      `INSERT INTO question_revision (question_id, base_version, content, created_by, updated_by)
       VALUES ($1, $2, $3::jsonb, $4, $4) RETURNING *`,
      [questionId, baseVersion, JSON.stringify(content), actorId],
    );
    return result.rows[0];
  }

  async markRevisionPublished(revisionId, actorId, client) {
    const result = await client.query(
      `UPDATE question_revision SET status = 'PUBLISHED', reviewed_by = $2,
       published_at = now(), updated_at = now()
       WHERE question_revision_id = $1 AND status = 'PENDING_REVIEW' RETURNING *`,
      [revisionId, actorId],
    );
    return result.rows[0] || null;
  }

  async findAll() {
    const result = await this.db.query('SELECT * FROM question ORDER BY question_id ASC');
    return result.rows;
  }

  // Filter questions by status/bloom/source. We read with the single
  // `SELECT * ... ORDER BY question_id` shape (the only one the offline mock DB
  // understands) and apply the filters in the app layer, so the same code path
  // works against both Postgres and the in-memory mock without growing it.
  async findAllFiltered({ status, bloom, source, topicId } = {}) {
    const result = await this.db.query('SELECT * FROM question ORDER BY question_id ASC');
    let rows = result.rows;
    if (status !== undefined && status !== null && status !== '') {
      rows = rows.filter((row) => row.status === status);
    }
    if (bloom !== undefined && bloom !== null && bloom !== '') {
      rows = rows.filter((row) => row.bloom_level === bloom);
    }
    if (source !== undefined && source !== null && source !== '') {
      rows = rows.filter((row) => row.source === source);
    }
    if (topicId !== undefined && topicId !== null && topicId !== '') {
      const tid = Number(topicId);
      rows = rows.filter((row) => Number(row.topic_id) === tid);
    }
    return rows;
  }

  async findById(questionId) {
    const result = await this.db.query('SELECT * FROM question WHERE question_id = $1', [questionId]);
    return result.rows[0] || null;
  }

  async findByNormalizedContent(normalizedContent, excludeQuestionId = null) {
    const result = await this.db.query(
      `SELECT question_id FROM question
       WHERE LOWER(TRIM(content)) = $1
         AND ($2::int IS NULL OR question_id <> $2)
       LIMIT 1`,
      [normalizedContent, excludeQuestionId],
    );
    return result.rows[0] || null;
  }

  async create(payload, client = this.db) {
    const {
      topicId,
      rubricId,
      content,
      status,
      bloomLevel = null,
      language = null,
      referenceAnswer = null,
      keyPoints = null,
      source = null,
      rationale = null,
      generationJobId = null,
      embedding = null,
      createdBy = null,
      reviewedBy = null,
      reviewedAt = null,
      reviewNote = null,
    } = payload;

    const result = await client.query(
      `INSERT INTO question (
         topic_id, rubric_id, content, status,
         bloom_level, language, reference_answer, key_points,
         source, rationale, generation_job_id, embedding,
         created_by, reviewed_by, reviewed_at, review_note
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        topicId,
        rubricId ?? null,
        content,
        status,
        bloomLevel,
        language,
        referenceAnswer,
        serializeJson(keyPoints) ?? null,
        source,
        serializeJson(rationale) ?? null,
        generationJobId,
        toVectorLiteral(embedding),
        createdBy,
        reviewedBy,
        reviewedAt,
        reviewNote,
      ],
    );
    return result.rows[0];
  }

  async update(questionId, patch, client = this.db) {
    const fields = [];
    const values = [];

    if (patch.topicId !== undefined) {
      values.push(patch.topicId);
      fields.push(`topic_id = $${values.length}`);
    }
    if (patch.rubricId !== undefined) {
      values.push(patch.rubricId);
      fields.push(`rubric_id = $${values.length}`);
    }
    if (patch.content !== undefined) {
      values.push(patch.content);
      fields.push(`content = $${values.length}`);
    }
    if (patch.status !== undefined) {
      values.push(patch.status);
      fields.push(`status = $${values.length}`);
    }
    for (const [key, column] of NEW_COLUMNS) {
      if (patch[key] === undefined) continue;
      const raw = (key === 'keyPoints' || key === 'rationale')
        ? serializeJson(patch[key])
        : patch[key];
      values.push(raw ?? null);
      fields.push(`${column} = $${values.length}`);
    }
    if (patch.embedding !== undefined) {
      values.push(toVectorLiteral(patch.embedding));
      fields.push(`embedding = $${values.length}`);
    }

    if (fields.length === 0) {
      return this.findById(questionId);
    }

    values.push(questionId);
    const result = await client.query(
      `UPDATE question SET ${fields.join(', ')}
       WHERE question_id = $${values.length}
       RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  async updateStatusFields(questionId, {
    status, reviewedBy, reviewedAt, reviewNote, rubricId,
  } = {}, client = this.db) {
    const patch = {};
    if (status !== undefined) patch.status = status;
    if (reviewedBy !== undefined) patch.reviewedBy = reviewedBy;
    if (reviewedAt !== undefined) patch.reviewedAt = reviewedAt;
    if (reviewNote !== undefined) patch.reviewNote = reviewNote;
    if (rubricId !== undefined) patch.rubricId = rubricId;
    return this.update(questionId, patch, client);
  }

  // Remove what an earlier (failed or interrupted) run of this generation job
  // left behind but nobody has reviewed yet, so a retry starts clean instead of
  // piling up near-duplicates. question_source_ref rows cascade.
  async deleteUnreviewedByGenerationJob(generationJobId, client = this.db) {
    const result = await client.query(
      `DELETE FROM question
        WHERE generation_job_id = $1 AND source = 'AI' AND status = 'PENDING_REVIEW'`,
      [generationJobId],
    );
    return result.rowCount;
  }

  async deleteById(questionId) {
    const result = await this.db.query(
      'DELETE FROM question WHERE question_id = $1 RETURNING *',
      [questionId],
    );
    return result.rows[0] || null;
  }

  // Return { question_id, embedding } rows for every question in the subject of
  // `topicId` (via topic.subject_id). Used by the near-duplicate scan on CREATE,
  // where the new question has no id yet so we scope by its topic's subject.
  async findSubjectEmbeddingsByTopic(topicId) {
    const result = await this.db.query(
      `SELECT q.question_id, q.embedding
         FROM question q
         JOIN topic t ON t.topic_id = q.topic_id
        WHERE q.embedding IS NOT NULL
          AND t.subject_id = (SELECT subject_id FROM topic WHERE topic_id = $1)`,
      [topicId],
    );
    return result.rows.map((row) => ({
      question_id: row.question_id,
      embedding: fromVectorValue(row.embedding),
    }));
  }

  // Return { question_id, embedding } rows for every question in the same
  // subject as `questionId` (joined via topic.subject_id), excluding
  // `excludeId`. Used by the near-duplicate embedding scan.
  async findSameSubjectEmbeddings(questionId, excludeId = null) {
    const result = await this.db.query(
      `SELECT q.question_id, q.embedding
         FROM question q
         JOIN topic t ON t.topic_id = q.topic_id
        WHERE q.embedding IS NOT NULL
          AND t.subject_id = (
            SELECT t2.subject_id FROM topic t2
             JOIN question q2 ON q2.topic_id = t2.topic_id
            WHERE q2.question_id = $1
          )
          AND ($2::int IS NULL OR q.question_id <> $2)`,
      [questionId, excludeId],
    );
    return result.rows.map((row) => ({
      question_id: row.question_id,
      embedding: fromVectorValue(row.embedding),
    }));
  }
}

module.exports = {
  QuestionRepository,
  toVectorLiteral,
  fromVectorValue,
};
