import { apiRequest } from './authApi';

// --- exam sessions --------------------------------------------------------
// All /exam-sessions routes are LECTURER-only on the backend (requireAuth +
// requireRole('LECTURER')). apiRequest sends the auth cookie and surfaces the
// backend error shape via the thrown error's `code`/`details`.

// List the lecturer's exam sessions. The backend scopes by the authenticated
// lecturer (own sessions + in-scope subjects) and returns the raw exam_session
// rows.
// Monitoring aggregate: { counts: { [examSessionId]: { inProgress, completed } } }.
export function getExamMonitoring() {
  return apiRequest('/exam-sessions/monitoring');
}

export function listExamSessions() {
  return apiRequest('/exam-sessions');
}

// Fetch form options: in-scope subjects, topics with bloom/approved counts,
// enrolled students and assigned lecturers.
// Per-subject question-bank progress for the lecturer dashboard:
// { subjects: [{ subjectId, code, name, topics, readyMaterials, rubrics,
//   approvedQuestions, pendingQuestions, scheduledExams, resultsToReview }] }
export function getLecturerProgress() {
  return apiRequest('/exam-sessions/progress');
}

export function getExamSessionOptions() {
  return apiRequest('/exam-sessions/options');
}

// Fetch a single session plus its participants ({ ...session, students,
// examiners }).
export function getExamSession(id) {
  return apiRequest(`/exam-sessions/${id}`);
}

// Create a session. Body carries subjectId, topicId, title, language and the
// Nhom-3 config fields plus session_time_limit_sec (lecturer-set total
// interview time); omitted config fields fall back to the backend defaults
// (3/2/120/0/1800s).
export function createExamSession(body) {
  return apiRequest('/exam-sessions', { method: 'POST', body });
}

// Patch a DRAFT session (title, language, config fields, opens_at/closes_at,
// max_follow_ups_total, bloom_distribution).
export function updateExamSession(id, patch) {
  return apiRequest(`/exam-sessions/${id}`, { method: 'PUT', body: patch });
}

// Set the roster from studentIds array or pasted student codes.
// On any invalid row it answers HTTP 422 with { ok:false, errors:[...] }.
export function setExamStudents(id, payload) {
  const body = typeof payload === 'string'
    ? { codes: payload }
    : (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { studentIds: payload });
  return apiRequest(`/exam-sessions/${id}/students`, {
    method: 'PUT',
    body,
  });
}

// Replace the examiner set. Each id must resolve to a LECTURER assigned to this subject.
export function setExamExaminers(id, lecturerIds) {
  return apiRequest(`/exam-sessions/${id}/examiners`, {
    method: 'PUT',
    body: { lecturerIds },
  });
}

// Submit a DRAFT session for scheduling (DRAFT -> SCHEDULED). The lecturer
// can no longer open a session; an admin starts it from the exam schedule.
// Fails with 409 NOT_ENOUGH_QUESTIONS (details { required, available,
// byLevel }) or 400 VALIDATION_ERROR when the window is missing/invalid.
export function scheduleExamSession(id) {
  return apiRequest(`/exam-sessions/${id}/schedule`, { method: 'POST' });
}

// Withdraw a SCHEDULED session back to DRAFT so it can be edited again.
export function unscheduleExamSession(id) {
  return apiRequest(`/exam-sessions/${id}/unschedule`, { method: 'POST' });
}

// Transition OPEN -> CLOSED.
export function closeExamSession(id) {
  return apiRequest(`/exam-sessions/${id}/close`, { method: 'POST' });
}

// Topics are fetched from the shared /topics endpoint and filtered client-side
// by subject_id (there is no per-subject topics route), mirroring materialApi.
export function listTopics() {
  return apiRequest('/topics');
}
