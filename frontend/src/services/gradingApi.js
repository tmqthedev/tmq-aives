import { errorMessage } from '../i18n/core';
import { authedFetch } from './authApi';
// API client for lecturer examination review and AI grading (Step 8).

async function handleResponse(res) {
  if (!res.ok) {
    let errorData = {};
    try {
      errorData = await res.json();
    } catch {
      // Non-JSON error
    }
    const error = new Error(errorMessage({ code: errorData.code, status: res.status }));
    error.status = res.status;
    error.statusCode = res.status;
    error.code = errorData.code;
    throw error;
  }
  return res.json();
}

/**
 * List all viva results for an exam session.
 */
export async function listSessionResults(sessionId) {
  const res = await authedFetch(`/api/exam-sessions/${sessionId}/results`, {
    credentials: 'include',
  });
  return handleResponse(res);
}

/**
 * Get detailed evaluation breakdown for a single viva result.
 */
export async function getResultDetail(resultId) {
  const res = await authedFetch(`/api/results/${resultId}`, {
    credentials: 'include',
  });
  return handleResponse(res);
}

/**
 * Adjust score on a specific criterion with a required reason.
 */
export async function adjustCriterionScore(criterionScoreId, { score, reason }) {
  const res = await authedFetch(`/api/criterion-scores/${criterionScoreId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ score: Number(score), reason: String(reason || '') }),
  });
  return handleResponse(res);
}

/**
 * Finalize viva examination result score.
 */
export async function finalizeResult(resultId) {
  const res = await authedFetch(`/api/results/${resultId}/finalize`, {
    method: 'POST',
    credentials: 'include',
  });
  return handleResponse(res);
}

/**
 * Reopen a finalized viva examination result for review.
 */
export async function reopenResult(resultId) {
  const res = await authedFetch(`/api/results/${resultId}/reopen`, {
    method: 'POST',
    credentials: 'include',
  });
  return handleResponse(res);
}

/**
 * Request background regrading via AI.
 */
export async function regradeResult(resultId) {
  const res = await authedFetch(`/api/results/${resultId}/regrade`, {
    method: 'POST',
    credentials: 'include',
  });
  return handleResponse(res);
}

/**
 * Get audio recording playback URL for a student turn.
 */
export function getTurnAudioUrl(turnId) {
  return `/api/turns/${turnId}/audio`;
}
