class RubricRepository {
  constructor(database) {
    this.db = database;
  }

  async findAll() {
    const rubrics = await this.db.query('SELECT * FROM rubric ORDER BY rubric_id ASC');
    const criteria = await this.db.query(
      'SELECT * FROM rubric_criterion ORDER BY rubric_id ASC, order_index ASC, rubric_criterion_id ASC',
    );
    const levels = await this._loadLevelsForCriteria(criteria.rows);
    return this._attachCriteria(rubrics.rows, criteria.rows, levels);
  }

  async findById(rubricId, client = this.db) {
    const rubric = await client.query('SELECT * FROM rubric WHERE rubric_id = $1', [rubricId]);
    if (!rubric.rows[0]) {
      return null;
    }
    const criteria = await client.query(
      'SELECT * FROM rubric_criterion WHERE rubric_id = $1 ORDER BY order_index ASC, rubric_criterion_id ASC',
      [rubricId],
    );
    const levels = await this._loadLevelsForCriteria(criteria.rows, client);
    return {
      ...rubric.rows[0],
      criteria: this._withLevels(criteria.rows, levels),
    };
  }

  // Resolve a rubric by a textual code. The rubric table has no dedicated code
  // column, so the numeric rubric_id doubles as the code for imports. Non-numeric
  // codes resolve to nothing. FEAT-002 may introduce a real code column.
  async findByCode(code) {
    const numeric = Number(code);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      return null;
    }
    const result = await this.db.query('SELECT * FROM rubric WHERE rubric_id = $1', [numeric]);
    return result.rows[0] || null;
  }

  async countQuestionsUsingRubric(rubricId) {
    const result = await this.db.query(
      'SELECT COUNT(*)::int AS count FROM question WHERE rubric_id = $1',
      [rubricId],
    );
    return result.rows[0]?.count || 0;
  }

  async create({
    maxScore, criteria, subjectId, createdBy, name,
  }) {
    return this.db.withTransaction(async (tx) => {
      const rubricResult = await tx.query(
        'INSERT INTO rubric (max_score) VALUES ($1) RETURNING *',
        [maxScore],
      );
      let rubric = rubricResult.rows[0];
      rubric = await this._applyRubricMeta(tx, rubric.rubric_id, { subjectId, createdBy, name }) || rubric;
      const savedCriteria = await this._insertCriteria(tx, rubric.rubric_id, criteria);
      return { ...rubric, criteria: savedCriteria };
    });
  }

  async update(rubricId, { maxScore, criteria, name }) {
    return this.db.withTransaction(async (tx) => {
      const fields = [];
      const values = [];

      if (maxScore !== undefined) {
        values.push(maxScore);
        fields.push(`max_score = ${values.length}`);
      }
      if (name !== undefined) {
        values.push(name);
        fields.push(`name = ${values.length}`);
      }

      if (fields.length > 0) {
        values.push(rubricId);
        const rubricResult = await tx.query(
          `UPDATE rubric SET ${fields.join(', ')}
           WHERE rubric_id = $${values.length}
           RETURNING *`,
          values,
        );
        if (!rubricResult.rows[0]) {
          return null;
        }
      } else {
        const rubricResult = await tx.query('SELECT * FROM rubric WHERE rubric_id = $1', [rubricId]);
        if (!rubricResult.rows[0]) {
          return null;
        }
      }

      let savedCriteria;
      if (criteria !== undefined) {
        // Replace criteria AND their performance levels (cascade on delete).
        await tx.query('DELETE FROM rubric_criterion WHERE rubric_id = $1', [rubricId]);
        savedCriteria = await this._insertCriteria(tx, rubricId, criteria);
      } else {
        const criteriaResult = await tx.query(
          'SELECT * FROM rubric_criterion WHERE rubric_id = $1 ORDER BY rubric_criterion_id ASC',
          [rubricId],
        );
        const levels = await this._loadLevelsForCriteria(criteriaResult.rows, tx);
        savedCriteria = this._withLevels(criteriaResult.rows, levels);
      }

      const rubricRow = await tx.query('SELECT * FROM rubric WHERE rubric_id = $1', [rubricId]);
      return {
        ...rubricRow.rows[0],
        criteria: savedCriteria,
      };
    });
  }

  // Copy a rubric (version+1, is_locked=false) with its criteria + performance
  // levels. Returns the new rubric with criteria attached.
  async clone(rubricId) {
    const source = await this.findById(rubricId);
    if (!source) {
      return null;
    }
    return this.db.withTransaction(async (tx) => {
      const nextVersion = (Number(source.version) || 1) + 1;
      const rubricResult = await tx.query(
        'INSERT INTO rubric (max_score) VALUES ($1) RETURNING *',
        [source.max_score],
      );
      const newRubricId = rubricResult.rows[0].rubric_id;
      const metaRow = await this._applyRubricMeta(tx, newRubricId, {
        name: source.name ?? undefined,
        subjectId: source.subject_id,
        createdBy: source.created_by,
        version: nextVersion,
        isLocked: false,
      });
      const criteriaToClone = (source.criteria || []).map((c) => ({
        name: c.criterion_name,
        weightPercent: Number(c.weight_percent),
        description: c.description ?? null,
        orderIndex: c.order_index ?? (i + 1),
        performanceLevels: (c.performance_levels || []).map((lvl) => ({
          label: lvl.label,
          minScore: lvl.min_score,
          maxScore: lvl.max_score,
          description: lvl.description ?? null,
          orderNo: lvl.order_no,
        })),
      }));
      const savedCriteria = await this._insertCriteria(tx, newRubricId, criteriaToClone);
      const rubricRow = metaRow || rubricResult.rows[0];
      return { ...rubricRow, criteria: savedCriteria };
    });
  }

  async deleteById(rubricId) {
    const result = await this.db.query(
      'DELETE FROM rubric WHERE rubric_id = $1 RETURNING *',
      [rubricId],
    );
    if (!result.rows[0]) {
      return null;
    }
    return result.rows[0];
  }

  async findCriterionById(criterionId) {
    const result = await this.db.query(
      'SELECT * FROM rubric_criterion WHERE rubric_criterion_id = $1',
      [criterionId],
    );
    return result.rows[0] || null;
  }

  // Set rubric.is_locked (migration 007). Wires the Step-3 lock path that the
  // exam-session open flow drives: a rubric used by an opened session is frozen
  // so its criteria/levels cannot change mid-exam. Accepts an optional
  // transaction runner so the lock can share the open flow's transaction.
  async setLocked(rubricId, locked = true, client = this.db) {
    const result = await client.query(
      'UPDATE rubric SET is_locked = $1 WHERE rubric_id = $2 RETURNING *',
      [locked === true, rubricId],
    );
    return result.rows[0] || null;
  }

  // --- Internals -----------------------------------------------------------

  // Set subject_id/version/is_locked/created_by when any are provided. These
  // columns come from migration 007 and may be absent in the in-memory mock;
  // in that case we skip the UPDATE and return null so the caller keeps the
  // base row.
  async _applyRubricMeta(tx, rubricId, {
    subjectId, createdBy, version, isLocked, name,
  }) {
    const fields = [];
    const values = [];
    if (name !== undefined) {
      values.push(name ?? null);
      fields.push(`name = ${values.length}`);
    }
    if (subjectId !== undefined) {
      values.push(subjectId ?? null);
      fields.push(`subject_id = $${values.length}`);
    }
    if (createdBy !== undefined) {
      values.push(createdBy ?? null);
      fields.push(`created_by = $${values.length}`);
    }
    if (version !== undefined) {
      values.push(version);
      fields.push(`version = $${values.length}`);
    }
    if (isLocked !== undefined) {
      values.push(isLocked);
      fields.push(`is_locked = $${values.length}`);
    }
    if (fields.length === 0) {
      return null;
    }
    values.push(rubricId);
    const result = await tx.query(
      `UPDATE rubric SET ${fields.join(', ')} WHERE rubric_id = $${values.length} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  }

  async _insertCriteria(tx, rubricId, criteria) {
    const saved = [];
    for (let i = 0; i < criteria.length; i += 1) {
      const criterion = criteria[i];
      const criterionResult = await tx.query(
        `INSERT INTO rubric_criterion (rubric_id, criterion_name, weight_percent, description, order_index)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [rubricId, criterion.name, criterion.weightPercent, criterion.description ?? null, criterion.orderIndex ?? criterion.order_index ?? (i + 1)],
      );
      const criterionRow = criterionResult.rows[0];
      const performanceLevels = [];
      // Only touch the performance_level table when levels are supplied, so the
      // legacy in-memory mock (which has no such table) is never exercised for
      // level-free rubrics.
      const levels = Array.isArray(criterion.performanceLevels) ? criterion.performanceLevels : [];
      for (const level of levels) {
        const levelResult = await tx.query(
          `INSERT INTO performance_level (criterion_id, label, min_score, max_score, description, order_no)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            criterionRow.rubric_criterion_id,
            level.label,
            level.minScore ?? null,
            level.maxScore ?? null,
            level.description ?? null,
            level.orderNo ?? null,
          ],
        );
        performanceLevels.push(levelResult.rows[0]);
      }
      saved.push({ ...criterionRow, performance_levels: performanceLevels });
    }
    return saved;
  }

  async _loadLevelsForCriteria(criterionRows, runner = this.db) {
    const byCriterion = new Map();
    if (!criterionRows || criterionRows.length === 0) {
      return byCriterion;
    }
    for (const criterion of criterionRows) {
      // Query per criterion so the in-memory mock (which only recognizes the
      // WHERE criterion_id = $1 shape) can short-circuit when the table is empty.
      let rows = [];
      try {
        const result = await runner.query(
          'SELECT * FROM performance_level WHERE criterion_id = $1 ORDER BY order_no ASC, performance_level_id ASC',
          [criterion.rubric_criterion_id],
        );
        rows = result.rows;
      } catch {
        // The mock DB has no performance_level table; treat as no levels.
        rows = [];
      }
      byCriterion.set(criterion.rubric_criterion_id, rows);
    }
    return byCriterion;
  }

  _withLevels(criterionRows, levelsByCriterion) {
    return criterionRows.map((row) => ({
      ...row,
      performance_levels: levelsByCriterion.get(row.rubric_criterion_id) || [],
    }));
  }

  _attachCriteria(rubricRows, criterionRows, levelsByCriterion) {
    const criteriaByRubric = criterionRows.reduce((acc, row) => {
      if (!acc[row.rubric_id]) {
        acc[row.rubric_id] = [];
      }
      acc[row.rubric_id].push({
        ...row,
        performance_levels: levelsByCriterion.get(row.rubric_criterion_id) || [],
      });
      return acc;
    }, {});

    return rubricRows.map((row) => ({
      ...row,
      criteria: criteriaByRubric[row.rubric_id] || [],
    }));
  }
}

module.exports = {
  RubricRepository,
};
