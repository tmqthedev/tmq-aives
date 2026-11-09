function parseId(rawId, label = 'id') {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error(`${label} must be a positive integer.`);
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return id;
}

/**
 * Resolve the uploaded Excel buffer from the request. Supports a raw body
 * buffer (when a raw body parser is mounted) or a JSON body carrying the file
 * as base64 under `file` or `data`.
 */
function resolveImportBuffer(req) {
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    return req.body;
  }
  const body = req.body || {};
  const base64 = body.file || body.data;
  if (typeof base64 === 'string' && base64.length > 0) {
    // Tolerate a data: URL prefix.
    const commaIdx = base64.indexOf(',');
    const raw = base64.startsWith('data:') && commaIdx !== -1 ? base64.slice(commaIdx + 1) : base64;
    return Buffer.from(raw, 'base64');
  }
  const err = new Error('An Excel file is required (raw body or base64 in `file`).');
  err.statusCode = 400;
  err.code = 'VALIDATION_ERROR';
  throw err;
}

class AdminController {
  // examSessionService backs the Step-12 exam schedule endpoints;
  // auditLogRepository records every successful admin write (IDs only).
  constructor(service, { examSessionService, auditLogRepository } = {}) {
    this.service = service;
    this.examSessionService = examSessionService;
    this.auditLogRepository = auditLogRepository;
  }

  async _audit(req, action, entityType, entityIds) {
    if (!this.auditLogRepository) return;
    const ids = (Array.isArray(entityIds) ? entityIds : [entityIds]).filter((id) => id != null);
    for (const entityId of ids) {
      // eslint-disable-next-line no-await-in-loop
      await this.auditLogRepository.record({
        actorId: req.user ? req.user.id : null, action, entityType, entityId: Number(entityId),
      });
    }
  }

  async listAuditLog(req, res, next) {
    try {
      if (!this.auditLogRepository) {
        res.json({ entries: [], total: 0 });
        return;
      }
      const q = req.query || {};
      const limit = Math.min(Math.max(Number(q.pageSize) || 50, 1), 200);
      const page = Math.max(Number(q.page) || 1, 1);
      const result = await this.auditLogRepository.list({
        entityType: q.entityType || undefined,
        entityId: q.entityId ? Number(q.entityId) : undefined,
        actorId: q.actorId ? Number(q.actorId) : undefined,
        limit,
        offset: (page - 1) * limit,
      });
      res.json({ ...result, page, pageSize: limit });
    } catch (err) { next(err); }
  }

  _requireExamSessions() {
    if (!this.examSessionService) {
      const e = new Error('Exam schedule is not available.');
      e.statusCode = 501;
      e.code = 'NOT_IMPLEMENTED';
      throw e;
    }
    return this.examSessionService;
  }

  // --- Exam schedule (Step 12) ---
  async listExamSchedule(req, res, next) {
    try {
      const {
        status, subjectId, from, to,
      } = req.query || {};
      const sessions = await this._requireExamSessions().listScheduleForAdmin({
        user: req.user, status, subjectId, from, to,
      });
      res.json({ sessions });
    } catch (err) { next(err); }
  }

  async getExamMonitoring(req, res, next) {
    try {
      res.json(await this._requireExamSessions().getInterviewCounts({ user: req.user }));
    } catch (err) { next(err); }
  }

  // Admin create/edit/delete (Step 14). Create and edit reuse the lecturer
  // service (ADMIN passes the subject scope; the language is derived from the
  // topic bank); a new session starts as DRAFT for the lecturers to complete.
  async createExamSession(req, res, next) {
    try {
      const session = await this._requireExamSessions().createSession({ ...(req.body || {}), user: req.user });
      await this._audit(req, 'EXAM_CREATE', 'EXAM_SESSION', session.exam_session_id);
      res.status(201).json({ session });
    } catch (err) { next(err); }
  }

  async updateExamSession(req, res, next) {
    try {
      const session = await this._requireExamSessions().updateSession({
        ...(req.body || {}), user: req.user, examSessionId: parseId(req.params.id),
      });
      await this._audit(req, 'EXAM_UPDATE', 'EXAM_SESSION', parseId(req.params.id));
      res.json({ session });
    } catch (err) { next(err); }
  }

  async deleteExamSession(req, res, next) {
    try {
      await this._requireExamSessions().deleteSession({ user: req.user, examSessionId: parseId(req.params.id) });
      await this._audit(req, 'EXAM_DELETE', 'EXAM_SESSION', parseId(req.params.id));
      res.status(204).end();
    } catch (err) { next(err); }
  }

  async startExamSession(req, res, next) {
    try {
      const session = await this._requireExamSessions().startSession({
        user: req.user, examSessionId: parseId(req.params.id),
      });
      await this._audit(req, 'EXAM_START', 'EXAM_SESSION', parseId(req.params.id));
      res.json({ session });
    } catch (err) { next(err); }
  }

  async closeExamSession(req, res, next) {
    try {
      const session = await this._requireExamSessions().closeSession({
        user: req.user, examSessionId: parseId(req.params.id),
      });
      await this._audit(req, 'EXAM_CLOSE', 'EXAM_SESSION', parseId(req.params.id));
      res.json({ session });
    } catch (err) { next(err); }
  }

  async warmExamSession(req, res, next) {
    try {
      const warmStatus = await this._requireExamSessions().warmSession({
        user: req.user, examSessionId: parseId(req.params.id),
      });
      await this._audit(req, 'EXAM_WARM', 'EXAM_SESSION', parseId(req.params.id));
      res.json({ warm_status: warmStatus });
    } catch (err) { next(err); }
  }

  // --- Users ---
  async listUsers(req, res, next) {
    try {
      const q = req.query || {};
      const result = await this.service.listUsers({
        role: q.role, status: q.status, q: q.q, subjectId: q.subjectId, page: q.page, pageSize: q.pageSize,
      });
      res.json(result);
    } catch (err) { next(err); }
  }

  async getUserAssignments(req, res, next) {
    try {
      const result = await this.service.getUserAssignments(parseId(req.params.id));
      res.json(result);
    } catch (err) { next(err); }
  }

  async createUser(req, res, next) {
    try {
      const {
        code, email, fullName, role,
      } = req.body || {};
      const user = await this.service.createUser({
        code, email, fullName, role,
      });
      await this._audit(req, 'USER_CREATE', 'USER', user.id);
      res.status(201).json({ user });
    } catch (err) { next(err); }
  }

  async updateUser(req, res, next) {
    try {
      const before = req.body && req.body.role !== undefined;
      const user = await this.service.updateUser(parseId(req.params.id), req.body || {}, req.user);
      await this._audit(req, before ? 'USER_UPDATE_ROLE' : 'USER_UPDATE', 'USER', user.id);
      res.json({ user });
    } catch (err) { next(err); }
  }

  async deleteUser(req, res, next) {
    try {
      const user = await this.service.deleteUser(parseId(req.params.id), req.user);
      await this._audit(req, 'USER_DELETE', 'USER', user.id);
      res.json({ user });
    } catch (err) { next(err); }
  }

  async lockUser(req, res, next) {
    try {
      const user = await this.service.lockUser(parseId(req.params.id));
      await this._audit(req, 'USER_LOCK', 'USER', user.id);
      res.json({ user });
    } catch (err) { next(err); }
  }

  async unlockUser(req, res, next) {
    try {
      const user = await this.service.unlockUser(parseId(req.params.id));
      await this._audit(req, 'USER_UNLOCK', 'USER', user.id);
      res.json({ user });
    } catch (err) { next(err); }
  }

  async resendSetup(req, res, next) {
    try {
      const result = await this.service.resendSetupLink(parseId(req.params.id));
      await this._audit(req, 'USER_RESEND_SETUP', 'USER', parseId(req.params.id));
      res.json(result);
    } catch (err) { next(err); }
  }

  async importStudents(req, res, next) {
    try {
      const buffer = resolveImportBuffer(req);
      const result = await this.service.importStudents(buffer);
      if (!result.ok) {
        res.status(422).json(result);
        return;
      }
      await this._audit(req, 'USER_IMPORT', 'USER', (result.created || []).map((u) => u.id));
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  // --- Subjects ---
  async listSubjects(_req, res, next) {
    try {
      const subjects = await this.service.listSubjects();
      res.json({ subjects });
    } catch (err) { next(err); }
  }

  async createSubject(req, res, next) {
    try {
      const subject = await this.service.createSubject(req.body || {});
      await this._audit(req, 'SUBJECT_CREATE', 'SUBJECT', subject.id);
      res.status(201).json({ subject });
    } catch (err) { next(err); }
  }

  async updateSubject(req, res, next) {
    try {
      const subject = await this.service.updateSubject(parseId(req.params.id), req.body || {});
      await this._audit(req, 'SUBJECT_UPDATE', 'SUBJECT', subject.id);
      res.json({ subject });
    } catch (err) { next(err); }
  }

  async deleteSubject(req, res, next) {
    try {
      await this.service.deleteSubject(parseId(req.params.id));
      await this._audit(req, 'SUBJECT_DELETE', 'SUBJECT', parseId(req.params.id));
      res.status(204).end();
    } catch (err) { next(err); }
  }

  async archiveSubject(req, res, next) {
    try {
      const subject = await this.service.setSubjectArchived(parseId(req.params.id), true);
      await this._audit(req, 'SUBJECT_ARCHIVE', 'SUBJECT', subject.id);
      res.json({ subject });
    } catch (err) { next(err); }
  }

  async unarchiveSubject(req, res, next) {
    try {
      const subject = await this.service.setSubjectArchived(parseId(req.params.id), false);
      await this._audit(req, 'SUBJECT_UNARCHIVE', 'SUBJECT', subject.id);
      res.json({ subject });
    } catch (err) { next(err); }
  }

  async assignLecturers(req, res, next) {
    try {
      const { lecturerIds } = req.body || {};
      const result = await this.service.assignLecturers(parseId(req.params.id), lecturerIds);
      await this._audit(req, 'SUBJECT_ASSIGN_LECTURERS', 'SUBJECT', parseId(req.params.id));
      res.json(result);
    } catch (err) { next(err); }
  }

  async listSubjectLecturers(req, res, next) {
    try {
      const result = await this.service.listSubjectLecturers(parseId(req.params.id));
      res.json(result);
    } catch (err) { next(err); }
  }

  async listSubjectStudents(req, res, next) {
    try {
      const result = await this.service.listSubjectStudents(parseId(req.params.id));
      res.json(result);
    } catch (err) { next(err); }
  }

  async assignStudents(req, res, next) {
    try {
      const { codes, studentIds } = req.body || {};
      const result = await this.service.assignStudents(parseId(req.params.id), { codes, studentIds });
      if (!result.ok) {
        res.status(422).json(result);
        return;
      }
      await this._audit(req, 'SUBJECT_ASSIGN_STUDENTS', 'SUBJECT', parseId(req.params.id));
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = { AdminController };
