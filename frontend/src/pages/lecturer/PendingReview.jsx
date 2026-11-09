import { t, useLocale, enumLabel, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback, useRef } from 'react';
import WorkflowNext from '../../shared/components/WorkflowNext';
import {
  Inbox, ChevronDown, ChevronRight, Check, X, Edit2,
} from 'lucide-react';
import {
  listPendingAiQuestions,
  getQuestionSources,
  approveQuestion,
  rejectQuestion,
  updateQuestion,
  approveBatch,
} from '../../services/reviewApi';
import { listRubrics } from '../../services/rubricApi';
import { useBusinessEvents } from '../../hooks/useBusinessEvents';

export default function LecturerPendingReview() {
  useLocale();
  const [questions, setQuestions] = useState([]);
  const [rubrics, setRubrics] = useState([]);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [sources, setSources] = useState({}); // questionId -> [citations]
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Per-question rubric picks (for individual approve) and the shared batch
  // rubric + selection set.
  const [rubricPick, setRubricPick] = useState({}); // questionId -> rubricId
  const [selected, setSelected] = useState(new Set());
  const [batchRubricId, setBatchRubricId] = useState('');

  // Edit-then-approve form state keyed by question id.
  const [editing, setEditing] = useState(null); // question id being edited
  const [editForm, setEditForm] = useState({ content: '', referenceAnswer: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await listPendingAiQuestions();
      setQuestions(Array.isArray(data) ? data : []);
      setPendingLoaded(true);
    } catch {
      setError(t("Could not load questions awaiting review."));
    }
  }, []);

  useEffect(() => {
    load();
    (async () => {
      try {
        const data = await listRubrics();
        setRubrics(Array.isArray(data) ? data : []);
      } catch {
        // A missing rubric list just disables rubric pickers; not fatal.
      }
    })();
  }, [load]);

  // Refetch when questions change elsewhere (e.g. a generation job adds
  // drafts). A burst of events collapses into one refetch every ~500ms, and
  // only `questions` is replaced, so the open editor and selection survive.
  const reloadTimer = useRef(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      load();
    }, 500);
  }, [load]);

  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);

  useBusinessEvents(['question'], () => { scheduleReload(); });

  const toggleExpand = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!sources[id]) {
      try {
        const data = await getQuestionSources(id);
        setSources((prev) => ({ ...prev, [id]: Array.isArray(data) ? data : [] }));
      } catch {
        setSources((prev) => ({ ...prev, [id]: [] }));
      }
    }
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleApprove = async (q) => {
    setError('');
    setNotice('');
    const rubricId = rubricPick[q.id];
    try {
      if (rubricId) {
        // Attach the chosen rubric, then approve.
        await updateQuestion(q.id, { rubricId: Number(rubricId) });
      }
      await approveQuestion(q.id);
      setNotice(t("Question {v0} approved.", {v0: q.id}));
      await load();
    } catch (err) {
      if (err.code === 'RUBRIC_REQUIRED') {
        setError(t("Pick a rubric before approving this question."));
      } else if (err.code === 'INVALID_TRANSITION') {
        setError(t("This question can no longer be approved."));
      } else {
        setError(t("Could not approve the question."));
      }
    }
  };

  const startEdit = (q) => {
    setEditing(q.id);
    setEditForm({ content: q.content || '', referenceAnswer: q.referenceAnswer || '' });
  };

  const handleEditThenApprove = async (q) => {
    setError('');
    setNotice('');
    const rubricId = rubricPick[q.id];
    try {
      const patch = {
        content: editForm.content.trim(),
        referenceAnswer: editForm.referenceAnswer.trim(),
      };
      if (rubricId) patch.rubricId = Number(rubricId);
      await updateQuestion(q.id, patch);
      await approveQuestion(q.id);
      setEditing(null);
      setNotice(t("Question {v0} edited and approved.", {v0: q.id}));
      await load();
    } catch (err) {
      if (err.code === 'RUBRIC_REQUIRED') {
        setError(t("Pick a rubric before approving this question."));
      } else if (err.code === 'DUPLICATE_QUESTION') {
        setError(t("That edited content duplicates an existing question."));
      } else {
        setError(t("Could not save and approve the question."));
      }
    }
  };

  const handleReject = async (q) => {
    const reason = prompt(t("Reason for rejecting this question:"));
    if (reason === null) return;
    if (!reason.trim()) {
      setError(t("A reason is required to reject a question."));
      return;
    }
    setError('');
    setNotice('');
    try {
      await rejectQuestion(q.id, reason.trim());
      setNotice(t("Question {v0} rejected.", {v0: q.id}));
      await load();
    } catch {
      setError(t("Could not reject the question."));
    }
  };

  const handleBatchApprove = async () => {
    setError('');
    setNotice('');
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      await approveBatch(ids, Number(batchRubricId));
      setNotice(t("Approved {v0} question(s).", {v0: ids.length}));
      setSelected(new Set());
      setBatchRubricId('');
      await load();
    } catch (err) {
      if (err.code === 'RUBRIC_REQUIRED') {
        setError(t("Choose a rubric for the batch."));
      } else if (err.code === 'INVALID_TRANSITION') {
        setError(t("One of the selected questions can no longer be approved; nothing was changed."));
      } else if (err.code === 'VALIDATION_ERROR') {
        setError(err.message || t("The batch could not be approved."));
      } else {
        setError(t("Could not approve the batch."));
      }
    }
  };

  const rubricOptions = rubrics.map((r) => (
    <option key={r.id} value={r.id}>{r.name ? `${r.name} (max ${r.maxScore})` : `${t("Rubric")} ${r.id} ${t("(max")} ${r.maxScore})`}</option>
  ));

  return (
    <div className="animate-fade-in">
      <WorkflowNext step={5} done={pendingLoaded && questions.length === 0} />
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Inbox size={24} /> {t("Pending Review")}</h2>
        <p style={{ color: 'var(--text-muted)' }}>{t("Review and approve AI-generated questions")}</p>
      </div>

      {notice && (
        <div style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
          {translateMessage(notice)}
        </div>
      )}
      {error && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          {translateMessage(error)}
        </div>
      )}

      {/* Batch approval bar */}
      <div className="card" style={{ marginBottom: '1.5rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{selected.size} {t("selected")}</strong>
        <select
          className="form-select"
          style={{ maxWidth: '240px' }}
          value={batchRubricId}
          onChange={(e) => setBatchRubricId(e.target.value)}
        >
          <option value="">{t("Choose a shared rubric")}</option>
          {rubricOptions}
        </select>
        <button
          className="btn btn-primary"
          onClick={handleBatchApprove}
          disabled={selected.size === 0 || !batchRubricId}
        >
          <Check size={18} /> {t("Approve selected")}</button>
      </div>

      <div className="card">
        {questions.length === 0 && (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '1.5rem' }}>{t("No AI questions are awaiting review.")}</p>
        )}

        {questions.map((q) => {
          const isExpanded = expandedId === q.id;
          const nearDup = q.rationale?.warnings?.nearDuplicateOf;
          return (
            <div key={q.id} style={{ borderBottom: '1px solid var(--border)', padding: '1rem 0' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                <input
                  type="checkbox"
                  checked={selected.has(q.id)}
                  onChange={() => toggleSelect(q.id)}
                  style={{ marginTop: '0.35rem' }}
                />
                <button
                  className="btn btn-secondary btn-icon"
                  onClick={() => toggleExpand(q.id)}
                  title={isExpanded ? t("Collapse") : t("Expand")}
                >
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>#{q.id}</strong>
                    <span className="badge badge-info">{enumLabel(q.bloomLevel || '—')}</span>
                    {Array.isArray(nearDup) && nearDup.length > 0 && (
                      <span className="badge badge-warning" title={t("Flagged as a possible near-duplicate")}>{t("Near-duplicate")}</span>
                    )}
                  </div>
                  <p style={{ margin: '0.5rem 0 0 0' }}>{q.content}</p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    className="form-select"
                    style={{ maxWidth: '180px' }}
                    value={rubricPick[q.id] || ''}
                    onChange={(e) => setRubricPick({ ...rubricPick, [q.id]: e.target.value })}
                  >
                    <option value="">{t("Rubric...")}</option>
                    {rubricOptions}
                  </select>
                  <button className="btn btn-secondary btn-icon" title={t("Approve")} onClick={() => handleApprove(q)}>
                    <Check size={16} />
                  </button>
                  <button className="btn btn-secondary btn-icon" title={t("Edit then approve")} onClick={() => startEdit(q)}>
                    <Edit2 size={16} />
                  </button>
                  <button className="btn btn-secondary btn-icon" title={t("Reject")} onClick={() => handleReject(q)} style={{ color: 'var(--accent)' }}>
                    <X size={16} />
                  </button>
                </div>
              </div>

              {editing === q.id && (
                <div className="card" style={{ marginTop: '1rem', background: 'var(--surface, rgba(255,255,255,0.03))' }}>
                  <div className="form-group">
                    <label className="form-label">{t("Content")}</label>
                    <textarea
                      className="form-textarea"
                      rows={3}
                      value={editForm.content}
                      onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t("Reference answer")}</label>
                    <textarea
                      className="form-textarea"
                      rows={3}
                      value={editForm.referenceAnswer}
                      onChange={(e) => setEditForm({ ...editForm, referenceAnswer: e.target.value })}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button className="btn btn-secondary" onClick={() => setEditing(null)}>{t("Cancel")}</button>
                    <button className="btn btn-primary" onClick={() => handleEditThenApprove(q)}>{t("Save & Approve")}</button>
                  </div>
                </div>
              )}

              {isExpanded && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
                  {/* Left panel: the question details */}
                  <div className="card" style={{ margin: 0 }}>
                    <h4 style={{ marginTop: 0 }}>{t("Question")}</h4>
                    <p><strong>{t("Bloom:")}</strong> {enumLabel(q.bloomLevel || '—')}</p>
                    <p><strong>{t("Reference answer:")}</strong> {q.referenceAnswer || '—'}</p>
                    <div>
                      <strong>{t("Key points:")}</strong>
                      <ul style={{ marginTop: '0.25rem', paddingLeft: '1.25rem' }}>
                        {(q.keyPoints || []).map((kp, i) => (<li key={i}>{kp}</li>))}
                      </ul>
                    </div>
                    <p><strong>{t("Purpose:")}</strong> {q.rationale?.purpose || q.purpose || '—'}</p>
                    <p><strong>{t("Synthesis:")}</strong> {q.rationale?.synthesis || '—'}</p>
                  </div>

                  {/* Right panel: the grounding source chunks */}
                  <div className="card" style={{ margin: 0 }}>
                    <h4 style={{ marginTop: 0 }}>{t("Sources")}</h4>
                    {(sources[q.id] || []).length === 0 && (
                      <p style={{ color: 'var(--text-muted)' }}>{t("No source citations.")}</p>
                    )}
                    {(sources[q.id] || []).map((src, i) => (
                      <div key={i} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ fontWeight: 600 }}>
                          {src.materialTitle}
                          {src.location ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — {src.location}</span> : null}
                        </div>
                        <p style={{ margin: '0.25rem 0 0 0', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                          {src.excerpt || src.content}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
