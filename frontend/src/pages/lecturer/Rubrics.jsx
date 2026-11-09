import { t, useLocale, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback } from 'react';
import WorkflowNext from '../../shared/components/WorkflowNext';
import { Plus, Edit2, Trash2, Copy, Lock } from 'lucide-react';
import Modal from '../../components/Modal';
import {
  listRubrics,
  createRubric,
  updateRubric,
  deleteRubric,
  cloneRubric,
} from '../../services/rubricApi';
import { subscribeBusinessEvents } from '../../services/businessSocket';

const emptyLevel = () => ({ label: '', minScore: 0, maxScore: 0, description: '', orderNo: 1 });
const emptyCriterion = () => ({
  name: '',
  weightPercent: 0,
  description: '',
  performanceLevels: [emptyLevel()],
});

export default function LecturerRubrics() {
  useLocale();
  const [rubrics, setRubrics] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentRubric, setCurrentRubric] = useState(null);

  const [formData, setFormData] = useState({ name: '', maxScore: 10, criteria: [emptyCriterion()] });
  const [formError, setFormError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const locked = Boolean(currentRubric?.isLocked);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await listRubrics();
      setRubrics(Array.isArray(data) ? data : []);
    } catch {
      setError(t("Could not load rubrics."));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => subscribeBusinessEvents(load, ['rubric']), [load]);

  const handleOpenModal = (r = null) => {
    setCurrentRubric(r);
    setFormData(
      r
        ? {
            name: r.name || '',
            maxScore: r.maxScore ?? 10,
            criteria: (r.criteria || []).map((c) => ({
              name: c.name || '',
              weightPercent: c.weightPercent ?? 0,
              description: c.description || '',
              performanceLevels: (c.performanceLevels || []).map((lvl) => ({
                label: lvl.label || '',
                minScore: lvl.minScore ?? 0,
                maxScore: lvl.maxScore ?? 0,
                description: lvl.description || '',
                orderNo: lvl.orderNo ?? 1,
              })),
            })),
          }
        : { name: '', maxScore: 10, criteria: [emptyCriterion()] }
    );
    setFormError('');
    setIsModalOpen(true);
  };

  const updateCriterion = (ci, patch) => {
    setFormData((prev) => ({
      ...prev,
      criteria: prev.criteria.map((c, i) => (i === ci ? { ...c, ...patch } : c)),
    }));
  };

  const updateLevel = (ci, li, patch) => {
    setFormData((prev) => ({
      ...prev,
      criteria: prev.criteria.map((c, i) =>
        i === ci
          ? { ...c, performanceLevels: c.performanceLevels.map((lvl, j) => (j === li ? { ...lvl, ...patch } : lvl)) }
          : c
      ),
    }));
  };

  const addCriterion = () => {
    setFormData((prev) => ({ ...prev, criteria: [...prev.criteria, emptyCriterion()] }));
  };

  const removeCriterion = (ci) => {
    setFormData((prev) => ({ ...prev, criteria: prev.criteria.filter((_, i) => i !== ci) }));
  };

  const addLevel = (ci) => {
    setFormData((prev) => ({
      ...prev,
      criteria: prev.criteria.map((c, i) =>
        i === ci
          ? { ...c, performanceLevels: [...c.performanceLevels, { ...emptyLevel(), orderNo: c.performanceLevels.length + 1 }] }
          : c
      ),
    }));
  };

  const removeLevel = (ci, li) => {
    setFormData((prev) => ({
      ...prev,
      criteria: prev.criteria.map((c, i) =>
        i === ci ? { ...c, performanceLevels: c.performanceLevels.filter((_, j) => j !== li) } : c
      ),
    }));
  };

  const handleSave = async () => {
    const payload = {
      name: formData.name.trim(),
      maxScore: Number(formData.maxScore),
      criteria: formData.criteria.map((c) => ({
        name: c.name.trim(),
        weightPercent: Number(c.weightPercent),
        description: c.description.trim(),
        performanceLevels: c.performanceLevels.map((lvl) => ({
          label: lvl.label.trim(),
          minScore: Number(lvl.minScore),
          maxScore: Number(lvl.maxScore),
          description: lvl.description.trim(),
          orderNo: Number(lvl.orderNo),
        })),
      })),
    };

    try {
      if (currentRubric) {
        await updateRubric(currentRubric.id, payload);
      } else {
        await createRubric(payload);
      }
      setIsModalOpen(false);
      await load();
    } catch (err) {
      if (err.code === 'RUBRIC_LOCKED') {
        setFormError(t("This rubric is locked and can no longer be edited. Clone it to make changes."));
      } else {
        setFormError(t("Failed to save rubric."));
      }
    }
  };

  const handleDelete = async (id) => {
    if (!confirm(t("Are you sure you want to delete this rubric?"))) return;
    setError('');
    try {
      await deleteRubric(id);
      await load();
    } catch {
      setError(t("Could not delete the rubric."));
    }
  };

  const handleClone = async (id) => {
    setError('');
    setNotice('');
    try {
      const cloned = await cloneRubric(id);
      setNotice(t("Rubric cloned as version {v0}.", {v0: cloned.version}));
      await load();
    } catch {
      setError(t("Could not clone the rubric."));
    }
  };

  return (
    <div className="animate-fade-in">
      <WorkflowNext step={3} done={rubrics.length > 0} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2>{t("Rubric Management")}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t("Define scoring criteria for questions")}</p>
        </div>
        <button className="btn btn-primary" onClick={() => handleOpenModal()}>
          <Plus size={18} /> {t("Add Rubric")}</button>
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

      <div className="card">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>ID</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Name")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Criteria")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Max Score")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Version")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("State")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'right' }}>{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rubrics.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background-color 0.2s' }}>
                <td style={{ padding: '1rem' }}><strong>{r.id}</strong></td>
                <td style={{ padding: '1rem' }}>{r.name || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                <td style={{ padding: '1rem' }}>
                  {(r.criteria || []).map((c) => c.name).filter(Boolean).join(', ') || <span style={{ color: 'var(--text-muted)' }}>{t("None")}</span>}
                </td>
                <td style={{ padding: '1rem' }}>{r.maxScore}</td>
                <td style={{ padding: '1rem' }}>{r.version}</td>
                <td style={{ padding: '1rem' }}>
                  {r.isLocked ? (
                    <span className="badge badge-warning" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Lock size={14} /> {t("Locked")}</span>
                  ) : (
                    <span className="badge badge-success">{t("Editable")}</span>
                  )}
                </td>
                <td style={{ padding: '1rem', textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary btn-icon" title={t("Clone")} onClick={() => handleClone(r.id)}>
                      <Copy size={16} />
                    </button>
                    <button
                      className="btn btn-secondary btn-icon"
                      title={r.isLocked ? t("Locked — clone to edit") : t("Edit")}
                      onClick={() => handleOpenModal(r)}
                      disabled={r.isLocked}
                    >
                      <Edit2 size={16} />
                    </button>
                    <button className="btn btn-secondary btn-icon" title={t("Delete")} onClick={() => handleDelete(r.id)} style={{ color: 'var(--accent)' }}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={currentRubric ? t("Edit Rubric") : t("Create Rubric")}>
        <div className="modal-body">
          {formError && (
            <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              {translateMessage(formError)}
            </div>
          )}
          {locked && (
            <div style={{ backgroundColor: 'rgba(234, 179, 8, 0.1)', color: '#eab308', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(234, 179, 8, 0.2)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Lock size={16} /> {t("This rubric is locked. Clone it to make changes.")}</div>
          )}
          <div className="form-group">
            <label className="form-label">{t("Rubric name")}</label>
            <input
              type="text"
              className="form-input"
              maxLength={255}
              value={formData.name}
              disabled={locked}
              placeholder={t("e.g. Design patterns oral rubric")}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("Max Score")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
            <input
              type="number"
              className="form-input"
              value={formData.maxScore}
              disabled={locked}
              onChange={(e) => setFormData({ ...formData, maxScore: e.target.value })}
            />
          </div>

          {formData.criteria.map((c, ci) => (
            <div key={ci} className="card" style={{ marginBottom: '1rem', padding: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <strong>{t("Criterion")} {ci + 1}</strong>
                {!locked && formData.criteria.length > 1 && (
                  <button className="btn btn-secondary btn-icon" title={t("Remove criterion")} onClick={() => removeCriterion(ci)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">{t("Name")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
                <input
                  type="text"
                  className="form-input"
                  value={c.name}
                  disabled={locked}
                  onChange={(e) => updateCriterion(ci, { name: e.target.value })}
                  placeholder={t("e.g. Accuracy")}
                />
              </div>
              <div className="form-group">
                <label className="form-label">{t("Weight (%)")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
                <input
                  type="number"
                  className="form-input"
                  value={c.weightPercent}
                  disabled={locked}
                  onChange={(e) => updateCriterion(ci, { weightPercent: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">{t("Description")}</label>
                <textarea
                  className="form-textarea"
                  rows={2}
                  value={c.description}
                  disabled={locked}
                  onChange={(e) => updateCriterion(ci, { description: e.target.value })}
                />
              </div>

              <label className="form-label">{t("Performance Levels")}</label>
              {c.performanceLevels.map((lvl, li) => (
                <div key={li} style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.75rem', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t("Level")} {li + 1}</span>
                    {!locked && c.performanceLevels.length > 1 && (
                      <button className="btn btn-secondary btn-icon" title={t("Remove level")} onClick={() => removeLevel(ci, li)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t("Label")}</label>
                    <input
                      type="text"
                      className="form-input"
                      value={lvl.label}
                      disabled={locked}
                      onChange={(e) => updateLevel(ci, li, { label: e.target.value })}
                      placeholder={t("e.g. Excellent")}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">{t("Min Score")}</label>
                      <input
                        type="number"
                        className="form-input"
                        value={lvl.minScore}
                        disabled={locked}
                        onChange={(e) => updateLevel(ci, li, { minScore: e.target.value })}
                      />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">{t("Max Score")}</label>
                      <input
                        type="number"
                        className="form-input"
                        value={lvl.maxScore}
                        disabled={locked}
                        onChange={(e) => updateLevel(ci, li, { maxScore: e.target.value })}
                      />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">{t("Order")}</label>
                      <input
                        type="number"
                        className="form-input"
                        value={lvl.orderNo}
                        disabled={locked}
                        onChange={(e) => updateLevel(ci, li, { orderNo: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t("Description")}</label>
                    <textarea
                      className="form-textarea"
                      rows={2}
                      value={lvl.description}
                      disabled={locked}
                      onChange={(e) => updateLevel(ci, li, { description: e.target.value })}
                    />
                  </div>
                </div>
              ))}
              {!locked && (
                <button className="btn btn-secondary" onClick={() => addLevel(ci)}>
                  <Plus size={16} /> {t("Add Level")}</button>
              )}
            </div>
          ))}

          {!locked && (
            <button className="btn btn-secondary" onClick={addCriterion}>
              <Plus size={16} /> {t("Add Criterion")}</button>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setIsModalOpen(false)}>{t("Cancel")}</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={locked}>{t("Save")}</button>
        </div>
      </Modal>
    </div>
  );
}
