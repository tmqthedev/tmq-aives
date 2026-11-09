import { errorMessage } from '../i18n/core';
import { apiRequest } from './authApi';
import { apiBaseUrl } from '../config/api';

// --- questions ------------------------------------------------------------

// Lists questions, optionally filtered by status / bloom / source. The backend
// reads these off req.query, so empty values are dropped from the query string.
export function listQuestions(filters = {}) {
  const params = new URLSearchParams();
  for (const key of ['status', 'bloom', 'source']) {
    const value = filters[key];
    if (value) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return apiRequest(`/questions${query ? `?${query}` : ''}`);
}

export function getQuestion(id) {
  return apiRequest(`/questions/${id}`);
}

// Create returns an envelope { question, warnings:[] }; every other call below
// returns a bare question object.
export function createQuestion(body) {
  return apiRequest('/questions', { method: 'POST', body });
}

export function updateQuestion(id, patch) {
  return apiRequest(`/questions/${id}`, { method: 'PUT', body: patch });
}

export function deleteQuestion(id) {
  return apiRequest(`/questions/${id}`, { method: 'DELETE' });
}

export function approveQuestion(id) {
  return apiRequest(`/questions/${id}/approve`, { method: 'POST' });
}

export function rejectQuestion(id, reason) {
  return apiRequest(`/questions/${id}/reject`, { method: 'POST', body: { reason } });
}

export function archiveQuestion(id) {
  return apiRequest(`/questions/${id}/archive`, { method: 'POST' });
}

// Sends the raw .xlsx bytes with the spreadsheet content type, exactly like
// adminApi.importStudents. Returns { ok, created } on success; on an invalid
// file the backend answers 422 with { ok:false, errors:[{row,errors[]}] },
// which arrives as the thrown error's `details`.
export function importQuestions(file) {
  return apiRequest('/questions/import', {
    method: 'POST',
    raw: file,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  });
}

// GET /questions/template streams an .xlsx attachment, so it is fetched as a
// binary blob (apiRequest only decodes JSON) and handed to the browser as a
// file download rather than returning parsed data.
export async function downloadTemplate() {
  const response = await fetch(`${apiBaseUrl}/questions/template`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const error = new Error(errorMessage({ status: response.status }));
    error.status = response.status;
    throw error;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'question-import-template.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}


export function getQuestionRevision(id) {
  return apiRequest(`/questions/${id}/revision`);
}

export function saveQuestionRevision(id, body) {
  return apiRequest(`/questions/${id}/revision`, { method: 'PUT', body });
}

export function publishQuestionRevision(id, body) {
  return apiRequest(`/questions/${id}/revision/publish`, { method: 'POST', body });
}

export function discardQuestionRevision(id, body) {
  return apiRequest(`/questions/${id}/revision/discard`, { method: 'POST', body });
}
