import { errorMessage } from '../i18n/core';
import { apiBaseUrl } from '../config/api';

// Endpoints that must not trigger a silent refresh: a 401 from them is the
// real answer (bad credentials, no session, expired link).
const NO_REFRESH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/forgot-password',
  '/auth/reset-password', '/auth/set-password'];

let refreshInFlight = null;

// The access cookie lives 15 minutes and the refresh cookie 7 days. Refresh
// tokens rotate and a replayed one is refused, so concurrent 401s share a
// single refresh call. Resolves true when a new access cookie was issued.
export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${apiBaseUrl}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// fetch with the auth cookies that, on a 401, refreshes the session once and
// retries. Use it for every API call so long sessions (a demo, an exam, a
// grading pass) do not silently lose their access token.
export async function authedFetch(url, init = {}) {
  const request = { ...init, credentials: 'include' };
  const response = await fetch(url, request);
  const path = url.startsWith(apiBaseUrl) ? url.slice(apiBaseUrl.length) : url.replace(/^\/api/, '');
  if (response.status !== 401 || NO_REFRESH_PATHS.some((p) => path.startsWith(p))) {
    return response;
  }
  if (!(await refreshSession())) {
    return response;
  }
  return fetch(url, request);
}

// Thin fetch wrapper that always sends the httpOnly auth cookies and the
// Origin header (required by the backend CSRF check). Throws an Error whose
// `code` and `details` carry the backend error shape when available.
export async function apiRequest(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const init = {
    method,
    headers: { ...headers },
  };

  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await authedFetch(`${apiBaseUrl}${path}`, init);

  if (response.status === 204) {
    return null;
  }

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

// --- auth endpoints -------------------------------------------------------

export function getMe() {
  return apiRequest('/auth/me');
}

export function postLogin(identifier, password) {
  return apiRequest('/auth/login', { method: 'POST', body: { identifier, password } });
}

export function postLogout() {
  return apiRequest('/auth/logout', { method: 'POST' });
}

export function postRefresh() {
  return apiRequest('/auth/refresh', { method: 'POST' });
}

export function postForgotPassword(identifier) {
  return apiRequest('/auth/forgot-password', { method: 'POST', body: { identifier } });
}

export function postResetPassword(token, password) {
  return apiRequest('/auth/reset-password', { method: 'POST', body: { token, password } });
}

export function postSetPassword(token, password) {
  return apiRequest('/auth/set-password', { method: 'POST', body: { token, password } });
}

export function putChangePassword(currentPassword, newPassword) {
  return apiRequest('/auth/password', { method: 'PUT', body: { currentPassword, newPassword } });
}
