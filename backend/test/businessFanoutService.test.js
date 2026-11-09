const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverInvalidation, sanitizeEvent } = require('../src/realtime/businessSocket');

function fakeSocket(role, id) {
  const sent = [];
  return {
    user: { id, role },
    data: { businessExamSubscriptions: new Set() },
    emit: (name, payload) => sent.push({ name, payload }),
    sent,
  };
}

function world() {
  const lecturerSubjects = new Set([7]);
  const exams = new Map([
    [1, { exam_session_id: 1, subject_id: 7, created_by: 99 }],
  ]);
  return {
    lecturerSubjects,
    deps: {
      logger: { warn() {} },
      appUserRepository: {
        findById: async (id) => (id === 2 ? { app_user_id: id, status: 'DELETED', role: 'ADMIN' }
          : { app_user_id: id, status: 'ACTIVE', role: id >= 20 ? 'STUDENT' : id === 1 ? 'ADMIN' : 'LECTURER' }),
      },
      examSessionRepository: {
        findById: async (id) => exams.get(Number(id)) || null,
        isStudentOnRoster: async () => true,
      },
      subjectScope: {
        forUser: (user) => ({ allows: async (sid) => sid == null || (user.id === 10 && lecturerSubjects.has(sid)) }),
      },
    },
  };
}

const interviewEvent = {
  entity: 'interview', action: 'completed', interviewId: 5, examSessionId: 1, subjectId: 7,
  status: 'COMPLETED', studentUserId: 20, answerText: 'secret', summary: 'secret',
};

test('admin gets everything; lecturer outside the subject gets nothing', async () => {
  const { deps } = world();
  const admin = fakeSocket('ADMIN', 1);
  const inScope = fakeSocket('LECTURER', 10);
  const outside = fakeSocket('LECTURER', 11);
  for (const entity of ['interview', 'result', 'question']) {
    await deliverInvalidation({ ...interviewEvent, entity, questionId: 3, topicId: 2 }, [admin, inScope, outside], deps);
  }
  assert.equal(admin.sent.length, 3);
  assert.equal(inScope.sent.length, 3);
  assert.equal(outside.sent.length, 0);
});

test('lecturer removed from the subject mid-connection stops receiving', async () => {
  const { deps, lecturerSubjects } = world();
  const lecturer = fakeSocket('LECTURER', 10);
  await deliverInvalidation(interviewEvent, [lecturer], deps);
  assert.equal(lecturer.sent.length, 1);
  lecturerSubjects.delete(7);
  await deliverInvalidation(interviewEvent, [lecturer], deps);
  assert.equal(lecturer.sent.length, 1);
});

test('student A never receives student B interview or result events', async () => {
  const { deps } = world();
  const a = fakeSocket('STUDENT', 20);
  const b = fakeSocket('STUDENT', 21);
  a.data.businessExamSubscriptions.add(1);
  b.data.businessExamSubscriptions.add(1);
  await deliverInvalidation(interviewEvent, [a, b], deps);
  await deliverInvalidation({
    ...interviewEvent, entity: 'result', action: 'finalized', status: 'FINALIZED', resultId: 9,
  }, [a, b], deps);
  assert.equal(a.sent.length, 2);
  assert.equal(b.sent.length, 0);
});

test('student gets result events only when finalized or reopened', async () => {
  const { deps } = world();
  const s = fakeSocket('STUDENT', 20);
  const base = { ...interviewEvent, entity: 'result', resultId: 9 };
  await deliverInvalidation({ ...base, action: 'status_changed', status: 'AI_SCORING' }, [s], deps);
  await deliverInvalidation({ ...base, action: 'updated', status: 'AI_SUGGESTED' }, [s], deps);
  assert.equal(s.sent.length, 0);
  await deliverInvalidation({ ...base, action: 'finalized', status: 'FINALIZED' }, [s], deps);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].payload.status, 'FINALIZED');
  await deliverInvalidation({ ...base, action: 'reopened', status: 'FLAGGED' }, [s], deps);
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1].payload.status, undefined);
});

test('wire payload never contains routing, answer or summary fields', async () => {
  const { deps } = world();
  const admin = fakeSocket('ADMIN', 1);
  const student = fakeSocket('STUDENT', 20);
  await deliverInvalidation(interviewEvent, [admin, student], deps);
  for (const { payload } of [...admin.sent, ...student.sent]) {
    for (const key of ['studentUserId', 'answerText', 'summary', 'answer', 'transcript']) {
      assert.equal(key in payload, false);
    }
  }
  assert.deepEqual(Object.keys(sanitizeEvent({ ...interviewEvent, ts: 1 })).sort(),
    ['action', 'entity', 'examSessionId', 'interviewId', 'status', 'subjectId', 'ts']);
});

test('students in an exam room do not receive other entity events', async () => {
  const { deps } = world();
  const s = fakeSocket('STUDENT', 22);
  s.data.businessExamSubscriptions.add(1);
  await deliverInvalidation(interviewEvent, [s], deps);
  await deliverInvalidation({
    entity: 'question', action: 'created', questionId: 1, subjectId: 7, examSessionId: 1,
  }, [s], deps);
  assert.equal(s.sent.length, 0);
  await deliverInvalidation({
    entity: 'exam', action: 'status_changed', examSessionId: 1, status: 'OPEN',
  }, [s], deps);
  assert.equal(s.sent.length, 1);
});

test('a deleted or demoted admin stops receiving on an open socket', async () => {
  const { deps } = world();
  const removed = fakeSocket('ADMIN', 2);
  await deliverInvalidation(interviewEvent, [removed], deps);
  assert.equal(removed.sent.length, 0);
});
