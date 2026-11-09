import { apiRequest } from './authApi';

// --- users ----------------------------------------------------------------

export function listUsers(role) {
  const query = role ? `?role=${encodeURIComponent(role)}` : '';
  return apiRequest(`/admin/users${query}`);
}

// Server-side search + paging: returns { users, total, page, pageSize }.
export function searchUsers({ role, status, q, subjectId, page = 1, pageSize = 20 } = {}) {
  const params = new URLSearchParams();
  if (role) params.set('role', role);
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  if (subjectId) params.set('subjectId', subjectId);
  params.set('page', page);
  params.set('pageSize', pageSize);
  return apiRequest(`/admin/users?${params.toString()}`);
}

// { user, subjectsTaught, subjectsEnrolled, examsAsExaminer, examsAsCandidate }
export function getUserAssignments(id) {
  return apiRequest(`/admin/users/${id}/assignments`);
}

export function createLecturer({ code, email, fullName }) {
  return apiRequest('/admin/users', { method: 'POST', body: { code, email, fullName } });
}

// Add User (Step 14): role is STUDENT | LECTURER | ADMIN.
export function createUser({ code, email, fullName, role }) {
  return apiRequest('/admin/users', { method: 'POST', body: { code, email, fullName, role } });
}

// Soft delete: the user becomes DELETED and can no longer sign in.
export function deleteUser(id) {
  return apiRequest(`/admin/users/${id}`, { method: 'DELETE' });
}

export function updateUser(id, patch) {
  return apiRequest(`/admin/users/${id}`, { method: 'PUT', body: patch });
}

export function lockUser(id) {
  return apiRequest(`/admin/users/${id}/lock`, { method: 'POST' });
}

export function unlockUser(id) {
  return apiRequest(`/admin/users/${id}/unlock`, { method: 'POST' });
}

export function resendSetup(id) {
  return apiRequest(`/admin/users/${id}/resend-setup`, { method: 'POST' });
}

// Sends the raw .xlsx bytes with the spreadsheet content type so the backend
// reads it as a binary body. Returns { ok, created } on success; on an invalid
// file the backend answers 422 with { ok:false, errors:[{row,errors[]}] },
// which arrives as the thrown error's `details`.
export function importStudents(file) {
  return apiRequest('/admin/users/import', {
    method: 'POST',
    raw: file,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  });
}

// --- subjects --------------------------------------------------------------

export function listSubjects() {
  return apiRequest('/admin/subjects');
}

export function createSubject({ code, name }) {
  return apiRequest('/admin/subjects', { method: 'POST', body: { code, name } });
}

export function updateSubject(id, patch) {
  return apiRequest(`/admin/subjects/${id}`, { method: 'PUT', body: patch });
}

export function deleteSubject(id) {
  return apiRequest(`/admin/subjects/${id}`, { method: 'DELETE' });
}

export function setSubjectArchived(id, archived) {
  return apiRequest(`/admin/subjects/${id}/${archived ? 'archive' : 'unarchive'}`, { method: 'POST' });
}

export function assignLecturers(id, lecturerIds) {
  return apiRequest(`/admin/subjects/${id}/lecturers`, {
    method: 'PUT',
    body: { lecturerIds },
  });
}

export function listSubjectLecturers(id) {
  return apiRequest(`/admin/subjects/${id}/lecturers`);
}

export function listSubjectStudents(id) {
  return apiRequest(`/admin/subjects/${id}/students`);
}

export function assignStudents(id, payload) {
  const body = typeof payload === 'string'
    ? { codes: payload }
    : (payload && typeof payload === 'object' ? payload : { studentIds: payload });
  return apiRequest(`/admin/subjects/${id}/students`, {
    method: 'PUT',
    body,
  });
}

// --- exam schedule ---------------------------------------------------------

// Returns { sessions: [...] } with subject/creator info, roster size,
// interview progress and the Lambda warm-up status per session.
export function getExamMonitoring() {
  return apiRequest('/admin/exam-monitoring');
}

export function listExamSchedule({ status, subjectId, from, to } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (subjectId) params.set('subjectId', subjectId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();
  return apiRequest(`/admin/exam-schedule${query ? `?${query}` : ''}`);
}

// SCHEDULED -> OPEN. Returns { session }; 409 INVALID_TRANSITION or
// EXAM_WINDOW_PASSED.
export function startExamSession(id) {
  return apiRequest(`/admin/exam-sessions/${id}/start`, { method: 'POST' });
}

// OPEN -> CLOSED. Returns { session }.
export function closeExamSessionAsAdmin(id) {
  return apiRequest(`/admin/exam-sessions/${id}/close`, { method: 'POST' });
}

// Re-run the STT/TTS Lambda warm-up. Returns { warm_status }.
export function warmExamSession(id) {
  return apiRequest(`/admin/exam-sessions/${id}/warm`, { method: 'POST' });
}

// --- admin exam CRUD + audit log (Step 14) ---------------------------------

export function createExamSessionAsAdmin(body) {
  return apiRequest('/admin/exam-sessions', { method: 'POST', body });
}

export function deleteExamSessionAsAdmin(id) {
  return apiRequest(`/admin/exam-sessions/${id}`, { method: 'DELETE' });
}

// Returns { entries, total, page, pageSize }.
export function listAuditLog({ entityType, entityId, actorId, page, pageSize } = {}) {
  const params = new URLSearchParams();
  if (entityType) params.set('entityType', entityType);
  if (entityId) params.set('entityId', entityId);
  if (actorId) params.set('actorId', actorId);
  if (page) params.set('page', page);
  if (pageSize) params.set('pageSize', pageSize);
  const query = params.toString();
  return apiRequest(`/admin/audit-log${query ? `?${query}` : ''}`);
}
