import { t, useLocale, formatNumber, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback, useRef } from 'react';
import WorkflowNext from '../../shared/components/WorkflowNext';
import { Upload, Trash2, FileText } from 'lucide-react';
import {
  listMaterials,
  uploadMaterial,
  deleteMaterial,
} from '../../services/materialApi';
import { getExamSessionOptions } from '../../services/examSessionApi';
import { subscribeBusinessEvents } from '../../services/businessSocket';

// Materials in these states are still being processed, so the page polls until
// they settle (READY or FAILED).
const PENDING_STATES = new Set(['UPLOADED', 'PROCESSING']);
const POLL_INTERVAL_MS = 4000;

const STATUS_BADGE = {
  READY: 'badge-success',
  PROCESSING: 'badge-warning',
  UPLOADED: 'badge-info',
  FAILED: 'badge-danger',
};

// Human-friendly type label. DOCX has no page/slide count, so the backend
// leaves page_count null; show "Document" for it.
function typeLabel(mime) {
  if (!mime) return '—';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('presentationml')) return 'PPTX';
  if (mime.includes('wordprocessingml')) return 'DOCX';
  return mime;
}

function sizeLabel(bytes) {
  if (bytes == null) return '—';
  const kb = Number(bytes) / 1024;
  if (kb < 1024) return t("{v0} KB", {v0: formatNumber(kb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })});
  return t("{v0} MB", {v0: formatNumber((kb / 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })});
}

// PDF/PPTX carry a page/slide count; DOCX is a single "Document".
function pageSlideLabel(material) {
  if (material.page_count == null) {
    return material.mime_type && material.mime_type.includes('wordprocessingml')
      ? 'Document'
      : '—';
  }
  if (material.mime_type && material.mime_type.includes('presentationml')) {
    return t("{v0} slides", {v0: material.page_count});
  }
  return t("{v0} pages", {v0: material.page_count});
}

export default function LecturerMaterials() {
  useLocale();
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [topicId, setTopicId] = useState('');
  const [materials, setMaterials] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  // The lecturer's assigned subjects (with code, name and topics) come from
  // the exam-session options endpoint, so subjects without topics are listed too.
  const topicsForSubject = subjects.find((s) => String(s.subject_id) === String(subjectId))?.topics || [];

  const loadMaterials = useCallback(async (sid) => {
    if (!sid) {
      setMaterials([]);
      return;
    }
    try {
      const data = await listMaterials(sid);
      setMaterials(Array.isArray(data) ? data : []);
    } catch {
      setError(t("Could not load materials for this subject."));
    }
  }, []);

  // Load the lecturer's subjects (and their topics) once.
  useEffect(() => {
    (async () => {
      try {
        const data = await getExamSessionOptions();
        setSubjects(Array.isArray(data?.subjects) ? data.subjects : []);
      } catch {
        setError(t("Could not load subjects."));
      }
    })();
  }, []);

  // Reload materials whenever the chosen subject changes.
  useEffect(() => {
    loadMaterials(subjectId);
  }, [subjectId, loadMaterials]);

  useEffect(() => {
    if (!subjectId) return undefined;
    return subscribeBusinessEvents(() => loadMaterials(subjectId), ['material']);
  }, [subjectId, loadMaterials]);

  // Poll while any material is still being ingested, and stop once they settle.
  useEffect(() => {
    const anyPending = materials.some((m) => PENDING_STATES.has(m.status));
    if (!anyPending || !subjectId) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return undefined;
    }
    if (!pollRef.current) {
      pollRef.current = setInterval(() => loadMaterials(subjectId), POLL_INTERVAL_MS);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [materials, subjectId, loadMaterials]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!subjectId) {
      setError(t("Choose a subject before uploading."));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setError('');
    setNotice('');
    setUploading(true);
    try {
      await uploadMaterial({ file, subjectId, topicId: topicId || undefined });
      setNotice(t("Uploaded {v0}. Ingestion started.", {v0: file.name}));
      await loadMaterials(subjectId);
    } catch (err) {
      if (err.code === 'UNSUPPORTED_TYPE') {
        setError(t("Only PDF, DOCX, and PPTX files are supported."));
      } else if (err.code === 'FILE_TOO_LARGE') {
        setError(t("That file exceeds the 50MB limit."));
      } else if (err.code === 'FORBIDDEN') {
        setError(t("You do not have access to this subject."));
      } else {
        setError(t("Could not upload the file."));
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (material) => {
    if (!confirm(t("Delete \"{v0}\"? This cannot be undone.", {v0: material.title}))) return;
    setError('');
    setNotice('');
    try {
      await deleteMaterial(material.course_material_id);
      await loadMaterials(subjectId);
    } catch (err) {
      if (err.code === 'MATERIAL_IN_USE') {
        setError(t("This material is cited by existing questions and cannot be deleted."));
      } else {
        setError(t("Could not delete the material."));
      }
    }
  };

  return (
    <div className="animate-fade-in">
      <WorkflowNext step={2} done={materials.some((m) => m.status === 'READY')} />
      <div style={{ marginBottom: '2rem' }}>
        <h2>{t("Course Materials")}</h2>
        <p style={{ color: 'var(--text-muted)' }}>{t("Upload documents used to generate grounded questions")}</p>
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
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">{t("Subject")}</label>
            <select
              className="form-select"
              value={subjectId}
              onChange={(e) => { setSubjectId(e.target.value); setTopicId(''); }}
            >
              <option value="">{t("Select a subject")}</option>
              {subjects.map((s) => (
                <option key={s.subject_id} value={s.subject_id}>{s.code ? `${s.code} — ${s.name}` : s.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">{t("Topic (optional)")}</label>
            <select
              className="form-select"
              value={topicId}
              onChange={(e) => setTopicId(e.target.value)}
              disabled={!subjectId}
            >
              <option value="">{t("No topic")}</option>
              {topicsForSubject.map((t) => (
                <option key={t.topic_id} value={t.topic_id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={!subjectId || uploading}
            >
              <Upload size={18} /> {uploading ? t("Uploading...") : t("Upload material")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.pptx"
              style={{ display: 'none' }}
              onChange={handleUpload}
            />
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Title")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Type")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Size")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Pages / Slides")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Status")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'right' }}>{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {materials.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: '1.5rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                  {subjectId ? t("No materials uploaded for this subject yet.") : t("Select a subject to view its materials.")}
                </td>
              </tr>
            )}
            {materials.map((m) => (
              <tr key={m.course_material_id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '1rem' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                    <FileText size={16} /> {m.title}
                  </span>
                </td>
                <td style={{ padding: '1rem' }}>{typeLabel(m.mime_type)}</td>
                <td style={{ padding: '1rem' }}>{sizeLabel(m.size_bytes)}</td>
                <td style={{ padding: '1rem' }}>{pageSlideLabel(m)}</td>
                <td style={{ padding: '1rem' }}>
                  <span className={`badge ${STATUS_BADGE[m.status] || 'badge-info'}`}>{m.status}</span>
                  {m.status === 'FAILED' && m.error && (
                    <div style={{ color: 'var(--accent)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{m.error}</div>
                  )}
                </td>
                <td style={{ padding: '1rem', textAlign: 'right' }}>
                  <button
                    className="btn btn-secondary btn-icon"
                    title={t("Delete")}
                    onClick={() => handleDelete(m)}
                    style={{ color: 'var(--accent)' }}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
