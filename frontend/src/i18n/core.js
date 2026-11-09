import vi from './vi.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export const dictionaries = { vi, en };
const storageKey = 'aives.uiLanguage';
const listeners = new Set();
let language = 'vi';
try { if (globalThis.localStorage?.getItem(storageKey) === 'en') language = 'en'; } catch { /* storage may be disabled */ }

export function getLanguage() { return language; }
export function getLocale() { return language === 'en' ? 'en-US' : 'vi-VN'; }
export function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function setLanguage(next) {
  if (!['vi', 'en'].includes(next)) return;
  language = next;
  try { globalThis.localStorage?.setItem(storageKey, next); } catch { /* still works without storage */ }
  if (globalThis.document) document.documentElement.lang = next;
  listeners.forEach(listener => listener());
}
if (globalThis.document) document.documentElement.lang = language;

export function t(key, values = {}) {
  const template = dictionaries[language][key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (match, name) => values[name] == null ? match : String(values[name]));
}

// Only UI feedback uses this function. User-authored content is rendered directly.
// It also updates feedback already displayed when the user switches language.
const feedbackPatterns = Object.keys(en).flatMap(key => ['vi', 'en'].map(lang => {
  const names = [];
  const escaped = dictionaries[lang][key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\\\{(\w+)\\\}/g, (_, name) => { names.push(name); return '([\\s\\S]*?)'; });
  return { key, names, specificity: dictionaries[lang][key].replace(/\{\w+\}/g, '').length,
    regex: new RegExp(`^${pattern}$`) };
})).filter(item => item.names.length && item.specificity >= 8).sort((a, b) => b.specificity - a.specificity);
const feedbackKeys = new Map(Object.keys(en).flatMap(key => [[en[key], key], [vi[key], key]]));
export function translateMessage(message) {
  if (message == null) return message;
  if (feedbackKeys.has(message)) return t(feedbackKeys.get(message));
  for (const { key, names, regex } of feedbackPatterns) {
    const match = regex.exec(String(message));
    if (match) return t(key, Object.fromEntries(names.map((name, i) => [name, match[i + 1]])));
  }
  return message;
}

export function formatNumber(number, options) { return new Intl.NumberFormat(getLocale(), options).format(number); }
const enums = {
  FINALIZED: 'Finalized', AI_SCORING: 'AI scoring', AI_SUGGESTED: 'AI suggested', FLAGGED: 'Flagged',
  DRAFT: 'Draft', SCHEDULED: 'Scheduled', OPEN: 'Open', CLOSED: 'Closed',
  PENDING_REVIEW: 'Pending review', APPROVED: 'Approved', REJECTED: 'Rejected', ARCHIVED: 'Archived',
  IN_PROGRESS: 'In Progress', COMPLETED: 'Completed', FAILED: 'Failed', PROCESSING: 'Processing',
  PENDING: 'Pending', READY: 'Ready', ANSWERED: 'Answered', ANSWERING: 'Answering', ASKED: 'Asked', PAUSED: 'Paused',
  ADMIN: 'Admin', LECTURER: 'Lecturer', STUDENT: 'Student', ACTIVE: 'Active', INACTIVE: 'Inactive', LOCKED: 'Locked',
  REMEMBER: 'Remember', UNDERSTAND: 'Understand', APPLY: 'Apply', ANALYZE: 'Analyze',
  MANUAL: 'Manual', IMPORT: 'Import', AI: 'AI', VI: 'Vietnamese', EN: 'English',
};
export function enumLabel(value) { return typeof value === 'string' ? t(enums[value.toUpperCase()] || value) : value; }
export function formatDate(value, options = {}) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(getLocale(), options).format(date);
}

const errorKeys = {
  REVISION_CONFLICT: 'This revision changed. Close and reopen the editor before reviewing it again.',
  QUESTION_REVISION_REQUIRED: 'Edits are saved as a pending revision. The active approved question remains available until you publish. Changes to topics and purpose require a separate question.',
  QUESTION_INCOMPLETE: 'A reference answer, key points and rubric are required before approval.',
  EMAIL_TAKEN: 'That email is already in use.', CODE_TAKEN: 'That code is already in use.',
  INVALID_CREDENTIALS: 'Invalid email/code or password.', ACCOUNT_LOCKED: 'Your account is temporarily locked. Please try again later.',
  MATERIAL_IN_USE: 'This material is cited by existing questions and cannot be deleted.',
  RESULT_FINALIZED: 'Bài thi đã chốt điểm. Mở lại bài thi để sửa.',
  STT_FAILED: 'Speech recognition failed. Please record your answer again.',
  STT_TIMEOUT: 'Speech recognition failed. Please record your answer again.',
  AUTHENTICATION_REQUIRED: 'Please sign in again.', INVALID_TOKEN: 'Please sign in again.',
  TOKEN_EXPIRED: 'Please sign in again.', UNAUTHORIZED: 'Please sign in again.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  FORBIDDEN_STUDENT_ONLY: 'You do not have permission to perform this action.',
  VALIDATION_ERROR: 'Please check the information you entered.',
  TURN_NOT_ACTIVE: 'This question is no longer awaiting an answer.',
  SUBJECT_CODE_TAKEN: 'This subject code already exists.',
  SUBJECT_IN_USE: 'This subject still has topics, materials, rubrics or exams. Archive it instead.',
  SUBJECT_ARCHIVED: 'This subject is archived. Unarchive it first.',
  DUPLICATE_DATA: 'This record already exists.',
  RESOURCE_IN_USE: 'This record is still used elsewhere and cannot be deleted.',
  RUBRIC_REQUIRED: 'A rubric must be attached before this question can be approved.',
  INVALID_TRANSITION: 'This action is not allowed in the current status.',
  NO_APPROVED_QUESTIONS: 'This topic has no approved questions yet. Approve questions first; the exam language comes from them.',
  MIXED_LANGUAGE_BANK: 'This topic mixes Vietnamese and English approved questions. An exam uses one language.',
  NOT_ENOUGH_QUESTIONS: 'Not enough approved questions for this exam configuration.',
  CODE_REQUIRED: 'A student code is required.',
  CANNOT_MODIFY_SELF: 'You cannot change or delete your own account.',
  LAST_ADMIN: 'The last active admin cannot be changed or deleted.',
  USER_IN_OPEN_EXAM: 'This user is an examiner or candidate of a scheduled or open exam.',
  RUBRIC_SUBJECT_MISMATCH: 'The rubric belongs to a different subject than the topic.',
  SESSION_IN_USE: 'Only a draft or scheduled exam that nobody has started can be deleted.',
};
export function errorMessage(error) {
  if (errorKeys[error?.code]) return t(errorKeys[error.code]);
  if (error?.status === 401) return t('Please sign in again.');
  if (error?.status === 403) return t('You do not have permission to perform this action.');
  if (error?.status >= 500) return t('The service is temporarily unavailable. Please try again.');
  return t('Could not complete the request. Please try again.');
}
