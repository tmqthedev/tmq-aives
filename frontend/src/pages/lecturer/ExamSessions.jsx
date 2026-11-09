import { t, useLocale, enumLabel, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback } from 'react';
import WorkflowNext from '../../shared/components/WorkflowNext';
import { Plus, Send, Undo2, Square, Pencil, Users as UsersIcon } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Table, Thead, Tbody, Tr, Th, Td } from '../../components/ui/Table';
import { Feedback } from '../../components/ui/Feedback';
import {
  listExamSessions,
  getExamSessionOptions,
  getExamSession,
  createExamSession,
  updateExamSession,
  setExamStudents,
  setExamExaminers,
  scheduleExamSession,
  unscheduleExamSession,
  closeExamSession,
  getExamMonitoring,
} from '../../services/examSessionApi';
import { formatDateTime, toDateTimeLocal, fromDateTimeLocal } from '../../shared/utils/formatDate';
import { subscribeBusinessEvents } from '../../services/businessSocket';
import { useExamCounts } from '../../hooks/useExamCounts';
import ExamCounts from '../../components/ExamCounts';

const BLOOM_LEVELS = ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE'];
const BLOOM_LABELS = {
  REMEMBER: 'Remember',
  UNDERSTAND: 'Understand',
  APPLY: 'Apply',
  ANALYZE: 'Analyze',
};

const EMPTY_BLOOM = { REMEMBER: '', UNDERSTAND: '', APPLY: '', ANALYZE: '' };

// Nhom-3 config defaults, mirrored from the backend's createSession defaults.
const DEFAULT_CONFIG = {
  main_question_count: 3,
  max_follow_ups_per_question: 2,
  answer_time_limit_sec: 120,
  think_time_sec: 0,
  // Total interview time, entered in minutes and sent as seconds (backend
  // default 1800 s, range 60-14400 s).
  session_time_limit_min: 30,
  // Exam window as local datetime-local values; optional for a draft but
  // required before the session can be submitted for scheduling.
  opens_at: '',
  closes_at: '',
  // Blank = no limit on follow-ups across the whole interview.
  max_follow_ups_total: '',
  // All blank = the backend balances Bloom levels automatically.
  bloom: EMPTY_BLOOM,
};

const STATUS_BADGE = {
  DRAFT: 'info',
  SCHEDULED: 'warning',
  OPEN: 'success',
  CLOSED: 'neutral',
};


function bloomIsBlank(bloom) {
  return BLOOM_LEVELS.every((level) => String(bloom[level] ?? '').trim() === '');
}

function bloomSum(bloom) {
  return BLOOM_LEVELS.reduce((sum, level) => sum + (Number(bloom[level]) || 0), 0);
}

// Map an exam session row back into the form's config shape (for editing).
// Check whether a topic has enough approved questions in total and per Bloom level
function getTopicShortages(topic, formConfig) {
  if (!topic) return null;
  const required = Number(formConfig?.main_question_count) || 3;
  const available = topic.approved || 0;
  const byBloom = topic.byBloom || {};

  const shortages = [];
  if (available < required) {
    shortages.push(t("Total approved: {v0}/{v1}", {v0: available, v1: required}));
  }

  if (formConfig?.bloom && typeof formConfig.bloom === 'object') {
    for (const [level, rawVal] of Object.entries(formConfig.bloom)) {
      const needed = Number(rawVal) || 0;
      if (needed > 0) {
        const has = byBloom[level] || 0;
        if (has < needed) {
          const label = enumLabel(BLOOM_LABELS[level] || level);
          shortages.push(t("{v0}: {v1}/{v2}", {v0: label, v1: has, v2: needed}));
        }
      }
    }
  }

  return shortages.length > 0 ? shortages : null;
}

function sessionToConfig(session) {
  const dist = session.bloom_distribution;
  return {
    main_question_count: session.main_question_count ?? DEFAULT_CONFIG.main_question_count,
    max_follow_ups_per_question: session.max_follow_ups_per_question ?? DEFAULT_CONFIG.max_follow_ups_per_question,
    answer_time_limit_sec: session.answer_time_limit_sec ?? DEFAULT_CONFIG.answer_time_limit_sec,
    think_time_sec: session.think_time_sec ?? DEFAULT_CONFIG.think_time_sec,
    session_time_limit_min: session.session_time_limit_sec != null
      ? Math.round(session.session_time_limit_sec / 60)
      : DEFAULT_CONFIG.session_time_limit_min,
    opens_at: toDateTimeLocal(session.opens_at),
    closes_at: toDateTimeLocal(session.closes_at),
    max_follow_ups_total: session.max_follow_ups_total ?? '',
    bloom: dist
      ? Object.fromEntries(BLOOM_LEVELS.map((level) => [level, dist[level] ?? 0]))
      : EMPTY_BLOOM,
  };
}

// Validate the config locally; returns an error message or ''.
function validateConfig(config) {
  if (config.opens_at && config.closes_at
    && new Date(config.opens_at).getTime() >= new Date(config.closes_at).getTime()) {
    return t("\"Closes at\" must be after \"Opens at\".");
  }
  if (!bloomIsBlank(config.bloom) && bloomSum(config.bloom) !== Number(config.main_question_count)) {
    return t("The Bloom mix must add up to {v0} main questions (currently {v1}).", {v0: config.main_question_count, v1: bloomSum(config.bloom)});
  }
  return '';
}

// Build the snake_case config fields shared by create and update.
function configToPayload(config) {
  const followUpsTotal = String(config.max_follow_ups_total ?? '').trim();
  return {
    main_question_count: Number(config.main_question_count),
    max_follow_ups_per_question: Number(config.max_follow_ups_per_question),
    answer_time_limit_sec: Number(config.answer_time_limit_sec),
    think_time_sec: Number(config.think_time_sec),
    session_time_limit_sec: Number(config.session_time_limit_min) * 60,
    opens_at: fromDateTimeLocal(config.opens_at),
    closes_at: fromDateTimeLocal(config.closes_at),
    max_follow_ups_total: followUpsTotal === '' ? null : Number(followUpsTotal),
    bloom_distribution: bloomIsBlank(config.bloom)
      ? null
      : Object.fromEntries(BLOOM_LEVELS.map((level) => [level, Number(config.bloom[level]) || 0])),
  };
}

// Render the NOT_ENOUGH_QUESTIONS details ({ required, available, byLevel }).
// byLevel entries may be plain counts or { required, available } objects.
function describeShortage(details) {
  if (!details) return '';
  const parts = [];
  if (details.required != null && details.available != null) {
    parts.push(t("{v0} of {v1} approved questions available", {v0: details.available, v1: details.required}));
  }
  if (details.byLevel && typeof details.byLevel === 'object') {
    const levels = Object.entries(details.byLevel).map(([level, value]) => {
      const label = enumLabel(BLOOM_LABELS[level] || level);
      if (value && typeof value === 'object') {
        return t("{v0}: {v1}/{v2}", {v0: label, v1: value.available ?? 0, v2: value.required ?? 0});
      }
      return t("{v0}: {v1}", {v0: label, v1: value});
    });
    if (levels.length > 0) parts.push(t("by level: {v0}", {v0: levels.join(', ')}));
  }
  return parts.join('; ');
}

function friendlyError(err, fallback) {
  switch (err?.code) {
    case 'NOT_ENOUGH_QUESTIONS': {
      const detail = describeShortage(err.details);
      return t("Not enough approved questions in the topic for this configuration{v0}.", {v0: detail ? ` (${detail})` : ''});
    }
    case 'EXAM_WINDOW_PASSED':
      return t("The exam window has already passed. Edit the window and submit again.");
    case 'INVALID_TRANSITION':
      return t("This action is not allowed from the session's current status.");
    case 'FORBIDDEN':
      return t("You do not have access to this subject.");
    case 'VALIDATION_ERROR':
      return err.message
        ? t("Please check the session settings: {v0}", {v0: err.message})
        : t("Please check the session settings.");
    default:
      return fallback;
  }
}

function languageLabel(language) {
  if (language === 'VI') return t("Vietnamese");
  if (language === 'EN') return t("English");
  return '—';
}

// What the lecturer still has to do for a session, in order. Admin starts it.
function SessionChecklist({ session }) {
  const students = (session.students || []).length;
  const examiners = (session.examiners || []).length;
  const scheduled = ['SCHEDULED', 'OPEN', 'CLOSED'].includes(session.status);
  const steps = [
    { done: Boolean(session.opens_at && session.closes_at), label: t("Set the exam window (Edit settings → opens / closes)") },
    { done: students > 0, label: t("Add candidates to the roster ({v0} added)", { v0: students }) },
    { done: examiners > 0, label: t("Assign examiners who will grade ({v0} assigned)", { v0: examiners }) },
    { done: scheduled, label: t("Submit schedule (checks there are enough approved questions)") },
    { done: ['OPEN', 'CLOSED'].includes(session.status), label: t("Wait for an admin to start the exam during its window") },
    { done: session.status === 'CLOSED', label: t("After the exam, grade the results in Results & grading") },
  ];
  const nextIndex = steps.findIndex((step) => !step.done);
  return (
    <ol style={{ margin: '0 0 1rem', paddingLeft: '1.25rem', fontSize: '0.875rem', lineHeight: 1.7 }}>
      {steps.map((step, index) => (
        <li
          key={step.label}
          style={{
            color: step.done ? 'var(--success, #1c5c4a)' : (index === nextIndex ? 'inherit' : 'var(--text-muted)'),
            fontWeight: index === nextIndex ? 600 : 400,
          }}
        >
          {step.done ? '✓ ' : ''}{step.label}{index === nextIndex ? ` ← ${t("next")}` : ''}
        </li>
      ))}
    </ol>
  );
}

function formatBloom(dist) {
  if (!dist) return t("Balanced");
  return BLOOM_LEVELS.map((level) => t("{v0} {v1}", {v0: enumLabel(BLOOM_LABELS[level]), v1: dist[level] ?? 0})).join(', ');
}

// Config inputs shared by the create and edit forms.
function SessionConfigFields({ config, onChange }) {
  useLocale();
  const blank = bloomIsBlank(config.bloom);
  const sum = bloomSum(config.bloom);
  const sumOk = blank || sum === Number(config.main_question_count);

  const setBloom = (level, value) => onChange('bloom', { ...config.bloom, [level]: value });

  return (
    <>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Input
          label={t("Opens at")}
          type="datetime-local"
          value={config.opens_at}
          onChange={(e) => onChange('opens_at', e.target.value)}
        />
        <Input
          label={t("Closes at")}
          type="datetime-local"
          value={config.closes_at}
          onChange={(e) => onChange('closes_at', e.target.value)}
        />
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: 0 }}>{t("The exam window is optional for a draft but required before you submit the schedule.")}</p>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Input
          label={t("Main questions")}
          type="number"
          min={1}
          max={10}
          value={config.main_question_count}
          onChange={(e) => onChange('main_question_count', e.target.value)}
        />
        <Input
          label={t("Max follow-ups / question")}
          type="number"
          min={0}
          max={5}
          value={config.max_follow_ups_per_question}
          onChange={(e) => onChange('max_follow_ups_per_question', e.target.value)}
        />
        <Input
          label={t("Max follow-ups per candidate")}
          type="number"
          min={0}
          max={20}
          value={config.max_follow_ups_total}
          placeholder={t("No limit")}
          onChange={(e) => onChange('max_follow_ups_total', e.target.value)}
        />
        <Input
          label={t("Answer time limit (sec)")}
          type="number"
          min={10}
          max={600}
          value={config.answer_time_limit_sec}
          onChange={(e) => onChange('answer_time_limit_sec', e.target.value)}
        />
        <Input
          label={t("Think time (sec)")}
          type="number"
          min={0}
          max={300}
          value={config.think_time_sec}
          onChange={(e) => onChange('think_time_sec', e.target.value)}
        />
        <Input
          label={t("Session time limit (min)")}
          type="number"
          min={1}
          max={240}
          value={config.session_time_limit_min}
          onChange={(e) => onChange('session_time_limit_min', e.target.value)}
        />
      </div>

      <div style={{ marginTop: '0.5rem' }}>
        <div className="form-label">{t("Bloom mix (optional)")}</div>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {BLOOM_LEVELS.map((level) => (
            <Input
              key={level}
              label={enumLabel(BLOOM_LABELS[level])}
              type="number"
              min={0}
              max={10}
              value={config.bloom[level]}
              placeholder="—"
              onChange={(e) => setBloom(level, e.target.value)}
            />
          ))}
        </div>
        <p
          style={{
            fontSize: '0.875rem',
            marginTop: 0,
            color: sumOk ? 'var(--text-muted)' : 'var(--accent)',
          }}
        >
          {blank
            ? t("Leave blank to balance Bloom levels automatically.")
            : t("Total {v0} of {v1} main questions{v2}.", {v0: sum, v1: config.main_question_count, v2: sumOk ? '' : ' — must match'})}
        </p>
      </div>
    </>
  );
}

export default function LecturerExamSessions() {
  useLocale();
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Create form state.
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [topicId, setTopicId] = useState('');
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [creating, setCreating] = useState(false);

  // Form options: in-scope subjects, topics with approved/bloom counts, students and lecturers.
  const [options, setOptions] = useState({ subjects: [] });

  // Selected session + roster/examiner editing state.
  const [selected, setSelected] = useState(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState([]);
  const [studentSearch, setStudentSearch] = useState('');
  const [rosterErrors, setRosterErrors] = useState([]);
  const [savingRoster, setSavingRoster] = useState(false);

  const [selectedExaminerIds, setSelectedExaminerIds] = useState([]);
  const [examinerSearch, setExaminerSearch] = useState('');
  const [savingExaminers, setSavingExaminers] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  // Edit form state for a DRAFT session.
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editConfig, setEditConfig] = useState(DEFAULT_CONFIG);
  const [savingEdit, setSavingEdit] = useState(false);

  const subjects = options.subjects || [];
  const currentSubject = subjects.find((s) => String(s.subject_id) === String(subjectId));
  const topicsForSubject = currentSubject ? currentSubject.topics : [];
  const selectedTopic = topicsForSubject.find((t) => String(t.topic_id) === String(topicId));

  const loadOptions = useCallback(async () => {
    try {
      const data = await getExamSessionOptions();
      setOptions(data || { subjects: [] });
    } catch {
      setError(t("Could not load subject options."));
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await listExamSessions();
      setSessions(Array.isArray(data) ? data : []);
    } catch {
      setError(t("Could not load exam sessions."));
    }
  }, []);

  useEffect(() => {
    loadOptions();
    loadSessions();
  }, [loadOptions, loadSessions]);

  useEffect(() => subscribeBusinessEvents(() => {
    loadOptions();
    loadSessions();
  }), [loadOptions, loadSessions]);
  const examCounts = useExamCounts(getExamMonitoring);

  const resetCreateForm = () => {
    setTitle('');
    setSubjectId('');
    setTopicId('');
    setConfig(DEFAULT_CONFIG);
  };

  const handleConfigChange = (field, value) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  const handleEditConfigChange = (field, value) => {
    setEditConfig((prev) => ({ ...prev, [field]: value }));
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!subjectId || !topicId) {
      setError(t("Choose a subject and topic before creating a session."));
      return;
    }
    const invalid = validateConfig(config);
    if (invalid) {
      setError(invalid);
      return;
    }
    setCreating(true);
    try {
      await createExamSession({
        subjectId: Number(subjectId),
        topicId: Number(topicId),
        title: title.trim() || undefined,
        ...configToPayload(config),
      });
      setNotice(t("Exam session created as a draft."));
      resetCreateForm();
      await loadSessions();
    } catch (err) {
      setError(friendlyError(err, t("Could not create the exam session.")));
    } finally {
      setCreating(false);
    }
  };

  const openDetails = async (session) => {
    setError('');
    setNotice('');
    setRosterErrors([]);
    setEditing(false);
    try {
      const full = await getExamSession(session.exam_session_id);
      setSelected(full);
      setSelectedStudentIds((full?.students || []).map((s) => s.student_id));
      setSelectedExaminerIds((full?.examiners || []).map((e) => e.lecturer_id));
      setRosterErrors([]);
    } catch {
      setError(t("Could not load the session details."));
    }
  };

  // Re-fetch the selected session without clearing the notice/error.
  const refreshSelected = async (session) => {
    try {
      const full = await getExamSession(session.exam_session_id);
      setSelected(full);
      setSelectedStudentIds((full?.students || []).map((s) => s.student_id));
      setSelectedExaminerIds((full?.examiners || []).map((e) => e.lecturer_id));
    } catch {
      setError(t("Could not load the session details."));
    }
  };

  const startEdit = () => {
    if (!selected) return;
    setEditTitle(selected.title || '');
    setEditConfig(sessionToConfig(selected));
    setEditing(true);
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!selected) return;
    setError('');
    setNotice('');
    const invalid = validateConfig(editConfig);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSavingEdit(true);
    try {
      await updateExamSession(selected.exam_session_id, {
        title: editTitle.trim() || undefined,
        ...configToPayload(editConfig),
      });
      setNotice(t("Session settings saved."));
      setEditing(false);
      await refreshSelected(selected);
      await loadSessions();
    } catch (err) {
      setError(friendlyError(err, t("Could not save the session settings.")));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSaveRoster = async () => {
    if (!selected) return;
    setError('');
    setNotice('');
    setRosterErrors([]);
    setSavingRoster(true);
    try {
      const result = await setExamStudents(selected.exam_session_id, { studentIds: selectedStudentIds });
      setNotice(t("Roster saved ({v0} students).", {v0: result.students?.length ?? 0}));
      await refreshSelected(selected);
      await loadSessions();
    } catch (err) {
      if (err.status === 422 && Array.isArray(err.details?.errors)) {
        setRosterErrors(err.details.errors);
        setError(t("Some students are invalid or not enrolled. No roster was saved."));
      } else {
        setError(err.message || t("Could not save the roster."));
      }
    } finally {
      setSavingRoster(false);
    }
  };

  const handleSaveExaminers = async () => {
    if (!selected) return;
    setError('');
    setNotice('');
    if (selectedExaminerIds.length === 0) {
      setError(t("Select at least one examiner."));
      return;
    }
    setSavingExaminers(true);
    try {
      await setExamExaminers(selected.exam_session_id, selectedExaminerIds);
      setNotice(t("Examiners saved."));
      await refreshSelected(selected);
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') {
        setError(t("Each examiner must be assigned to this subject."));
      } else {
        setError(err.message || t("Could not save the examiners."));
      }
    } finally {
      setSavingExaminers(false);
    }
  };

  const runTransition = async (action, successMessage, fallback) => {
    if (!selected) return;
    setError('');
    setNotice('');
    setTransitioning(true);
    try {
      await action(selected.exam_session_id);
      setNotice(successMessage);
      setEditing(false);
      await refreshSelected(selected);
      await loadSessions();
    } catch (err) {
      setError(friendlyError(err, fallback));
    } finally {
      setTransitioning(false);
    }
  };

  const handleSchedule = () => {
    if (!selected) return;
    if (!selected.opens_at || !selected.closes_at) {
      setNotice('');
      setError(t("Set \"Opens at\" and \"Closes at\" (Edit settings) before submitting the schedule."));
      return;
    }
    runTransition(
      scheduleExamSession,
      t("Schedule submitted. An admin will start the exam during its window."),
      t("Could not submit the schedule."),
    );
  };

  const handleUnschedule = () => runTransition(
    unscheduleExamSession,
    t("Schedule withdrawn. The session is a draft again."),
    t("Could not withdraw the schedule."),
  );

  const handleClose = () => runTransition(
    closeExamSession,
    t("Session closed."),
    t("Could not close the session."),
  );

  return (
    <div className="animate-fade-in">
      <WorkflowNext step={6} done={sessions.some((s) => ['SCHEDULED', 'OPEN', 'CLOSED'].includes(s.status))} />
      <div style={{ marginBottom: '2rem' }}>
        <h2>{t("New Exam Session")}</h2>
        <p style={{ color: 'var(--text-muted)' }}>{t("Create a viva session, build its roster, assign examiners, and submit its schedule. An admin starts the exam.")}</p>
      </div>

      {notice && <Feedback type="success" message={translateMessage(notice)} />}
      {error && <Feedback type="error" message={translateMessage(error)} />}

      <Card>
        <CardHeader>
          <h3 style={{ margin: 0 }}>{t("Create session")}</h3>
        </CardHeader>
        <CardBody>
          <form onSubmit={handleCreate}>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Input
                label={t("Title")}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("Optional title")}
              />
              <div className="form-group">
                <label className="form-label">{t("Subject")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
                <select
                  className="form-select"
                  required
                  value={subjectId}
                  onChange={(e) => { setSubjectId(e.target.value); setTopicId(''); }}
                >
                  <option value="">{t("Select a subject")}</option>
                  {subjects.map((s) => (
                    <option key={s.subject_id} value={s.subject_id}>{s.code} – {s.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">{t("Topic")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
                <select
                  className="form-select"
                  required
                  value={topicId}
                  onChange={(e) => setTopicId(e.target.value)}
                  disabled={!subjectId}
                >
                  <option value="">{t("Select a topic")}</option>
                  {topicsForSubject.map((topicOption) => (
                    <option key={topicOption.topic_id} value={topicOption.topic_id}>
                      {topicOption.name} ({topicOption.approved} {t("approved)")}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">{t("Language")}</label>
                <div className="form-input" style={{ background: 'var(--bg-secondary)' }} title={t("Set by the language of the topic's approved questions")}>
                  {selectedTopic ? languageLabel(selectedTopic.language) : '—'}
                </div>
              </div>
            </div>

            {selectedTopic && (
              <div style={{ marginTop: '0.75rem', marginBottom: '0.75rem', padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '0.875rem' }}>
                <div>
                  <strong>{t("Topic bank:")}</strong> {selectedTopic.approved} {t("approved questions")}{selectedTopic.byBloom && Object.keys(selectedTopic.byBloom).length > 0 && (
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                      ({Object.entries(selectedTopic.byBloom).map(([lvl, cnt]) => t("{v0}: {v1}", {v0: enumLabel(BLOOM_LABELS[lvl] || lvl), v1: cnt})).join(', ')})
                    </span>
                  )}
                </div>
                {(() => {
                  const shortages = getTopicShortages(selectedTopic, config);
                  return shortages ? (
                    <div style={{ color: 'var(--accent)', marginTop: '0.35rem', fontWeight: 500 }}>{t("⚠️ Warning: This topic has question shortages for this configuration (")}{shortages.join('; ')}{t("). Scheduling will be rejected until enough questions are approved.")}</div>
                  ) : null;
                })()}
              </div>
            )}

            {selectedTopic && !selectedTopic.language && (
              <Feedback
                type="error"
                message={selectedTopic.approved > 0
                  ? t("This topic mixes Vietnamese ({v0}) and English ({v1}) approved questions. An exam uses one language: archive or move the questions of the other language first.", { v0: selectedTopic.languageCounts?.VI ?? 0, v1: selectedTopic.languageCounts?.EN ?? 0 })
                  : t("This topic has no approved questions yet. Approve questions first; the exam language comes from them.")}
              />
            )}

            <SessionConfigFields config={config} onChange={handleConfigChange} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <Button type="submit" variant="primary" icon={<Plus size={16} />} isLoading={creating} disabled={!selectedTopic || !selectedTopic.language}>{t("Create session")}</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card style={{ marginTop: '1.5rem' }}>
        <CardHeader>
          <h3 style={{ margin: 0 }}>{t("Your exam sessions")}</h3>
        </CardHeader>
        <CardBody>
          <Table>
            <Thead>
              <Tr>
                <Th>{t("Title")}</Th>
                <Th>{t("Topic")}</Th>
                <Th>{t("Language")}</Th>
                <Th>{t("Window")}</Th>
                <Th>{t("Config")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Students taking the exam")}</Th>
                <Th style={{ textAlign: 'right' }}>{t("Actions")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {sessions.length === 0 && (
                <Tr>
                  <Td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t("No exam sessions yet.")}</Td>
                </Tr>
              )}
              {sessions.map((s) => (
                <Tr key={s.exam_session_id}>
                  <Td>{s.title || t("Session {v0}", {v0: s.exam_session_id})}</Td>
                  <Td>{t("Topic")} {s.topic_id}</Td>
                  <Td>{s.language}</Td>
                  <Td>
                    {s.opens_at || s.closes_at ? (
                      <>
                        <div>{formatDateTime(s.opens_at, '—')}</div>
                        <div style={{ color: 'var(--text-muted)' }}>{t("to")} {formatDateTime(s.closes_at, '—')}</div>
                      </>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>{t("Not set")}</span>
                    )}
                  </Td>
                  <Td>
                    {s.main_question_count}/{s.max_follow_ups_per_question}/{s.answer_time_limit_sec}/{s.think_time_sec}
                    {s.session_time_limit_sec != null && t(" · {v0} min", {v0: Math.round(s.session_time_limit_sec / 60)})}
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t("Follow-ups total:")} {s.max_follow_ups_total ?? t("no limit")} {t("· Bloom:")} {formatBloom(s.bloom_distribution)}
                    </div>
                  </Td>
                  <Td>
                    <Badge type={STATUS_BADGE[s.status] || 'info'}>{enumLabel(s.status)}</Badge>
                  </Td>
                  <Td><ExamCounts counts={examCounts[s.exam_session_id]} /></Td>
                  <Td style={{ textAlign: 'right' }}>
                    <Button variant="secondary" icon={<UsersIcon size={16} />} onClick={() => openDetails(s)}>{t("Manage")}</Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </CardBody>
      </Card>

      {selected && (
        <Card style={{ marginTop: '1.5rem' }}>
          <CardHeader>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>
                {selected.title || t("Session {v0}", {v0: selected.exam_session_id})}{' '}
                <Badge type={STATUS_BADGE[selected.status] || 'info'}>{selected.status}</Badge>
              </h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {selected.status === 'DRAFT' && (
                  <>
                    <Button
                      variant="secondary"
                      icon={<Pencil size={16} />}
                      onClick={() => (editing ? setEditing(false) : startEdit())}
                    >
                      {editing ? t("Cancel edit") : t("Edit settings")}
                    </Button>
                    <Button
                      variant="primary"
                      icon={<Send size={16} />}
                      onClick={handleSchedule}
                      isLoading={transitioning}
                    >{t("Submit schedule")}</Button>
                  </>
                )}
                {selected.status === 'SCHEDULED' && (
                  <Button
                    variant="secondary"
                    icon={<Undo2 size={16} />}
                    onClick={handleUnschedule}
                    isLoading={transitioning}
                  >{t("Withdraw")}</Button>
                )}
                {selected.status === 'OPEN' && (
                  <Button
                    variant="secondary"
                    icon={<Square size={16} />}
                    onClick={handleClose}
                    isLoading={transitioning}
                  >{t("Close")}</Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <SessionChecklist session={selected} />
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: 0 }}>{t("Language:")} {languageLabel(selected.language)}{' · '}{t("Window:")} {formatDateTime(selected.opens_at)} {t("to")} {formatDateTime(selected.closes_at)}
              {' · '}{t("Follow-ups per candidate:")} {selected.max_follow_ups_total ?? t("no limit")}
              {' · '}{t("Bloom mix:")} {formatBloom(selected.bloom_distribution)}
            </p>
            {selected.status === 'DRAFT' && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t("Lecturers do not open exams. Submit the schedule and an admin will start the exam during its window.")}</p>
            )}
            {selected.status === 'SCHEDULED' && (
              <Feedback
                type="info"
                message={t("Scheduled. An admin will start this exam during its window. Withdraw it to make changes.")}
              />
            )}

            {editing && selected.status === 'DRAFT' && (
              <form onSubmit={handleSaveEdit} style={{ marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Input
                    label={t("Title")}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder={t("Optional title")}
                  />
                </div>
                <SessionConfigFields config={editConfig} onChange={handleEditConfigChange} />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
                  <Button type="button" variant="secondary" onClick={() => setEditing(false)}>{t("Cancel")}</Button>
                  <Button type="submit" variant="primary" isLoading={savingEdit}>{t("Save settings")}</Button>
                </div>
              </form>
            )}

            {(() => {
              const sessionSubject = subjects.find((s) => Number(s.subject_id) === Number(selected.subject_id));
              const enrolledStudents = sessionSubject?.students || [];
              const enrolledIds = new Set(enrolledStudents.map((s) => s.app_user_id));

              // C2: Merge students currently in roster who may not be enrolled in subject_student
              const unenrolledInRoster = (selected.students || [])
                .filter((s) => !enrolledIds.has(s.student_id))
                .map((s) => ({
                  app_user_id: s.student_id,
                  code: s.code,
                  full_name: s.full_name,
                  isUnenrolled: true,
                }));

              const availableStudents = [...enrolledStudents, ...unenrolledInRoster];
              const availableLecturers = sessionSubject?.lecturers || [];

              const filteredStudents = availableStudents.filter((s) => {
                const term = studentSearch.trim().toLowerCase();
                if (!term) return true;
                return (s.code && s.code.toLowerCase().includes(term)) || (s.full_name && s.full_name.toLowerCase().includes(term));
              });

              const filteredLecturers = availableLecturers.filter((l) => {
                const term = examinerSearch.trim().toLowerCase();
                if (!term) return true;
                return (l.code && l.code.toLowerCase().includes(term)) || (l.full_name && l.full_name.toLowerCase().includes(term));
              });

              const isDraft = selected.status === 'DRAFT';

              const toggleStudent = (id) => {
                if (!isDraft) return;
                setSelectedStudentIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                );
              };

              const selectAllFilteredStudents = () => {
                if (!isDraft) return;
                const idsToAdd = filteredStudents.map((s) => s.app_user_id);
                setSelectedStudentIds((prev) => Array.from(new Set([...prev, ...idsToAdd])));
              };

              const deselectAllStudents = () => {
                if (!isDraft) return;
                setSelectedStudentIds([]);
              };

              const toggleExaminer = (id) => {
                if (!isDraft) return;
                setSelectedExaminerIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                );
              };

              const selectAllFilteredLecturers = () => {
                if (!isDraft) return;
                const idsToAdd = filteredLecturers.map((l) => l.app_user_id);
                setSelectedExaminerIds((prev) => Array.from(new Set([...prev, ...idsToAdd])));
              };

              const deselectAllExaminers = () => {
                if (!isDraft) return;
                setSelectedExaminerIds([]);
              };

              return (
                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                  {/* Students Roster Panel */}
                  <div style={{ flex: 1, minWidth: '320px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <h4 style={{ margin: 0 }}>{t("Student Roster (")}{selectedStudentIds.length}/{availableStudents.length})</h4>
                      {isDraft && (
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={selectAllFilteredStudents}
                            title={t("Select all matching")}
                          >{t("Select all")}</button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={deselectAllStudents}
                            title={t("Deselect all")}
                          >{t("Deselect all")}</button>
                        </div>
                      )}
                    </div>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <Input
                        placeholder={t("Search student code or name...")}
                        value={studentSearch}
                        onChange={(e) => setStudentSearch(e.target.value)}
                        disabled={!isDraft}
                      />
                    </div>
                    <div style={{ maxHeight: '280px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px' }}>
                      {filteredStudents.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)', padding: '1rem', textAlign: 'center', margin: 0 }}>
                          {availableStudents.length === 0 ? t("No students enrolled in this subject. Admin must enroll students first.") : t("No matching students.")}
                        </p>
                      ) : (
                        <Table>
                          <Thead>
                            <Tr>
                              <Th style={{ width: '40px' }}></Th>
                              <Th>{t("Code")}</Th>
                              <Th>{t("Name")}</Th>
                            </Tr>
                          </Thead>
                          <Tbody>
                            {filteredStudents.map((stu) => (
                              <Tr key={stu.app_user_id} onClick={() => toggleStudent(stu.app_user_id)} style={{ cursor: isDraft ? 'pointer' : 'default' }}>
                                <Td>
                                  <input
                                    type="checkbox"
                                    checked={selectedStudentIds.includes(stu.app_user_id)}
                                    onChange={() => toggleStudent(stu.app_user_id)}
                                    onClick={(e) => e.stopPropagation()}
                                    disabled={!isDraft}
                                  />
                                </Td>
                                <Td>
                                  <strong>{stu.code}</strong>
                                  {stu.isUnenrolled && (
                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>{t("⚠️ Not enrolled in subject")}</span>
                                  )}
                                </Td>
                                <Td>{stu.full_name || '—'}</Td>
                              </Tr>
                            ))}
                          </Tbody>
                        </Table>
                      )}
                    </div>
                    {rosterErrors.length > 0 && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <Table>
                          <Thead>
                            <Tr>
                              <Th>{t("Student")}</Th>
                              <Th>{t("Error")}</Th>
                            </Tr>
                          </Thead>
                          <Tbody>
                            {rosterErrors.map((row, idx) => (
                              <Tr key={`${row.code || row.id}-${idx}`}>
                                <Td>{row.code || row.id}</Td>
                                <Td style={{ color: 'var(--accent)' }}>{translateMessage(row.error)}</Td>
                              </Tr>
                            ))}
                          </Tbody>
                        </Table>
                      </div>
                    )}
                    <div style={{ marginTop: '0.75rem' }}>
                      <Button
                        variant="primary"
                        onClick={handleSaveRoster}
                        isLoading={savingRoster}
                        disabled={!isDraft}
                      >{t("Save roster")}</Button>
                    </div>
                  </div>

                  {/* Examiners Panel */}
                  <div style={{ flex: 1, minWidth: '320px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <h4 style={{ margin: 0 }}>{t("Examiners (")}{selectedExaminerIds.length}/{availableLecturers.length})</h4>
                      {isDraft && (
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={selectAllFilteredLecturers}
                            title={t("Select all matching")}
                          >{t("Select all")}</button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={deselectAllExaminers}
                            title={t("Deselect all")}
                          >{t("Deselect all")}</button>
                        </div>
                      )}
                    </div>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <Input
                        placeholder={t("Search lecturer code or name...")}
                        value={examinerSearch}
                        onChange={(e) => setExaminerSearch(e.target.value)}
                        disabled={!isDraft}
                      />
                    </div>
                    <div style={{ maxHeight: '280px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px' }}>
                      {filteredLecturers.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)', padding: '1rem', textAlign: 'center', margin: 0 }}>
                          {availableLecturers.length === 0 ? t("No lecturers assigned to this subject.") : t("No matching lecturers.")}
                        </p>
                      ) : (
                        <Table>
                          <Thead>
                            <Tr>
                              <Th style={{ width: '40px' }}></Th>
                              <Th>{t("Code")}</Th>
                              <Th>{t("Name")}</Th>
                            </Tr>
                          </Thead>
                          <Tbody>
                            {filteredLecturers.map((lec) => (
                              <Tr key={lec.app_user_id} onClick={() => toggleExaminer(lec.app_user_id)} style={{ cursor: isDraft ? 'pointer' : 'default' }}>
                                <Td>
                                  <input
                                    type="checkbox"
                                    checked={selectedExaminerIds.includes(lec.app_user_id)}
                                    onChange={() => toggleExaminer(lec.app_user_id)}
                                    onClick={(e) => e.stopPropagation()}
                                    disabled={!isDraft}
                                  />
                                </Td>
                                <Td><strong>{lec.code || '—'}</strong></Td>
                                <Td>{lec.full_name || '—'}</Td>
                              </Tr>
                            ))}
                          </Tbody>
                        </Table>
                      )}
                    </div>
                    <div style={{ marginTop: '0.75rem' }}>
                      <Button
                        variant="primary"
                        onClick={handleSaveExaminers}
                        isLoading={savingExaminers}
                        disabled={!isDraft}
                      >{t("Save examiners")}</Button>
                    </div>
                  </div>
                </div>
              );
            })()}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
