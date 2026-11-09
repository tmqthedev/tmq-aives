// Socket.IO /business namespace: role-authenticated invalidation channel for
// ADMIN, LECTURER, and STUDENT. Subject-scoped rooms for lecturers, exam rooms
// for students, and a global admin room. Emits only safe invalidation/status
// data (entity, action, ids, aggregate counts — never live answer content).
//
// Rooms:
//   role:ADMIN           — all admin-visible invalidation
//   subject:<id>         — exam/interview/result changes scoped to a subject
//   exam:<id>            — per-exam session events for students + monitoring
//   student:<userId>     — student-specific interview/result events
//
// Resync: on connect and reconnect, the server sends a 'business:snapshot'
// with the current aggregate state the client needs to rebuild its cache.

const { Server } = require('socket.io');
const { ACCESS_COOKIE } = require('../auth/cookieNames');

function parseCookies(cookieHeader = '') {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawVal] = part.trim().split('=');
    if (rawKey) {
      cookies[rawKey] = decodeURIComponent(rawVal.join('='));
    }
  }
  return cookies;
}

/**
 * @param {import('node:http').Server} httpServer
 * @param {object}                     deps
 * @param {import('../auth/tokenService').TokenService} deps.tokenService
 * @param {import('./realtimeBus').RealtimeBus}          deps.realtimeBus
 * @param {import('../services/subjectScope').SubjectScope} deps.subjectScope
 * @param {object} [deps.examSessionRepository]
 * @param {object} [deps.logger]
 * @param {string|boolean} [deps.corsOrigin]
 * @returns {{ io: import('socket.io').Server, nsp: import('socket.io').Namespace }}
 */
function attachBusinessSocket(httpServer, {
  tokenService,
  realtimeBus,
  subjectScope,
  examSessionRepository,
  appUserRepository,
  subjectRepository,
  logger = console,
  corsOrigin = true,
  io: existingIo,
} = {}) {
  // Reuse the existing Socket.IO server if provided (same HTTP server may host
  // both /interview and /business). Otherwise create a new one.
  const io = existingIo || new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
    path: '/socket.io',
  });

  const nsp = io.of('/business');

  // ── Authentication middleware ──────────────────────────────────────────
  nsp.use((socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie || '';
      const cookies = parseCookies(cookieHeader);
      const token = cookies[ACCESS_COOKIE] || cookies.access_token;
      if (!token) {
        return next(new Error('AUTHENTICATION_REQUIRED'));
      }
      const payload = tokenService.verify(token, { type: 'access' });
      if (!payload || !['ADMIN', 'LECTURER', 'STUDENT'].includes(payload.role)) {
        return next(new Error('FORBIDDEN'));
      }
      socket.user = {
        id: payload.sub,
        role: payload.role,
      };
      return next();
    } catch (err) {
      return next(new Error('INVALID_TOKEN'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────
  nsp.on('connection', async (socket) => {
    const { user } = socket;
    socket.data.businessExamSubscriptions = new Set();

    // Admin: join the global admin room
    if (user.role === 'ADMIN') {
      socket.join('role:ADMIN');
    }

    // Lecturer: join each of their subject rooms
    if (user.role === 'LECTURER' && subjectScope && subjectScope.subjectRepository) {
      try {
        const ids = await subjectScope.subjectRepository.listSubjectIdsForLecturer(user.id);
        for (const sid of ids) {
          socket.join(`subject:${sid}`);
        }
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'business socket: failed to load lecturer subjects');
      }
    }

    // Student: join a personal room
    if (user.role === 'STUDENT') {
      socket.join(`student:${user.id}`);
    }

    try {
      socket.emit('business:snapshot', await buildSnapshot(user, { examSessionRepository, subjectScope }));
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'business socket: initial resync failed');
    }

    // ── Client subscribes to a specific exam (students + lecturers) ────
    socket.on('business:subscribe-exam', async (data = {}, callback) => {
      try {
        const examId = Number(data.examSessionId);
        if (!Number.isSafeInteger(examId) || examId <= 0) throw new Error('INVALID_EXAM_ID');
        const exam = await examSessionRepository.findById(examId);
        if (!exam) throw new Error('NOT_FOUND');
        if (user.role === 'LECTURER') {
          const allowed = exam.subject_id != null
            && await subjectScope.forUser(user).allows(exam.subject_id);
          if (!allowed && Number(exam.created_by) !== Number(user.id)) throw new Error('FORBIDDEN');
        }
        if (user.role === 'STUDENT'
          && !(await examSessionRepository.isStudentOnRoster(examId, user.id))) {
          throw new Error('FORBIDDEN');
        }
        await socket.join(`exam:${examId}`);
        socket.data.businessExamSubscriptions.add(examId);
        if (typeof callback === 'function') callback({ ok: true });
      } catch (err) {
        if (typeof callback === 'function') callback({ ok: false, error: err.message });
      }
    });

    // ── Client unsubscribes from a specific exam ───────────────────────
    socket.on('business:unsubscribe-exam', (data = {}, callback) => {
      const examId = Number(data.examSessionId);
      if (examId) {
        socket.leave(`exam:${examId}`);
        socket.data.businessExamSubscriptions.delete(examId);
      }
      if (typeof callback === 'function') callback({ ok: true });
    });

    // ── Client requests a resync snapshot (reconnect/initial load) ─────
    socket.on('business:resync', async (data = {}, callback) => {
      try {
        const snapshot = await buildSnapshot(socket.user, {
          examSessionRepository,
          subjectScope,
        });
        socket.emit('business:snapshot', snapshot);
        if (typeof callback === 'function') callback({ ok: true, snapshot });
      } catch (err) {
        logger.warn({ err, userId: socket.user.id }, 'business:resync failed');
        if (typeof callback === 'function') callback({ ok: false, error: 'resync failed' });
      }
    });
  });

  // ── Fan out bus events to the right sockets ────────────────────────────
  realtimeBus.on('invalidation', (event) => {
    deliverInvalidation(event, nsp.sockets.values(), {
      examSessionRepository, subjectScope, appUserRepository, logger,
    });
  });

  return { io, nsp };
}


const STUDENT_RESULT_ACTIONS = new Set(['finalized', 'reopened']);

// Recheck current access for every event and every socket. Room membership
// alone goes stale when a roster or subject assignment changes while a socket
// stays open. `sockets` is any iterable of { user, data, emit } (fakes in tests).
function deliverInvalidation(event, sockets, {
  examSessionRepository, subjectScope, appUserRepository, logger = console,
} = {}) {
  const safe = sanitizeEvent(event);
  if (!safe.entity || !safe.action) return Promise.resolve();
  const list = [...sockets];
  return Promise.resolve().then(async () => {
    for (const socket of list) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await payloadFor(socket, event, safe, { examSessionRepository, subjectScope, appUserRepository });
        if (out) socket.emit('business:invalidation', out);
      } catch (err) {
        logger.warn({ err }, 'business socket: delivery check failed');
      }
    }
  }).catch((err) => logger.warn({ err }, 'business socket: invalidation fanout failed'));
}

// Returns the wire payload for this socket, or null when it must not receive it.
async function payloadFor(socket, event, safe, { examSessionRepository, subjectScope, appUserRepository }) {
  const { user } = socket;
  if (user.role === 'ADMIN') {
    return await hasActiveRole(appUserRepository, user.id, 'ADMIN') ? safe : null;
  }
  const isPerStudent = event.entity === 'interview' || event.entity === 'result';

  if (user.role === 'LECTURER') {
    let allowed = false;
    if (event.entity === 'subject') {
      allowed = Array.isArray(event.recipientUserIds)
        && event.recipientUserIds.some((id) => Number(id) === Number(user.id))
        && await hasActiveRole(appUserRepository, user.id, 'LECTURER');
    } else if ((event.entity === 'exam' || isPerStudent) && event.examSessionId) {
      // Exam REST access also permits the creator, including exams that
      // have no subject. Re-read the row so ownership and scope are current.
      const exam = await examSessionRepository.findById(Number(event.examSessionId));
      allowed = Boolean(exam && (
        Number(exam.created_by) === Number(user.id)
        || (exam.subject_id != null && await subjectScope.forUser(user).allows(exam.subject_id))
      ));
    } else if (event.subjectId != null) {
      allowed = await subjectScope.forUser(user).allows(event.subjectId);
    } else if (event.entity === 'rubric' || event.entity === 'question') {
      // REST listing includes unscoped rows for lecturers.
      allowed = await subjectScope.forUser(user).allows(null);
    }
    return allowed ? safe : null;
  }

  if (user.role === 'STUDENT') {
    if (event.entity === 'subject') {
      const isRecipient = Array.isArray(event.recipientUserIds)
        && event.recipientUserIds.some((id) => Number(id) === Number(user.id));
      return isRecipient && await hasActiveRole(appUserRepository, user.id, 'STUDENT') ? safe : null;
    }
    if (isPerStudent) {
      // Routed by studentUserId only (never on the wire). A student never sees
      // another student's events, nor a result before it is FINALIZED.
      if (event.studentUserId == null || Number(event.studentUserId) !== Number(user.id)) return null;
      if (event.entity === 'result' && !STUDENT_RESULT_ACTIONS.has(event.action)) return null;
      if (!await hasActiveRole(appUserRepository, user.id, 'STUDENT')) return null;
      if (event.entity === 'result') {
        const { status, ...rest } = safe;
        return status === 'FINALIZED' ? safe : rest;
      }
      return safe;
    }
    // Rostered students learn that their exam opened/closed without having to
    // subscribe; DRAFT exams are never announced to them.
    const subscribed = socket.data.businessExamSubscriptions.has(Number(event.examSessionId));
    if (event.entity === 'exam' && event.examSessionId
      && (subscribed || ['SCHEDULED', 'OPEN', 'CLOSED'].includes(event.status))
      && await examSessionRepository.isStudentOnRoster(event.examSessionId, user.id)) {
      return safe;
    }
  }
  return null;
}

// Strip internal fields before sending to clients. Only safe
// invalidation/status data crosses the wire: entity, action, ids, status,
// aggregate counts (summary). Never answer content, reference answers, or
// rationale.
function sanitizeEvent(event) {
  const safe = {};
  if (['exam', 'interview', 'result', 'material', 'rubric', 'user', 'subject', 'question'].includes(event.entity)) safe.entity = event.entity;
  if (['created', 'updated', 'deleted', 'status_changed', 'completed', 'grading_progress', 'finalized', 'reopened'].includes(event.action)) safe.action = event.action;
  for (const key of ['examSessionId', 'interviewId', 'resultId', 'materialId', 'rubricId', 'subjectId', 'userId', 'questionId', 'topicId', 'generationJobId']) {
    if (Number.isSafeInteger(Number(event[key])) && Number(event[key]) > 0) safe[key] = Number(event[key]);
  }
  if (typeof event.status === 'string' && /^[A-Z_]{1,32}$/.test(event.status)) safe.status = event.status;
  safe.ts = Number.isSafeInteger(event.ts) ? event.ts : Date.now();
  return safe;
}

async function hasActiveRole(appUserRepository, userId, role) {
  if (!appUserRepository || typeof appUserRepository.findById !== 'function') return false;
  const current = await appUserRepository.findById(userId);
  return Boolean(current && current.status === 'ACTIVE' && current.role === role);
}

// Build a snapshot for a reconnecting client. For now, this is kept lightweight:
// students see their own exam/interview counts, lecturers/admins see aggregate
// exam status counts. Full list data is fetched via REST; this just tells the
// client "your cache is stale, here are the latest counts".
async function buildSnapshot(user, { examSessionRepository, subjectScope } = {}) {
  const snapshot = { role: user.role, ts: Date.now() };

  if (!examSessionRepository || typeof examSessionRepository.list !== 'function') {
    return snapshot;
  }

  try {
    if (user.role === 'ADMIN') {
      const exams = await examSessionRepository.list();
      snapshot.examCounts = countByStatus(exams);
    } else if (user.role === 'LECTURER' && subjectScope) {
      const scope = subjectScope.forUser(user);
      const exams = await examSessionRepository.list();
      const scoped = [];
      for (const e of exams) {
        // eslint-disable-next-line no-await-in-loop
        if ((e.subject_id != null && await scope.allows(e.subject_id))
          || Number(e.created_by) === Number(user.id)) scoped.push(e);
      }
      snapshot.examCounts = countByStatus(scoped);
    }
    // Students: no aggregate exam data in snapshot; they resync via REST.
  } catch {
    // Non-fatal: snapshot is best-effort
  }

  return snapshot;
}

function countByStatus(exams) {
  const counts = {};
  for (const e of exams) {
    const s = e.status || 'UNKNOWN';
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

module.exports = {
  attachBusinessSocket, parseCookies, sanitizeEvent, buildSnapshot, deliverInvalidation,
};
