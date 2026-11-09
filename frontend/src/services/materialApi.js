import { errorMessage } from '../i18n/core';
import { apiRequest, authedFetch } from './authApi';
import { apiBaseUrl } from '../config/api';

// --- course materials -----------------------------------------------------

// List the materials of a subject. The backend scopes by the authenticated
// lecturer's subjects and returns the raw course_material rows.
export function listMaterials(subjectId) {
  const query = subjectId ? `?subjectId=${encodeURIComponent(subjectId)}` : '';
  return apiRequest(`/materials${query}`);
}

// Upload is multipart/form-data, so it bypasses apiRequest (which only speaks
// JSON) and posts a FormData body with a direct fetch. We must NOT set an
// explicit Content-Type: the browser adds the multipart boundary itself.
// Mirrors the backend MaterialService contract: file + subjectId (+ optional
// topicId/title).
export async function uploadMaterial({ file, subjectId, topicId, title }) {
  const form = new FormData();
  form.append('file', file);
  form.append('subjectId', String(subjectId));
  if (topicId !== undefined && topicId !== null && topicId !== '') {
    form.append('topicId', String(topicId));
  }
  if (title) {
    form.append('title', title);
  }

  const response = await authedFetch(`${apiBaseUrl}/materials`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(errorMessage({ code: data.code, status: response.status }));
    error.status = response.status;
    error.code = data.code;
    error.details = data;
    throw error;
  }
  return data;
}

export function deleteMaterial(id) {
  return apiRequest(`/materials/${id}`, { method: 'DELETE' });
}

// Topics are fetched from the shared /topics endpoint and filtered client-side
// by subject_id (there is no per-subject topics route).
export function listTopics() {
  return apiRequest('/topics');
}
