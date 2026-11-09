const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: Client } = require('socket.io-client');
const { TokenService } = require('../src/auth/tokenService');
const { RealtimeBus } = require('../src/realtime/realtimeBus');
const { attachBusinessSocket, sanitizeEvent } = require('../src/realtime/businessSocket');

const tokenService = new TokenService({ secret: 'test-secret-that-is-at-least-32-chars-long!!' });

async function setup() {
  const server = http.createServer();
  const realtimeBus = new RealtimeBus();
  const exams = new Map([
    [1, { exam_session_id: 1, subject_id: 7, created_by: 12, status: 'OPEN' }],
    [2, { exam_session_id: 2, subject_id: 8, created_by: 11, status: 'DRAFT' }],
  ]);
  const lecturerSubjects = new Set([7]);
  const roster = new Set([20]);
  const appUserRepository = {
    findById: async (id) => ({
      app_user_id: Number(id),
      role: Number(id) === 20 ? 'STUDENT' : 'LECTURER',
      status: 'ACTIVE',
    }),
  };
  const examSessionRepository = {
    findById: async (id) => exams.get(id) || null,
    list: async () => [...exams.values()],
    isStudentOnRoster: async (examId, studentId) => examId === 1 && roster.has(studentId),
  };
  const subjectScope = {
    subjectRepository: { listSubjectIdsForLecturer: async (id) => (id === 10 ? [...lecturerSubjects] : []) },
    forUser: (user) => ({ allows: async (id) => id == null || (user.id === 10 && lecturerSubjects.has(id)) }),
  };
  const { io } = attachBusinessSocket(server, {
    tokenService, realtimeBus, examSessionRepository, subjectScope, appUserRepository,
    logger: { warn() {} },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const clients = [];
  async function connect(role, sub) {
    const { token } = tokenService.signAccess({ role, sub });
    const client = Client(`http://localhost:${server.address().port}/business`, {
      transports: ['websocket'], extraHeaders: { cookie: `access_token=${token}` },
    });
    clients.push(client);
    const snapshot = await new Promise((resolve, reject) => {
      client.once('business:snapshot', resolve);
      client.once('connect_error', reject);
    });
    return { client, snapshot };
  }
  async function close() {
    for (const client of clients) client.disconnect();
    await new Promise((resolve) => io.close(resolve));
  }
  return { connect, close, realtimeBus, lecturerSubjects, roster, exams };
}

function subscribe(client, examSessionId) {
  return new Promise((resolve) => client.emit('business:subscribe-exam', { examSessionId }, resolve));
}

test('business socket enforces exam scope and roster, and resync counts are scoped', async () => {
  const world = await setup();
  try {
    const lecturer = await world.connect('LECTURER', 10);
    assert.deepEqual(lecturer.snapshot.examCounts, { OPEN: 1 });
    assert.deepEqual(await subscribe(lecturer.client, 1), { ok: true });
    assert.equal((await subscribe(lecturer.client, 2)).error, 'FORBIDDEN');

    const student = await world.connect('STUDENT', 20);
    assert.equal(student.snapshot.examCounts, undefined);
    assert.deepEqual(await subscribe(student.client, 1), { ok: true });
    assert.equal((await subscribe(student.client, 2)).error, 'FORBIDDEN');

    const stranger = await world.connect('STUDENT', 21);
    assert.equal((await subscribe(stranger.client, 1)).error, 'FORBIDDEN');
    assert.equal((await subscribe(stranger.client, 999)).error, 'NOT_FOUND');
    assert.equal((await subscribe(stranger.client, -1)).error, 'INVALID_EXAM_ID');

    const admin = await world.connect('ADMIN', 99);
    assert.deepEqual(admin.snapshot.examCounts, { OPEN: 1, DRAFT: 1 });
    assert.deepEqual(await subscribe(admin.client, 2), { ok: true });
  } finally {
    await world.close();
  }
});

test('business invalidation drops arbitrary content and keeps only safe fields', () => {
  assert.deepEqual(sanitizeEvent({
    entity: 'exam', action: 'status_changed', examSessionId: 1, status: 'OPEN', ts: 123,
    summary: { answer: 'private' }, referenceAnswer: 'private', rationale: 'private',
  }), { entity: 'exam', action: 'status_changed', examSessionId: 1, status: 'OPEN', ts: 123 });
  assert.deepEqual(sanitizeEvent({
    entity: 'material', action: 'created', materialId: 8, subjectId: 7, title: 'secret', fileKey: 'secret', ts: 124,
  }), { entity: 'material', action: 'created', materialId: 8, subjectId: 7, ts: 124 });
  assert.deepEqual(sanitizeEvent({
    entity: 'rubric', action: 'updated', rubricId: 4, subjectId: 7, referenceAnswer: 'secret', criteria: ['secret'], ts: 125,
  }), { entity: 'rubric', action: 'updated', rubricId: 4, subjectId: 7, ts: 125 });
  assert.deepEqual(sanitizeEvent({
    entity: 'subject', action: 'updated', subjectId: 7, recipientUserIds: [10], email: 'private', summary: 'private', ts: 126,
  }), { entity: 'subject', action: 'updated', subjectId: 7, ts: 126 });
  assert.deepEqual(sanitizeEvent({
    entity: 'user', action: 'updated', userId: 20, email: 'private', fullName: 'private', role: 'ADMIN', ts: 127,
  }), { entity: 'user', action: 'updated', userId: 20, ts: 127 });
});

test('subject assignment invalidation reaches only active targeted accounts and admin', async () => {
  const world = await setup();
  try {
    const lecturer = (await world.connect('LECTURER', 10)).client;
    const unrelated = (await world.connect('LECTURER', 11)).client;
    const student = (await world.connect('STUDENT', 20)).client;
    const admin = (await world.connect('ADMIN', 99)).client;
    const seen = { lecturer: [], unrelated: [], student: [], admin: [] };
    lecturer.on('business:invalidation', (event) => seen.lecturer.push(event));
    unrelated.on('business:invalidation', (event) => seen.unrelated.push(event));
    student.on('business:invalidation', (event) => seen.student.push(event));
    admin.on('business:invalidation', (event) => seen.admin.push(event));

    world.realtimeBus.publish('subject', {
      action: 'updated', subjectId: 7, recipientUserIds: [10, 20], name: 'private', summary: 'private',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.lecturer.length, 1);
    assert.equal(seen.student.length, 1);
    assert.equal(seen.unrelated.length, 0);
    assert.equal(seen.admin.length, 1);
    assert.deepEqual(seen.student[0], {
      entity: 'subject', action: 'updated', subjectId: 7, ts: seen.student[0].ts,
    });
  } finally {
    await world.close();
  }
});

test('material and rubric invalidations fan out only to currently authorized subject viewers', async () => {
  const world = await setup();
  try {
    const inScope = (await world.connect('LECTURER', 10)).client;
    const outOfScope = (await world.connect('LECTURER', 11)).client;
    const admin = (await world.connect('ADMIN', 99)).client;
    const student = (await world.connect('STUDENT', 20)).client;
    const seen = { inScope: [], outOfScope: [], admin: [], student: [] };
    inScope.on('business:invalidation', (event) => seen.inScope.push(event));
    outOfScope.on('business:invalidation', (event) => seen.outOfScope.push(event));
    admin.on('business:invalidation', (event) => seen.admin.push(event));
    student.on('business:invalidation', (event) => seen.student.push(event));

    world.realtimeBus.publish('material', {
      action: 'created', materialId: 8, subjectId: 7, title: 'private title', fileKey: 'private/key',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen.inScope[0], {
      entity: 'material', action: 'created', materialId: 8, subjectId: 7, ts: seen.inScope[0].ts,
    });
    assert.equal(seen.outOfScope.length, 0);
    assert.equal(seen.admin.length, 1);
    assert.equal(seen.student.length, 0);

    world.lecturerSubjects.delete(7);
    world.realtimeBus.publish('rubric', {
      action: 'updated', rubricId: 4, subjectId: 7, referenceAnswer: 'private',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.inScope.length, 1);
    assert.equal(seen.outOfScope.length, 0);
    assert.equal(seen.admin.length, 2);
    assert.equal(seen.student.length, 0);
    assert.equal(seen.admin[1].referenceAnswer, undefined);
  } finally {
    await world.close();
  }
});

test('business events recheck access after a roster or subject assignment is revoked', async () => {
  const world = await setup();
  try {
    const lecturer = (await world.connect('LECTURER', 10)).client;
    const student = (await world.connect('STUDENT', 20)).client;
    await subscribe(lecturer, 1);
    await subscribe(student, 1);
    const seen = { lecturer: [], student: [] };
    lecturer.on('business:invalidation', (event) => seen.lecturer.push(event));
    student.on('business:invalidation', (event) => seen.student.push(event));
    world.realtimeBus.publish('exam', { action: 'status_changed', examSessionId: 1, subjectId: 7, status: 'OPEN', summary: { answer: 'secret' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.lecturer.length, 1);
    assert.equal(seen.student.length, 1);
    assert.equal(seen.student[0].summary, undefined);

    world.lecturerSubjects.delete(7);
    world.roster.delete(20);
    world.realtimeBus.publish('exam', { action: 'status_changed', examSessionId: 1, subjectId: 7, status: 'CLOSED' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.lecturer.length, 1);
    assert.equal(seen.student.length, 1);
  } finally {
    await world.close();
  }
});

test('unrelated lecturer does not receive invalidation for admin-created unscoped exam', async () => {
  const world = await setup();
  try {
    world.exams.set(3, { exam_session_id: 3, subject_id: null, created_by: 99, status: 'DRAFT' });
    const unrelated = (await world.connect('LECTURER', 11)).client;
    const admin = (await world.connect('ADMIN', 99)).client;
    const seen = { lecturer: [], admin: [] };
    unrelated.on('business:invalidation', (event) => seen.lecturer.push(event));
    admin.on('business:invalidation', (event) => seen.admin.push(event));

    world.realtimeBus.publish('exam', {
      action: 'created', examSessionId: 3, subjectId: null, status: 'DRAFT',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.lecturer.length, 0);
    assert.equal(seen.admin.length, 1);
  } finally {
    await world.close();
  }
});
