import { t, useLocale, enumLabel, translateMessage } from '../../i18n/index';
import { useCallback, useEffect, useState } from 'react';
import { Play, Square, Flame, RefreshCw, Plus, Trash2 } from 'lucide-react';
import Modal from '../../components/Modal';
import { listTopics } from '../../services/topicApi';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Feedback } from '../../components/ui/Feedback';
import { LoadingSpinner } from '../../components/ui/Loading';
import { Table, Thead, Tbody, Tr, Th, Td } from '../../components/ui/Table';
import {
  listExamSchedule,
  listSubjects,
  startExamSession,
  closeExamSessionAsAdmin,
  warmExamSession,
  createExamSessionAsAdmin,
  deleteExamSessionAsAdmin,
  getExamMonitoring,
} from '../../services/adminApi';
import { formatDateTime, fromDateTimeLocal } from '../../shared/utils/formatDate';
import { subscribeBusinessEvents } from '../../services/businessSocket';
import { useExamCounts } from '../../hooks/useExamCounts';
import ExamCounts from '../../components/ExamCounts';

const EMPTY_EXAM = {
  subjectId: '', topicId: '', title: '', opensAt: '', closesAt: '', mainQuestionCount: 3,
};

const POLL_INTERVAL_MS = 10000;

const STATUS_OPTIONS = ['SCHEDULED', 'OPEN', 'CLOSED', 'DRAFT'];

// OPEN but past closes_at: no student can start any more, so warming the
// Lambdas is pointless; the admin should close the session.
const windowEnded = (session, now) => session.status === 'OPEN'
  && session.closes_at != null
  && new Date(session.closes_at).getTime() <= now;

const statusBadge = (status) => {
  if (status === 'OPEN') return 'success';
  if (status === 'SCHEDULED') return 'warning';
  if (status === 'CLOSED') return 'neutral';
  return 'info';
};

// A local 'YYYY-MM-DD' date input -> ISO at the start (or end) of that day.
function dayToIso(value, endOfDay) {
  if (!value) return undefined;
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const muted = { color: 'var(--text-muted)' };

// STT / TTS warm-up probe: ok -> success with latency, error -> danger with
// the error as a tooltip, absent -> muted dash.
function ProbeBadge({ label, probe }) {
  useLocale();
  if (!probe) {
    return <span style={muted} title={t("{v0}: not warmed yet", {v0: label})}>{label} —</span>;
  }
  const at = probe.at ? t(" at {v0}", {v0: formatDateTime(probe.at, '')}) : '';
  if (probe.ok) {
    return (
      <Badge type="success" title={t("{v0} warm{v1}", {v0: label, v1: at})}>
        {label} {probe.ms != null ? t("{v0} ms", {v0: probe.ms}) : 'ok'}
      </Badge>
    );
  }
  return (
    <Badge type="danger" title={t("{v0} failed{v1}: {v2}", {v0: label, v1: at, v2: probe.error || 'unknown error'})}>
      {label} {t("error")}</Badge>
  );
}

const AUDIO_BADGE = {
  pending: 'info',
  running: 'warning',
  done: 'success',
  failed: 'danger',
};

function WarmStatus({ warm }) {
  useLocale();
  const audio = warm?.audio;
  const keepWarm = warm?.keepWarm;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
        <ProbeBadge label={t("STT")} probe={warm?.stt} />
        <ProbeBadge label={t("TTS")} probe={warm?.tts} />
      </div>
      <div style={{ fontSize: '0.8125rem' }}>
        {audio ? (
          <>
            <span>{t("Audio")} {audio.done ?? 0}/{audio.total ?? 0} </span>
            <Badge type={AUDIO_BADGE[audio.state] || 'info'}>{audio.state}</Badge>
          </>
        ) : (
          <span style={muted}>{t("Audio —")}</span>
        )}
      </div>
      <div style={{ fontSize: '0.8125rem' }}>
        {keepWarm ? (
          <span title={keepWarm.nextAt ? t("Next ping {v0}", {v0: formatDateTime(keepWarm.nextAt, '')}) : undefined}>{t("Keep-warm")}{' '}
            <Badge type={keepWarm.state === 'active' ? 'success' : 'neutral'}>{keepWarm.state}</Badge>
          </span>
        ) : (
          <span style={muted}>{t("Keep-warm —")}</span>
        )}
      </div>
    </div>
  );
}

function actionError(err, fallback) {
  if (err?.code === 'INVALID_TRANSITION') return t("This action is not allowed from the session's current status.");
  if (err?.code === 'EXAM_WINDOW_PASSED') return t("The exam window has already passed, so this session cannot be started.");
  return err?.message || fallback;
}

export default function AdminExamSchedule() {
  useLocale();
  const [sessions, setSessions] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  // Time of the last successful load; compared with closes_at to flag OPEN
  // sessions whose window has already ended (students can no longer start).
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  const [status, setStatus] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Admin "New exam": created as DRAFT; lecturers add roster and examiners.
  const [createOpen, setCreateOpen] = useState(false);
  const [examForm, setExamForm] = useState(EMPTY_EXAM);
  const [topics, setTopics] = useState([]);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const data = await listExamSchedule({
        status: status || undefined,
        subjectId: subjectId || undefined,
        from: dayToIso(from, false),
        to: dayToIso(to, true),
      });
      setSessions(data.sessions || []);
      setLoadedAt(Date.now());
    } catch {
      if (!silent) setError(t("Could not load the exam schedule."));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [status, subjectId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => subscribeBusinessEvents(() => load({ silent: true })), [load]);
  const examCounts = useExamCounts(getExamMonitoring);

  useEffect(() => {
    (async () => {
      try {
        const data = await listSubjects();
        setSubjects(data.subjects || []);
      } catch {
        // The subject filter is optional; the schedule still loads without it.
      }
    })();
  }, []);

  // Poll while any visible session is OPEN so progress and warm-up stay live.
  const anyOpen = sessions.some((s) => s.status === 'OPEN');
  useEffect(() => {
    if (!anyOpen) return undefined;
    const timer = setInterval(() => load({ silent: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [anyOpen, load]);

  const label = (s) => s.title || t("Session {v0}", {v0: s.exam_session_id});

  const runAction = async (session, action, successMessage, fallback) => {
    setNotice('');
    setError('');
    setBusyId(session.exam_session_id);
    try {
      await action(session.exam_session_id);
      setNotice(successMessage);
      await load({ silent: true });
    } catch (err) {
      setError(actionError(err, fallback));
    } finally {
      setBusyId(null);
    }
  };

  const handleStart = (session) => {
    if (!window.confirm(t("Start \"{v0}\" now? Students on the roster will be able to begin their viva.", {v0: label(session)}))) return;
    runAction(session, startExamSession, t("\"{v0}\" started. Warm-up is running.", {v0: label(session)}), t("Could not start the exam."));
  };

  const handleClose = (session) => {
    if (!window.confirm(t("Close \"{v0}\"? Students will no longer be able to start.", {v0: label(session)}))) return;
    runAction(session, closeExamSessionAsAdmin, t("\"{v0}\" closed.", {v0: label(session)}), t("Could not close the exam."));
  };

  const openCreate = async () => {
    setExamForm(EMPTY_EXAM);
    setCreateError('');
    setCreateOpen(true);
    try {
      const data = await listTopics();
      setTopics(Array.isArray(data) ? data : []);
    } catch {
      setCreateError(t("Could not load topics."));
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      await createExamSessionAsAdmin({
        subjectId: Number(examForm.subjectId),
        topicId: Number(examForm.topicId),
        title: examForm.title.trim() || undefined,
        opens_at: examForm.opensAt ? fromDateTimeLocal(examForm.opensAt) : undefined,
        closes_at: examForm.closesAt ? fromDateTimeLocal(examForm.closesAt) : undefined,
        main_question_count: Number(examForm.mainQuestionCount) || undefined,
      });
      setCreateOpen(false);
      setNotice(t("Exam created as a draft. The subject's lecturers add the roster and examiners, then submit the schedule."));
      setStatus('DRAFT');
      await load({ silent: true });
    } catch (err) {
      setCreateError(actionError(err, t("Could not create the exam.")));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = (session) => {
    if (!window.confirm(t("Delete \"{v0}\"? Its roster and examiners are removed too.", {v0: label(session)}))) return;
    runAction(session, deleteExamSessionAsAdmin, t("\"{v0}\" deleted.", {v0: label(session)}), t("Could not delete the exam."));
  };

  const handleWarm = (session) => {
    runAction(session, warmExamSession, t("Warm-up re-run for \"{v0}\".", {v0: label(session)}), t("Could not warm up the Lambdas."));
  };

  return (
    <div className="animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2>{t("Exam schedule")}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t("Start scheduled exams, close them, and watch Lambda warm-up")}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Button variant="secondary" icon={<RefreshCw size={16} />} onClick={() => load()}>{t("Refresh")}</Button>
          <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>{t("New exam")}</Button>
        </div>
      </div>

      {notice && <Feedback type="success" message={translateMessage(notice)} />}
      {error && <Feedback type="error" message={translateMessage(error)} />}

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '1rem' }}>
        <div className="form-group">
          <label className="form-label" htmlFor="schedule-status">{t("Status")}</label>
          <select id="schedule-status" className="form-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("All statuses")}</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{enumLabel(s)}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="schedule-subject">{t("Subject")}</label>
          <select id="schedule-subject" className="form-select" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">{t("All subjects")}</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
            ))}
          </select>
        </div>
        <Input label={t("From")} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input label={t("To")} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      <Card>
        {loading ? (
          <LoadingSpinner text={t("Loading exam schedule...")} />
        ) : sessions.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>{t("No exam sessions match these filters.")}</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>{t("Title")}</Th>
                <Th>{t("Subject")}</Th>
                <Th>{t("Lecturer")}</Th>
                <Th>{t("Window")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Students")}</Th>
                <Th>{t("Progress")}</Th>
                <Th>{t("Lambda warm-up")}</Th>
                <Th>{t("Actions")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {sessions.map((s) => {
                const busy = busyId === s.exam_session_id;
                return (
                  <Tr key={s.exam_session_id}>
                    <Td>{label(s)}</Td>
                    <Td>
                      <div>{s.subject_code || '—'}</div>
                      {s.subject_name && <div style={{ ...muted, fontSize: '0.8125rem' }}>{s.subject_name}</div>}
                    </Td>
                    <Td>
                      <div>{s.creator_name || '—'}</div>
                      {s.creator_email && <div style={{ ...muted, fontSize: '0.8125rem' }}>{s.creator_email}</div>}
                    </Td>
                    <Td>
                      <div>{formatDateTime(s.opens_at, '—')}</div>
                      <div style={{ ...muted, fontSize: '0.8125rem' }}>{t("to")} {formatDateTime(s.closes_at, '—')}</div>
                    </Td>
                    <Td>
                      <Badge type={statusBadge(s.status)}>{enumLabel(s.status)}</Badge>
                      {windowEnded(s, loadedAt) && (
                        <div style={{ marginTop: '0.375rem' }}><Badge type="warning">{t("Window ended")}</Badge></div>
                      )}
                    </Td>
                    <Td>{s.student_count ?? 0}</Td>
                    <Td>
                      <ExamCounts counts={examCounts[s.exam_session_id]} />
                    </Td>
                    <Td><WarmStatus warm={s.warm_status} /></Td>
                    <Td>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {s.status === 'SCHEDULED' && (
                          <Button variant="primary" icon={<Play size={14} />} isLoading={busy} onClick={() => handleStart(s)}>{t("Start")}</Button>
                        )}
                        {s.status === 'OPEN' && (
                          <>
                            {!windowEnded(s, loadedAt) && (
                              <Button variant="secondary" icon={<Flame size={14} />} isLoading={busy} onClick={() => handleWarm(s)}>{t("Warm again")}</Button>
                            )}
                            <Button variant="danger" icon={<Square size={14} />} isLoading={busy} onClick={() => handleClose(s)}>{t("Close")}</Button>
                          </>
                        )}
                        {['DRAFT', 'SCHEDULED'].includes(s.status) && !(s.interviews_started > 0) && (
                          <Button variant="danger" icon={<Trash2 size={14} />} isLoading={busy} onClick={() => handleDelete(s)}>{t("Delete")}</Button>
                        )}
                        {s.status === 'CLOSED' && <span style={muted}>—</span>}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Card>

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={t("New exam")}>
        <form onSubmit={handleCreate}>
          <div className="modal-body">
            {createError && <Feedback type="error" message={translateMessage(createError)} />}
            <p style={{ ...muted, fontSize: '0.875rem', marginTop: 0 }}>{t("The exam language comes from the topic's approved questions. The exam starts as a draft.")}</p>
            <div className="form-group">
              <label className="form-label">{t("Subject")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
              <select className="form-select" required value={examForm.subjectId} onChange={(e) => setExamForm({ ...examForm, subjectId: e.target.value, topicId: '' })}>
                <option value="">{t("Select a subject")}</option>
                {subjects.filter((sub) => sub.status !== 'ARCHIVED').map((sub) => (
                  <option key={sub.id} value={sub.id}>{sub.code} — {sub.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">{t("Topic")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
              <select className="form-select" required disabled={!examForm.subjectId} value={examForm.topicId} onChange={(e) => setExamForm({ ...examForm, topicId: e.target.value })}>
                <option value="">{t("Select a topic")}</option>
                {topics.filter((tp) => String(tp.subject_id) === String(examForm.subjectId)).map((tp) => (
                  <option key={tp.topic_id} value={tp.topic_id}>{tp.name}</option>
                ))}
              </select>
            </div>
            <Input label={t("Title")} type="text" value={examForm.title} onChange={(e) => setExamForm({ ...examForm, title: e.target.value })} placeholder={t("Optional title")} />
            <Input label={t("Opens at")} type="datetime-local" value={examForm.opensAt} onChange={(e) => setExamForm({ ...examForm, opensAt: e.target.value })} />
            <Input label={t("Closes at")} type="datetime-local" value={examForm.closesAt} onChange={(e) => setExamForm({ ...examForm, closesAt: e.target.value })} />
            <Input label={t("Main questions per candidate")} type="number" min="1" max="10" value={examForm.mainQuestionCount} onChange={(e) => setExamForm({ ...examForm, mainQuestionCount: e.target.value })} />
          </div>
          <div className="modal-footer">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" variant="primary" isLoading={creating}>{t("Create")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
