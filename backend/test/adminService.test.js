const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { AdminService } = require('../src/services/adminService');

const TEST_ENV = {
  appBaseUrl: 'http://localhost:8080',
  passwordSetTtlHours: 72,
};

class FakeUserRepo {
  constructor(users = []) {
    this.users = new Map(users.map((u) => [u.app_user_id, { ...u }]));
    this.nextId = Math.max(0, ...users.map((u) => u.app_user_id)) + 1;
  }

  async create({ code, email, fullName, passwordHash, role, status }) {
    const row = {
      app_user_id: this.nextId++,
      code: code ?? null,
      email,
      full_name: fullName ?? null,
      password_hash: passwordHash ?? null,
      role,
      status: status ?? 'ACTIVE',
      locked_until: null,
      failed_login_count: 0,
      must_change_password: false,
      last_login_at: null,
    };
    this.users.set(row.app_user_id, row);
    return { ...row };
  }

  async findById(id) {
    const u = this.users.get(Number(id));
    return u ? { ...u } : null;
  }

  async findByEmail(email) {
    for (const u of this.users.values()) if (u.email === email) return { ...u };
    return null;
  }

  async findByCode(code) {
    for (const u of this.users.values()) if (u.code === code) return { ...u };
    return null;
  }

  async list({ role } = {}) {
    const all = [...this.users.values()];
    return (role ? all.filter((u) => u.role === role) : all).map((u) => ({ ...u }));
  }

  async update(id, patch) {
    const u = this.users.get(Number(id));
    if (!u) return null;
    Object.assign(u, patch);
    return { ...u };
  }

  async countActiveAdmins() {
    return [...this.users.values()].filter((u) => u.role === 'ADMIN' && u.status === 'ACTIVE').length;
  }

  async listOpenExamInvolvement(userId) {
    return (this.openExams && this.openExams[userId]) || [];
  }

  async clearSubjectAssignments(userId) {
    this.cleared = [...(this.cleared || []), Number(userId)];
  }
}

class FakeSubjectRepo {
  constructor(subjects = []) {
    this.subjects = new Map(subjects.map((s) => [s.subject_id, { ...s }]));
    this.nextId = Math.max(0, ...subjects.map((s) => s.subject_id)) + 1;
    this.lecturers = new Map(); // subjectId -> [lecturerId]
    this.students = new Map(); // subjectId -> [studentId]
  }

  async setStudents(subjectId, studentIds) {
    const ids = Array.from(new Set((studentIds || []).filter((x) => x != null)));
    this.students.set(Number(subjectId), ids);
    return ids;
  }

  async listStudents(subjectId) {
    const ids = this.students.get(Number(subjectId)) || [];
    return ids.map((id) => ({
      app_user_id: id,
      code: `STU${id}`,
      email: `stu${id}@aives.local`,
      full_name: `Student ${id}`,
      role: 'STUDENT',
      status: 'ACTIVE',
    }));
  }

  async listLecturers(subjectId) {
    return (this.lecturers.get(Number(subjectId)) || []).map((id) => ({
      app_user_id: id, role: 'LECTURER', status: 'ACTIVE',
    }));
  }

  async create({ code, name }) {
    const row = { subject_id: this.nextId++, code, name };
    this.subjects.set(row.subject_id, row);
    return { ...row };
  }

  async findById(id) {
    const s = this.subjects.get(Number(id));
    return s ? { ...s } : null;
  }

  async list() {
    return [...this.subjects.values()].map((s) => ({ ...s }));
  }

  async update(id, patch) {
    const s = this.subjects.get(Number(id));
    if (!s) return null;
    Object.assign(s, patch);
    return { ...s };
  }

  async remove(id) {
    const s = this.subjects.get(Number(id));
    if (!s) return null;
    this.subjects.delete(Number(id));
    return { ...s };
  }

  async setLecturers(subjectId, lecturerIds) {
    const ids = Array.from(new Set((lecturerIds || []).filter((x) => x != null)));
    this.lecturers.set(Number(subjectId), ids);
    return ids;
  }

  async findByCode(code) {
    const want = String(code).trim().toLowerCase();
    const s = [...this.subjects.values()].find((x) => String(x.code).toLowerCase() === want);
    return s ? { ...s } : null;
  }

  async countDependents(id) {
    return { topics: 0, materials: 0, rubrics: 0, examSessions: 0, ...(this.dependents?.[id] || {}) };
  }

  async setStatus(id, status) {
    const s = this.subjects.get(Number(id));
    if (!s) return null;
    s.status = status;
    return { ...s };
  }
}

class FakeTokenRepo {
  constructor() { this.tokens = []; this.nextId = 1; }

  async create({ userId, tokenHash, purpose, expiresAt }) {
    const row = {
      password_token_id: this.nextId++, user_id: userId, token_hash: tokenHash, purpose, expires_at: expiresAt, used_at: null,
    };
    this.tokens.push(row);
    return row;
  }

  async invalidateActiveForUser(userId, purpose) {
    for (const t of this.tokens) {
      if (t.user_id === userId && t.purpose === purpose && !t.used_at) t.used_at = new Date();
    }
  }
}

class FakeJobRepo {
  constructor() { this.jobs = []; }

  async enqueue(type, payload) {
    const row = { background_job_id: this.jobs.length + 1, type, payload };
    this.jobs.push(row);
    return row;
  }
}

function build({ users = [], subjects = [], realtimeBus = null } = {}) {
  const appUserRepository = new FakeUserRepo(users);
  const subjectRepository = new FakeSubjectRepo(subjects);
  const passwordTokenRepository = new FakeTokenRepo();
  const backgroundJobRepository = new FakeJobRepo();
  const service = new AdminService({
    appUserRepository,
    subjectRepository,
    passwordTokenRepository,
    backgroundJobRepository,
    env: TEST_ENV,
    realtimeBus,
  });
  return {
    service, appUserRepository, subjectRepository, passwordTokenRepository, backgroundJobRepository,
  };
}

async function buildXlsx(rows, { header = ['Student Code', 'Full Name', 'Email'] } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Students');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// --- createLecturer -----------------------------------------------------------

test('createLecturer enqueues a SET email with a link and no plaintext password', async () => {
  const { service, backgroundJobRepository, appUserRepository } = build();
  const user = await service.createLecturer({ code: 'L001', email: 'lec@aives.local', fullName: 'Lec One' });
  assert.equal(user.role, 'LECTURER');
  assert.equal(user.email, 'lec@aives.local');

  const stored = await appUserRepository.findByEmail('lec@aives.local');
  assert.equal(stored.password_hash, null);

  assert.equal(backgroundJobRepository.jobs.length, 1);
  const job = backgroundJobRepository.jobs[0];
  assert.equal(job.type, 'SEND_EMAIL');
  assert.equal(job.payload.to, 'lec@aives.local');
  assert.equal(job.payload.template, 'SET_PASSWORD');
  assert.ok(job.payload.variables.link.includes('/set-password?token='));
  // No plaintext password anywhere in the payload.
  const serialized = JSON.stringify(job.payload).toLowerCase();
  assert.equal(serialized.includes('password_hash'), false);
  assert.equal('password' in job.payload, false);
});

test('admin user writes publish ID-only invalidations after persistence', async () => {
  const events = [];
  const realtimeBus = { publish: (entity, payload) => events.push({ entity, ...payload }) };
  const { service } = build({ realtimeBus });
  const created = await service.createUser({ email: 'safe@aives.local', fullName: 'Private Name', role: 'LECTURER' });
  assert.deepEqual(events, [{ entity: 'user', action: 'created', userId: created.id }]);
});

test('createLecturer rejects a duplicate email', async () => {
  const { service } = build({ users: [{
    app_user_id: 1, code: 'X', email: 'dup@aives.local', full_name: 'X', role: 'LECTURER', status: 'ACTIVE',
  }] });
  await assert.rejects(
    () => service.createLecturer({ code: 'L9', email: 'dup@aives.local', fullName: 'Dup' }),
    (err) => err.statusCode === 409,
  );
});

// --- importStudents: all-or-nothing ------------------------------------------

test('importStudents writes everything when all rows are valid', async () => {
  const { service, appUserRepository, backgroundJobRepository } = build();
  const buffer = await buildXlsx([
    ['S001', 'Alice', 'alice@aives.local'],
    ['S002', 'Bob', 'bob@aives.local'],
  ]);
  const result = await service.importStudents(buffer);
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 2);
  const all = await appUserRepository.list({ role: 'STUDENT' });
  assert.equal(all.length, 2);
  // One SET email per created student.
  assert.equal(backgroundJobRepository.jobs.length, 2);
});

test('importStudents performs ZERO writes when any row is invalid and returns per-row errors', async () => {
  const { service, appUserRepository, backgroundJobRepository } = build();
  const buffer = await buildXlsx([
    ['S001', 'Alice', 'alice@aives.local'],
    ['S002', '', 'not-an-email'], // missing name + bad email
    ['S003', 'Carol', 'carol@aives.local'],
  ]);
  const result = await service.importStudents(buffer);
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  const badRow = result.errors.find((e) => e.row === 3); // 1 header + row index
  assert.ok(badRow);
  assert.ok(badRow.errors.length >= 2);

  // Nothing was written and no emails enqueued.
  const all = await appUserRepository.list();
  assert.equal(all.length, 0);
  assert.equal(backgroundJobRepository.jobs.length, 0);
});

test('importStudents rejects in-file duplicate codes with zero writes', async () => {
  const { service, appUserRepository } = build();
  const buffer = await buildXlsx([
    ['S001', 'Alice', 'alice@aives.local'],
    ['S001', 'Bob', 'bob@aives.local'],
  ]);
  const result = await service.importStudents(buffer);
  assert.equal(result.ok, false);
  const all = await appUserRepository.list();
  assert.equal(all.length, 0);
});

test('importStudents rejects a code/email that already exists in the DB', async () => {
  const { service } = build({ users: [{
    app_user_id: 1, code: 'S001', email: 'existing@aives.local', full_name: 'E', role: 'STUDENT', status: 'ACTIVE',
  }] });
  const buffer = await buildXlsx([
    ['S001', 'Alice', 'alice@aives.local'],
  ]);
  const result = await service.importStudents(buffer);
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].errors.some((m) => m.toLowerCase().includes('student code')));
});

// --- subjects + lecturer assignment ------------------------------------------

test('subject CRUD lifecycle', async () => {
  const { service } = build();
  const created = await service.createSubject({ code: 'CS101', name: 'Intro' });
  assert.equal(created.code, 'CS101');
  const updated = await service.updateSubject(created.id, { name: 'Intro to CS' });
  assert.equal(updated.name, 'Intro to CS');
  const list = await service.listSubjects();
  assert.equal(list.length, 1);
  const del = await service.deleteSubject(created.id);
  assert.equal(del.ok, true);
  assert.equal((await service.listSubjects()).length, 0);
});

test('createSubject/updateSubject reject a duplicate code with SUBJECT_CODE_TAKEN', async () => {
  const { service } = build({ subjects: [{ subject_id: 1, code: 'CS101', name: 'Intro' }, { subject_id: 2, code: 'SE', name: 'SE' }] });
  await assert.rejects(
    () => service.createSubject({ code: ' cs101 ', name: 'Dup' }),
    (err) => err.statusCode === 409 && err.code === 'SUBJECT_CODE_TAKEN' && err.details.field === 'code',
  );
  await assert.rejects(
    () => service.updateSubject(2, { code: 'CS101' }),
    (err) => err.code === 'SUBJECT_CODE_TAKEN',
  );
  // Keeping its own code is fine.
  const same = await service.updateSubject(1, { code: 'CS101', name: 'Intro 2' });
  assert.equal(same.name, 'Intro 2');
  await assert.rejects(() => service.updateSubject(1, { name: '  ' }), (err) => err.code === 'VALIDATION_ERROR');
});

test('deleteSubject refuses a subject with content (SUBJECT_IN_USE + counts); archive works', async () => {
  const { service, subjectRepository } = build({ subjects: [{ subject_id: 1, code: 'CS', name: 'CS' }] });
  subjectRepository.dependents = { 1: { topics: 2, examSessions: 1 } };
  await assert.rejects(
    () => service.deleteSubject(1),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'SUBJECT_IN_USE');
      assert.equal(err.details.topics, 2);
      assert.equal(err.details.examSessions, 1);
      return true;
    },
  );
  const archived = await service.setSubjectArchived(1, true);
  assert.equal(archived.status, 'ARCHIVED');
  const restored = await service.setSubjectArchived(1, false);
  assert.equal(restored.status, 'ACTIVE');
  await assert.rejects(() => service.setSubjectArchived(99, true), (err) => err.statusCode === 404);
  await assert.rejects(() => service.deleteSubject(99), (err) => err.statusCode === 404);
});

test('assignLecturers replaces the full set', async () => {
  const events = [];
  const realtimeBus = { publish: (entity, payload) => events.push({ entity, ...payload }) };
  const { service, subjectRepository } = build({
    subjects: [{ subject_id: 1, code: 'CS', name: 'CS' }], realtimeBus,
  });
  await service.assignLecturers(1, [10, 11]);
  assert.deepEqual(subjectRepository.lecturers.get(1), [10, 11]);
  const result = await service.assignLecturers(1, [12]);
  assert.deepEqual(result.lecturerIds, [12]);
  assert.deepEqual(subjectRepository.lecturers.get(1), [12]);
  assert.deepEqual(events.at(-1), {
    entity: 'subject', action: 'updated', subjectId: 1, recipientUserIds: [10, 11, 12],
  });
});

test('assignStudents enrolls students by codes all-or-nothing', async () => {
  const { service, subjectRepository } = build({
    subjects: [{ subject_id: 1, code: 'CS', name: 'CS' }],
    users: [
      { app_user_id: 201, code: 'SE101', email: 's1@aives.local', role: 'STUDENT', status: 'ACTIVE' },
      { app_user_id: 202, code: 'SE102', email: 's2@aives.local', role: 'STUDENT', status: 'ACTIVE' },
    ],
  });

  // Invalid code fails with zero writes
  const fail = await service.assignStudents(1, { codes: 'SE101, NONEXISTENT' });
  assert.equal(fail.ok, false);
  assert.equal(fail.errors.length, 1);
  assert.equal(subjectRepository.students.get(1), undefined);

  // Success writes all
  const success = await service.assignStudents(1, { codes: 'SE101\nSE102' });
  assert.equal(success.ok, true);
  assert.deepEqual(subjectRepository.students.get(1), [201, 202]);

  const list = await service.listSubjectStudents(1);
  assert.equal(list.students.length, 2);
});

test('assignStudents enrolls students by studentIds', async () => {
  const { service, subjectRepository } = build({
    subjects: [{ subject_id: 1, code: 'CS', name: 'CS' }],
    users: [
      { app_user_id: 201, code: 'SE101', email: 's1@aives.local', role: 'STUDENT', status: 'ACTIVE' },
    ],
  });

  const res = await service.assignStudents(1, { studentIds: [201] });
  assert.equal(res.ok, true);
  assert.deepEqual(subjectRepository.students.get(1), [201]);

  const bad = await service.assignStudents(1, { studentIds: [999] });
  assert.equal(bad.ok, false);
});

test('assignStudents rejects invalid payload with VALIDATION_ERROR', async () => {
  const { service } = build({
    subjects: [{ subject_id: 1, code: 'CS', name: 'CS' }],
  });
  await assert.rejects(
    () => service.assignStudents(1, {}),
    (err) => { assert.equal(err.statusCode, 400); assert.equal(err.code, 'VALIDATION_ERROR'); return true; }
  );
  await assert.rejects(
    () => service.assignStudents(1, { studentIds: 'not-an-array' }),
    (err) => { assert.equal(err.statusCode, 400); assert.equal(err.code, 'VALIDATION_ERROR'); return true; }
  );
});

test('assignStudents allows explicitly clearing enrollments with studentIds: []', async () => {
  const { service, subjectRepository } = build({
    subjects: [{ subject_id: 1, code: 'CS', name: 'CS' }],
    users: [
      { app_user_id: 201, code: 'SE101', email: 's1@aives.local', role: 'STUDENT', status: 'ACTIVE' },
    ],
  });
  await service.assignStudents(1, { studentIds: [201] });
  assert.deepEqual(subjectRepository.students.get(1), [201]);

  const cleared = await service.assignStudents(1, { studentIds: [] });
  assert.equal(cleared.ok, true);
  assert.deepEqual(subjectRepository.students.get(1), []);
});

test('unlockUser clears lock state and sets status ACTIVE', async () => {
  const { service } = build({ users: [{
    app_user_id: 5, code: 'U5', email: 'u5@aives.local', full_name: 'U5', role: 'STUDENT',
    status: 'LOCKED', locked_until: new Date(Date.now() + 60000), failed_login_count: 5,
  }] });
  const user = await service.unlockUser(5);
  assert.equal(user.status, 'ACTIVE');
  assert.equal(user.lockedUntil, null);
});

// --- Step 14: Add User, role change, soft delete ------------------------------

const ADMIN_ACTOR = { id: 1, role: 'ADMIN' };
const BASE_USERS = [
  { app_user_id: 1, email: 'admin@x.io', role: 'ADMIN', status: 'ACTIVE' },
  { app_user_id: 2, email: 'lec@x.io', code: 'L2', role: 'LECTURER', status: 'ACTIVE' },
  { app_user_id: 3, email: 'stu@x.io', code: 'S3', role: 'STUDENT', status: 'ACTIVE' },
];

test('createUser creates any role; STUDENT requires a code; bad role is 400', async () => {
  const { service, backgroundJobRepository } = build({ users: BASE_USERS });
  const stu = await service.createUser({ code: ' SE001 ', email: 'a@x.io', fullName: 'A', role: 'student' });
  assert.equal(stu.role, 'STUDENT');
  assert.equal(stu.code, 'SE001');
  const adm = await service.createUser({ email: 'b@x.io', role: 'ADMIN' });
  assert.equal(adm.role, 'ADMIN');
  assert.equal(backgroundJobRepository.jobs.length, 2);
  await assert.rejects(
    () => service.createUser({ email: 'c@x.io', role: 'STUDENT' }),
    (err) => err.statusCode === 400 && err.code === 'CODE_REQUIRED' && err.details.field === 'code',
  );
  await assert.rejects(() => service.createUser({ email: 'd@x.io', role: 'ROOT' }), (err) => err.code === 'VALIDATION_ERROR');
});

test('updateUser role change clears subject assignments and enforces the guards', async () => {
  const { service, appUserRepository } = build({ users: BASE_USERS });
  const promoted = await service.updateUser(2, { role: 'ADMIN' }, ADMIN_ACTOR);
  assert.equal(promoted.role, 'ADMIN');
  assert.deepEqual(appUserRepository.cleared, [2]);

  await assert.rejects(
    () => service.updateUser(1, { role: 'LECTURER' }, ADMIN_ACTOR),
    (err) => err.statusCode === 409 && err.code === 'CANNOT_MODIFY_SELF',
  );
  // Another admin may not demote the last active admin either.
  const solo = build({ users: BASE_USERS });
  await assert.rejects(
    () => solo.service.updateUser(1, { role: 'LECTURER' }, { id: 99, role: 'ADMIN' }),
    (err) => err.code === 'LAST_ADMIN',
  );
  appUserRepository.openExams = { 3: [{ exam_session_id: 7, title: 'Mid', status: 'OPEN', involvement: 'CANDIDATE' }] };
  await assert.rejects(
    () => service.updateUser(3, { role: 'LECTURER' }, ADMIN_ACTOR),
    (err) => err.code === 'USER_IN_OPEN_EXAM' && err.details.exams[0].id === 7,
  );
  await assert.rejects(
    () => service.updateUser(2, { role: 'STUDENT', code: '' }, ADMIN_ACTOR),
    (err) => err.code === 'CODE_REQUIRED',
  );
});

test('deleteUser soft-deletes, revokes links and sessions, and is guarded', async () => {
  const revoked = [];
  const { service, appUserRepository, passwordTokenRepository } = build({ users: BASE_USERS });
  service.authSessionRepository = { async revokeAllForUser(id) { revoked.push(id); } };
  const deleted = await service.deleteUser(3, ADMIN_ACTOR);
  assert.equal(deleted.status, 'DELETED');
  assert.deepEqual(revoked, [3]);
  assert.ok(passwordTokenRepository.tokens.every((tk) => tk.user_id !== 3 || tk.used_at));
  assert.deepEqual(appUserRepository.cleared, [3]);
  // A deleted user is gone for the admin API.
  await assert.rejects(() => service.deleteUser(3, ADMIN_ACTOR), (err) => err.statusCode === 404);
  await assert.rejects(() => service.updateUser(3, { fullName: 'x' }, ADMIN_ACTOR), (err) => err.statusCode === 404);
  await assert.rejects(() => service.deleteUser(1, ADMIN_ACTOR), (err) => err.code === 'CANNOT_MODIFY_SELF');
});

// --- Step 14: server-side user search and assignments --------------------------

test('listUsers without paging params keeps the full list; with them it searches and pages', async () => {
  const { service, appUserRepository } = build({ users: BASE_USERS });
  const all = await service.listUsers({ role: 'STUDENT' });
  assert.equal(all.users.length, 1);
  assert.equal(all.total, 1);

  let seen = null;
  appUserRepository.search = async (args) => { seen = args; return { users: [BASE_USERS[1]], total: 41 }; };
  const page = await service.listUsers({ role: 'lecturer', q: 'ng', page: '3', pageSize: '500' });
  assert.deepEqual(seen, { role: 'LECTURER', status: undefined, q: 'ng', subjectId: undefined, limit: 100, offset: 200 });
  assert.equal(page.total, 41);
  assert.equal(page.page, 3);
  assert.equal(page.pageSize, 100);
  assert.equal(page.users[0].id, 2);
  await assert.rejects(() => service.listUsers({ status: 'GONE' }), (err) => err.code === 'VALIDATION_ERROR');
});

test('getUserAssignments returns the safe user plus assignments; 404 when missing', async () => {
  const { service, appUserRepository } = build({ users: BASE_USERS });
  appUserRepository.listAssignments = async () => ({
    subjectsTaught: [{ subject_id: 1 }], subjectsEnrolled: [], examsAsExaminer: [], examsAsCandidate: [],
  });
  const res = await service.getUserAssignments(2);
  assert.equal(res.user.id, 2);
  assert.equal('password_hash' in res.user, false);
  assert.equal(res.subjectsTaught.length, 1);
  await assert.rejects(() => service.getUserAssignments(99), (err) => err.statusCode === 404);
});
