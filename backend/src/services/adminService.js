const ExcelJS = require('exceljs');
const { sha256, randomToken } = require('../auth/tokenService');

function adminError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['ADMIN', 'LECTURER', 'STUDENT'];

function toSafeUser(user) {
  if (!user) return null;
  return {
    id: user.app_user_id,
    code: user.code ?? null,
    email: user.email,
    fullName: user.full_name ?? null,
    role: user.role,
    status: user.status,
    mustChangePassword: user.must_change_password === true,
    lockedUntil: user.locked_until ?? null,
    lastLoginAt: user.last_login_at ?? null,
  };
}

function toSubject(subject) {
  if (!subject) return null;
  return {
    id: subject.subject_id,
    code: subject.code,
    name: subject.name,
    status: subject.status || 'ACTIVE',
    lecturerCount: subject.lecturer_count == null ? undefined : Number(subject.lecturer_count),
    studentCount: subject.student_count == null ? undefined : Number(subject.student_count),
  };
}

/**
 * Admin domain service: user management, all-or-nothing Excel student import,
 * subject CRUD and lecturer assignment. Plaintext passwords are never placed in
 * email payloads; account setup always goes through a single-use SET token link.
 */
class AdminService {
  constructor({
    appUserRepository,
    subjectRepository,
    passwordTokenRepository,
    backgroundJobRepository,
    authSessionRepository,
    realtimeBus,
    env,
    clock,
  }) {
    this.appUserRepository = appUserRepository;
    this.authSessionRepository = authSessionRepository;
    this.realtimeBus = realtimeBus;
    this.subjectRepository = subjectRepository;
    this.passwordTokenRepository = passwordTokenRepository;
    this.backgroundJobRepository = backgroundJobRepository;
    this.env = env;
    this.clock = clock || (() => new Date());
  }

  _now() {
    return this.clock();
  }

  _publishAdminEntity(entity, action, ids = {}) {
    this.realtimeBus?.publish(entity, { action, ...ids });
  }

  async _subjectRecipientIds(subjectId) {
    if (typeof this.subjectRepository.listLecturers !== 'function'
      || typeof this.subjectRepository.listStudents !== 'function') return [];
    const [lecturers, students] = await Promise.all([
      this.subjectRepository.listLecturers(subjectId),
      this.subjectRepository.listStudents(subjectId),
    ]);
    return [...new Set([...lecturers, ...students].map((user) => Number(user.app_user_id)).filter(Number.isSafeInteger))];
  }

  _publishSubject(action, subjectId, recipientUserIds = []) {
    this.realtimeBus?.publish('subject', {
      action,
      subjectId: Number(subjectId),
      recipientUserIds: [...new Set(recipientUserIds.map(Number).filter(Number.isSafeInteger))],
    });
  }

  // --- Users ---------------------------------------------------------------

  // Without paging/filter params this keeps the old full list. With any of
  // q/status/subjectId/page/pageSize it searches server-side and pages.
  async listUsers({
    role, status, q, subjectId, page, pageSize,
  } = {}) {
    const paged = [status, q, subjectId, page, pageSize].some((v) => v !== undefined && v !== '');
    if (!paged || typeof this.appUserRepository.search !== 'function') {
      const users = await this.appUserRepository.list({ role });
      return { users: users.map(toSafeUser), total: users.length };
    }
    if (status && !['ACTIVE', 'LOCKED', 'DELETED'].includes(String(status).toUpperCase())) {
      throw adminError(400, 'VALIDATION_ERROR', 'status must be ACTIVE, LOCKED or DELETED.');
    }
    const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
    const current = Math.max(Number(page) || 1, 1);
    const { users, total } = await this.appUserRepository.search({
      role: role ? String(role).toUpperCase() : undefined,
      status: status ? String(status).toUpperCase() : undefined,
      q,
      subjectId: subjectId ? Number(subjectId) : undefined,
      limit: size,
      offset: (current - 1) * size,
    });
    return {
      users: users.map(toSafeUser), total, page: current, pageSize: size,
    };
  }

  async getUserAssignments(id) {
    const user = await this.appUserRepository.findById(id);
    if (!user) throw adminError(404, 'NOT_FOUND', 'User not found.');
    const assignments = await this.appUserRepository.listAssignments(id);
    return { user: toSafeUser(user), ...assignments };
  }

  async createLecturer({ code, email, fullName }) {
    return this._createPasswordlessUser({ code, email, fullName, role: 'LECTURER' });
  }

  // Add User (Step 14): any role; a STUDENT needs a code (it is their login
  // identifier and the roster key).
  async createUser({ code, email, fullName, role }) {
    const normalizedRole = String(role || 'LECTURER').toUpperCase();
    if (!ROLES.includes(normalizedRole)) {
      throw adminError(400, 'VALIDATION_ERROR', `role must be one of ${ROLES.join(', ')}.`);
    }
    const trimmedCode = typeof code === 'string' ? code.trim() : code;
    if (normalizedRole === 'STUDENT' && !trimmedCode) {
      const err = adminError(400, 'CODE_REQUIRED', 'A student code is required.');
      err.details = { field: 'code' };
      throw err;
    }
    return this._createPasswordlessUser({
      code: trimmedCode || null, email, fullName, role: normalizedRole,
    });
  }

  // Guards shared by role change and delete: not yourself, not the last
  // active ADMIN, not while in a SCHEDULED/OPEN exam.
  async _assertUserChangeAllowed(user, actor, { action }) {
    if (actor && Number(actor.id) === Number(user.app_user_id)) {
      throw adminError(409, 'CANNOT_MODIFY_SELF', `You cannot ${action} your own account.`);
    }
    if (user.role === 'ADMIN' && user.status === 'ACTIVE'
      && typeof this.appUserRepository.countActiveAdmins === 'function'
      && (await this.appUserRepository.countActiveAdmins()) <= 1) {
      throw adminError(409, 'LAST_ADMIN', 'The last active admin cannot be changed or deleted.');
    }
    if (typeof this.appUserRepository.listOpenExamInvolvement === 'function') {
      const exams = await this.appUserRepository.listOpenExamInvolvement(user.app_user_id);
      if (exams.length > 0) {
        const err = adminError(409, 'USER_IN_OPEN_EXAM', 'The user is an examiner or candidate of a scheduled or open exam.');
        err.details = { exams: exams.map((e) => ({ id: e.exam_session_id, title: e.title, status: e.status, involvement: e.involvement })) };
        throw err;
      }
    }
  }

  async _createPasswordlessUser({ code, email, fullName, role }) {
    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    if (!normalizedEmail || !EMAIL_RE.test(normalizedEmail)) {
      throw adminError(400, 'VALIDATION_ERROR', 'A valid email is required.');
    }
    const existingByEmail = await this.appUserRepository.findByEmail(normalizedEmail);
    if (existingByEmail) {
      throw adminError(409, 'EMAIL_TAKEN', 'A user with this email already exists.');
    }
    if (code) {
      const existingByCode = await this.appUserRepository.findByCode(code);
      if (existingByCode) {
        throw adminError(409, 'CODE_TAKEN', 'A user with this code already exists.');
      }
    }
    const user = await this.appUserRepository.create({
      code: code ?? null,
      email: normalizedEmail,
      fullName: fullName ?? null,
      passwordHash: null,
      role,
      status: 'ACTIVE',
    });
    this._publishAdminEntity('user', 'created', { userId: Number(user.app_user_id) });
    await this._enqueueSetupEmail(user);
    return toSafeUser(user);
  }

  async updateUser(id, patch, actor = null) {
    const user = await this.appUserRepository.findById(id);
    if (!user || user.status === 'DELETED') throw adminError(404, 'NOT_FOUND', 'User not found.');
    const allowed = {};
    let roleChanged = false;
    if (patch.role !== undefined && String(patch.role).toUpperCase() !== user.role) {
      const role = String(patch.role).toUpperCase();
      if (!ROLES.includes(role)) {
        throw adminError(400, 'VALIDATION_ERROR', `role must be one of ${ROLES.join(', ')}.`);
      }
      await this._assertUserChangeAllowed(user, actor, { action: 'change the role of' });
      if (role === 'STUDENT' && !(patch.code ?? user.code)) {
        const err = adminError(400, 'CODE_REQUIRED', 'A student code is required.');
        err.details = { field: 'code' };
        throw err;
      }
      allowed.role = role;
      roleChanged = true;
    }
    if (patch.fullName !== undefined) allowed.full_name = patch.fullName;
    if (patch.email !== undefined) {
      const normalizedEmail = typeof patch.email === 'string' ? patch.email.trim() : '';
      if (!normalizedEmail || !EMAIL_RE.test(normalizedEmail)) {
        throw adminError(400, 'VALIDATION_ERROR', 'A valid email is required.');
      }
      const other = await this.appUserRepository.findByEmail(normalizedEmail);
      if (other && other.app_user_id !== user.app_user_id) {
        throw adminError(409, 'EMAIL_TAKEN', 'A user with this email already exists.');
      }
      allowed.email = normalizedEmail;
    }
    if (patch.code !== undefined) {
      if (patch.code) {
        const other = await this.appUserRepository.findByCode(patch.code);
        if (other && other.app_user_id !== user.app_user_id) {
          throw adminError(409, 'CODE_TAKEN', 'A user with this code already exists.');
        }
      }
      allowed.code = patch.code;
    }
    const updated = await this.appUserRepository.update(id, allowed);
    if (roleChanged && typeof this.appUserRepository.clearSubjectAssignments === 'function') {
      await this.appUserRepository.clearSubjectAssignments(id);
    }
    this._publishAdminEntity('user', 'updated', { userId: Number(id) });
    return toSafeUser(updated);
  }

  // Soft delete: status DELETED, setup/reset links and refresh sessions are
  // revoked. History rows (exams, results, audit) keep pointing at the user.
  async deleteUser(id, actor = null) {
    const user = await this.appUserRepository.findById(id);
    if (!user || user.status === 'DELETED') throw adminError(404, 'NOT_FOUND', 'User not found.');
    await this._assertUserChangeAllowed(user, actor, { action: 'delete' });
    const updated = await this.appUserRepository.update(id, { status: 'DELETED' });
    await this.passwordTokenRepository.invalidateActiveForUser(id, 'SET');
    await this.passwordTokenRepository.invalidateActiveForUser(id, 'RESET');
    if (this.authSessionRepository && typeof this.authSessionRepository.revokeAllForUser === 'function') {
      await this.authSessionRepository.revokeAllForUser(id);
    }
    if (typeof this.appUserRepository.clearSubjectAssignments === 'function') {
      await this.appUserRepository.clearSubjectAssignments(id);
    }
    this._publishAdminEntity('user', 'deleted', { userId: Number(id) });
    return toSafeUser(updated);
  }

  async lockUser(id) {
    const user = await this.appUserRepository.findById(id);
    if (!user) throw adminError(404, 'NOT_FOUND', 'User not found.');
    const updated = await this.appUserRepository.update(id, { status: 'LOCKED' });
    this._publishAdminEntity('user', 'updated', { userId: Number(id) });
    return toSafeUser(updated);
  }

  async unlockUser(id) {
    const user = await this.appUserRepository.findById(id);
    if (!user) throw adminError(404, 'NOT_FOUND', 'User not found.');
    const updated = await this.appUserRepository.update(id, {
      status: 'ACTIVE',
      locked_until: null,
      failed_login_count: 0,
    });
    this._publishAdminEntity('user', 'updated', { userId: Number(id) });
    return toSafeUser(updated);
  }

  async resendSetupLink(id) {
    const user = await this.appUserRepository.findById(id);
    if (!user) throw adminError(404, 'NOT_FOUND', 'User not found.');
    await this._enqueueSetupEmail(user);
    return { ok: true };
  }

  async _enqueueSetupEmail(user) {
    await this.passwordTokenRepository.invalidateActiveForUser(user.app_user_id, 'SET');
    const rawToken = randomToken(32);
    const expiresAt = new Date(this._now().getTime() + this.env.passwordSetTtlHours * 3600 * 1000);
    await this.passwordTokenRepository.create({
      userId: user.app_user_id,
      tokenHash: sha256(rawToken),
      purpose: 'SET',
      expiresAt,
    });
    const base = this.env.appBaseUrl.replace(/\/+$/, '');
    const link = `${base}/set-password?token=${encodeURIComponent(rawToken)}`;
    // NOTE: only the one-time link is sent; no plaintext password is ever
    // included in the email payload.
    await this.backgroundJobRepository.enqueue('SEND_EMAIL', {
      to: user.email,
      template: 'SET_PASSWORD',
      subject: 'Set your AIVES password',
      variables: {
        fullName: user.full_name ?? null,
        link,
        purpose: 'SET',
      },
    });
  }

  // --- Student Excel import -----------------------------------------------

  /**
   * Parse an XLSX buffer with the columns student code / full name / email and
   * validate the WHOLE file before writing anything. If any row is invalid the
   * method returns {ok:false, errors:[{row, errors:[...]}]} and performs zero
   * inserts. Otherwise every student is created and SET emails are enqueued.
   */
  async importStudents(buffer) {
    let rows;
    try {
      rows = await this._parseStudentWorkbook(buffer);
    } catch (err) {
      throw adminError(400, 'INVALID_FILE', err.message || 'Could not read the uploaded file.');
    }

    if (rows.length === 0) {
      return { ok: false, errors: [{ row: 0, errors: ['The file contains no data rows.'] }] };
    }

    const errors = [];
    const seenCodes = new Map();
    const seenEmails = new Map();

    // First pass: per-row shape + in-file duplicate detection.
    for (const entry of rows) {
      const rowErrors = [];
      const { rowNumber, code, fullName, email } = entry;

      if (!code) rowErrors.push('Student code is required.');
      if (!fullName) rowErrors.push('Full name is required.');
      if (!email) {
        rowErrors.push('Email is required.');
      } else if (!EMAIL_RE.test(email)) {
        rowErrors.push('Email is not a valid address.');
      }

      if (code) {
        if (seenCodes.has(code)) {
          rowErrors.push(`Duplicate student code within the file (also row ${seenCodes.get(code)}).`);
        } else {
          seenCodes.set(code, rowNumber);
        }
      }
      if (email) {
        const key = email.toLowerCase();
        if (seenEmails.has(key)) {
          rowErrors.push(`Duplicate email within the file (also row ${seenEmails.get(key)}).`);
        } else {
          seenEmails.set(key, rowNumber);
        }
      }

      if (rowErrors.length > 0) {
        errors.push({ row: rowNumber, errors: rowErrors });
      }
    }

    // Second pass: DB duplicate detection (only for rows that passed shape).
    for (const entry of rows) {
      const { rowNumber, code, email } = entry;
      if (!code || !email || !EMAIL_RE.test(email)) continue;
      const rowErrors = [];
      const byCode = await this.appUserRepository.findByCode(code);
      if (byCode) rowErrors.push('A user with this student code already exists.');
      const byEmail = await this.appUserRepository.findByEmail(email);
      if (byEmail) rowErrors.push('A user with this email already exists.');
      if (rowErrors.length > 0) {
        const existing = errors.find((e) => e.row === rowNumber);
        if (existing) existing.errors.push(...rowErrors);
        else errors.push({ row: rowNumber, errors: rowErrors });
      }
    }

    if (errors.length > 0) {
      errors.sort((a, b) => a.row - b.row);
      return { ok: false, errors };
    }

    // All rows valid: insert every student and enqueue a setup email.
    const created = [];
    for (const entry of rows) {
      const user = await this.appUserRepository.create({
        code: entry.code,
        email: entry.email,
        fullName: entry.fullName,
        passwordHash: null,
        role: 'STUDENT',
        status: 'ACTIVE',
      });
      await this._enqueueSetupEmail(user);
      this._publishAdminEntity('user', 'created', { userId: Number(user.app_user_id) });
      created.push(toSafeUser(user));
    }
    return { ok: true, created };
  }

  async _parseStudentWorkbook(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new Error('The workbook has no worksheets.');
    }

    // Resolve the three expected columns from the header row, tolerating order
    // and label variations (student code / full name / email).
    const headerRow = sheet.getRow(1);
    const headerMap = {};
    headerRow.eachCell((cell, colNumber) => {
      const label = String(cell.value ?? '').trim().toLowerCase();
      if (!label) return;
      if (label.includes('code')) headerMap.code = colNumber;
      else if (label.includes('name')) headerMap.fullName = colNumber;
      else if (label.includes('email') || label.includes('e-mail')) headerMap.email = colNumber;
    });

    if (headerMap.code === undefined || headerMap.fullName === undefined || headerMap.email === undefined) {
      throw new Error('The header row must contain student code, full name, and email columns.');
    }

    const read = (row, colNumber) => {
      const value = row.getCell(colNumber).value;
      if (value === null || value === undefined) return '';
      if (typeof value === 'object' && value.text !== undefined) return String(value.text).trim();
      return String(value).trim();
    };

    const rows = [];
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const code = read(row, headerMap.code);
      const fullName = read(row, headerMap.fullName);
      const email = read(row, headerMap.email);
      if (!code && !fullName && !email) continue; // skip fully blank rows
      rows.push({ rowNumber: r, code, fullName, email });
    }
    return rows;
  }

  // --- Subjects ------------------------------------------------------------

  async listSubjects() {
    const subjects = typeof this.subjectRepository.listWithCounts === 'function'
      ? await this.subjectRepository.listWithCounts()
      : await this.subjectRepository.list();
    return subjects.map(toSubject);
  }

  async listSubjectLecturers(subjectId) {
    const subject = await this.subjectRepository.findById(subjectId);
    if (!subject) throw adminError(404, 'NOT_FOUND', 'Subject not found.');
    const rows = await this.subjectRepository.listLecturers(subjectId);
    return { subjectId, lecturers: rows.map(toSafeUser) };
  }

  async createSubject({ code, name }) {
    const trimmedCode = typeof code === 'string' ? code.trim() : '';
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedCode || !trimmedName) {
      throw adminError(400, 'VALIDATION_ERROR', 'Subject code and name are required.');
    }
    await this._assertSubjectCodeFree(trimmedCode);
    const subject = await this.subjectRepository.create({ code: trimmedCode, name: trimmedName });
    this._publishSubject('created', subject.subject_id);
    return toSubject(subject);
  }

  // 409 SUBJECT_CODE_TAKEN (details.field = code) before the INSERT/UPDATE;
  // mapDbError maps the unique-constraint violation the same way for races.
  async _assertSubjectCodeFree(code, exceptId = null) {
    if (typeof this.subjectRepository.findByCode !== 'function') return;
    const existing = await this.subjectRepository.findByCode(code);
    if (existing && Number(existing.subject_id) !== Number(exceptId)) {
      const err = adminError(409, 'SUBJECT_CODE_TAKEN', `Subject code "${code}" already exists.`);
      err.details = { field: 'code' };
      throw err;
    }
  }

  async updateSubject(id, patch) {
    const subject = await this.subjectRepository.findById(id);
    if (!subject) throw adminError(404, 'NOT_FOUND', 'Subject not found.');
    const allowed = {};
    if (patch.code !== undefined) allowed.code = String(patch.code).trim();
    if (patch.name !== undefined) allowed.name = String(patch.name).trim();
    if (allowed.code === '' || allowed.name === '') {
      throw adminError(400, 'VALIDATION_ERROR', 'Subject code and name are required.');
    }
    if (allowed.code !== undefined) await this._assertSubjectCodeFree(allowed.code, id);
    const updated = await this.subjectRepository.update(id, allowed);
    this._publishSubject('updated', id, await this._subjectRecipientIds(id));
    return toSubject(updated);
  }

  // Only an empty subject is deleted; one with content must be archived so
  // its exams and results keep their subject.
  async deleteSubject(id) {
    const subject = await this.subjectRepository.findById(id);
    if (!subject) throw adminError(404, 'NOT_FOUND', 'Subject not found.');
    const recipients = await this._subjectRecipientIds(id);
    if (typeof this.subjectRepository.countDependents === 'function') {
      const counts = await this.subjectRepository.countDependents(id);
      if (Object.values(counts || {}).some((n) => Number(n) > 0)) {
        const err = adminError(409, 'SUBJECT_IN_USE', 'The subject still has topics, materials, rubrics or exams. Archive it instead.');
        err.details = counts;
        throw err;
      }
    }
    await this.subjectRepository.remove(id);
    this._publishSubject('deleted', id, recipients);
    return { ok: true };
  }

  async setSubjectArchived(id, archived) {
    const subject = await this.subjectRepository.findById(id);
    if (!subject) throw adminError(404, 'NOT_FOUND', 'Subject not found.');
    const recipients = await this._subjectRecipientIds(id);
    const updated = await this.subjectRepository.setStatus(id, archived ? 'ARCHIVED' : 'ACTIVE');
    this._publishSubject('updated', id, recipients);
    return toSubject(updated);
  }

  async assignLecturers(subjectId, lecturerIds) {
    const subject = await this.subjectRepository.findById(subjectId);
    if (!subject) throw adminError(404, 'NOT_FOUND', 'Subject not found.');
    const previousRecipients = await this._subjectRecipientIds(subjectId);
    const ids = Array.isArray(lecturerIds) ? lecturerIds.map(Number).filter(Number.isInteger) : [];
    const assigned = await this.subjectRepository.setLecturers(subjectId, ids);
    const currentRecipients = await this._subjectRecipientIds(subjectId);
    this._publishSubject('updated', subjectId, [...previousRecipients, ...currentRecipients]);
    return { subjectId, lecturerIds: assigned };
  }

  _parseCodes(codes) {
    const raw = Array.isArray(codes) ? codes.join('\n') : String(codes || '');
    const seen = new Set();
    const result = [];
    for (const token of raw.split(/[\n,]+/)) {
      const code = token.trim();
      if (code === '') continue;
      if (seen.has(code)) continue;
      seen.add(code);
      result.push(code);
    }
    return result;
  }

  async listSubjectStudents(subjectId) {
    const subject = await this.subjectRepository.findById(subjectId);
    if (!subject) throw adminError(404, 'NOT_FOUND', 'Subject not found.');
    const rows = await this.subjectRepository.listStudents(subjectId);
    return { subjectId, students: rows.map(toSafeUser) };
  }

  async assignStudents(subjectId, { codes, studentIds } = {}) {
    const subject = await this.subjectRepository.findById(subjectId);
    if (!subject) throw adminError(404, 'NOT_FOUND', 'Subject not found.');
    const previousRecipients = await this._subjectRecipientIds(subjectId);

    if (codes === undefined && studentIds === undefined) {
      throw adminError(400, 'VALIDATION_ERROR', 'Either studentIds array or codes must be provided.');
    }
    if (studentIds !== undefined && !Array.isArray(studentIds)) {
      throw adminError(400, 'VALIDATION_ERROR', 'studentIds must be an array.');
    }
    if (codes !== undefined && typeof codes !== 'string' && !Array.isArray(codes)) {
      throw adminError(400, 'VALIDATION_ERROR', 'codes must be a string or array.');
    }

    if (codes !== undefined) {
      const parsed = this._parseCodes(codes);
      const errors = [];
      const resolved = [];
      for (const code of parsed) {
        const row = await this.appUserRepository.findByCode(code);
        if (!row) {
          errors.push({ code, error: 'Unknown student code.' });
        } else if (row.role !== 'STUDENT') {
          errors.push({ code, error: 'Code does not belong to a STUDENT.' });
        } else if (row.status !== 'ACTIVE') {
          errors.push({ code, error: 'Student account is not ACTIVE.' });
        } else {
          resolved.push(row);
        }
      }
      if (errors.length > 0) {
        return { ok: false, errors };
      }
      const assigned = await this.subjectRepository.setStudents(
        subjectId,
        resolved.map((r) => r.app_user_id),
      );
      const currentRecipients = await this._subjectRecipientIds(subjectId);
      this._publishSubject('updated', subjectId, [...previousRecipients, ...currentRecipients]);
      return {
        ok: true,
        subjectId,
        studentIds: assigned,
        students: resolved.map(toSafeUser),
      };
    }

    const ids = Array.isArray(studentIds)
      ? Array.from(new Set(studentIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)))
      : [];
    const errors = [];
    const resolved = [];
    for (const id of ids) {
      const row = await this.appUserRepository.findById(id);
      if (!row) {
        errors.push({ id, error: `Unknown student ID ${id}.` });
      } else if (row.role !== 'STUDENT') {
        errors.push({ id, code: row.code, error: 'User is not a STUDENT.' });
      } else if (row.status !== 'ACTIVE') {
        errors.push({ id, code: row.code, error: 'Student account is not ACTIVE.' });
      } else {
        resolved.push(row);
      }
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    const assigned = await this.subjectRepository.setStudents(subjectId, ids);
    const currentRecipients = await this._subjectRecipientIds(subjectId);
    this._publishSubject('updated', subjectId, [...previousRecipients, ...currentRecipients]);
    return {
      ok: true,
      subjectId,
      studentIds: assigned,
      students: resolved.map(toSafeUser),
    };
  }
}

module.exports = { AdminService, toSafeUser, toSubject };
