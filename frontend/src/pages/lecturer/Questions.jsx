import { t, useLocale, enumLabel, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback, useRef } from 'react';
import WorkflowNext from '../../shared/components/WorkflowNext';
import { Plus, Edit2, Trash2, Upload, Download, Sparkles, Check, X, Archive } from 'lucide-react';
import Modal from '../../components/Modal';
import {
  listQuestions,
  createQuestion,
  updateQuestion,
  getQuestionRevision, saveQuestionRevision, publishQuestionRevision,
  deleteQuestion,
  approveQuestion,
  rejectQuestion,
  archiveQuestion,
  importQuestions,
  downloadTemplate,
} from '../../services/questionApi';
import { listMaterials, listTopics } from '../../services/materialApi';
import { createGenerationJob, getGenerationJob } from '../../services/questionGenerationApi';
import { approveBatch } from '../../services/reviewApi';
import { listRubrics } from '../../services/rubricApi';
import { useBusinessEvents } from '../../hooks/useBusinessEvents';

const STATUS_OPTIONS = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED'];
const BLOOM_OPTIONS = ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE'];
const SOURCE_OPTIONS = ['MANUAL', 'IMPORT', 'AI'];

// Terminal generation-job states (polling stops here).
const GEN_TERMINAL = new Set(['COMPLETED', 'FAILED']);
const GEN_POLL_MS = 2000;

const emptyGenForm = {
  topicId: '',
  rubricId: '',
  materialIds: [],
  requestedCount: 5,
  distributeEvenly: true,
  bloom: {
    REMEMBER: 0, UNDERSTAND: 0, APPLY: 0, ANALYZE: 0,
  },
  language: 'en',
};

// Row actions only offered where questionStatus.js allows the transition.
const CAN_APPROVE = new Set(['DRAFT', 'PENDING_REVIEW']);
const CAN_REJECT = new Set(['PENDING_REVIEW']);

const STATUS_BADGE = {
  APPROVED: 'badge-success',
  PENDING_REVIEW: 'badge-warning',
  REJECTED: 'badge-danger',
  ARCHIVED: 'badge-info',
  DRAFT: 'badge-info',
};

function incompleteApprovalMessage(error) {
  const missing = String(error?.details?.message || error?.message || '').match(/missing ([^.]+)/i)?.[1]
    ?.split(',').map((field) => field.trim()) || [];
  const labels = { referenceAnswer: t('Reference Answer'), keyPoints: t('Key Points'), rubricId: t('Rubric') };
  const fields = missing.map((field) => labels[field]).filter(Boolean);
  return fields.length > 0
    ? t('Missing before approval: {v0}.', { v0: fields.join(', ') })
    : t('A reference answer, key points and rubric are required before approval.');
}

// Rubric label: its name when set, else id + criteria; always the max score.
function rubricLabel(r) {
  if (r.name) return `${r.name} (max ${r.maxScore})`;
  const criteria = (r.criteria || []).map((c) => c.name).filter(Boolean).join(', ');
  return `#${r.id}${criteria ? ` · ${criteria}` : ''} (max ${r.maxScore})`;
}

const emptyForm = {
  topicId: '',
  rubricId: '',
  content: '',
  status: 'DRAFT',
  bloomLevel: 'REMEMBER',
  language: 'en',
  referenceAnswer: '',
  keyPoints: '',
  purpose: '',
};

function revisionFields(values) {
  return {
    content: String(values.content || '').trim(),
    referenceAnswer: String(values.referenceAnswer || '').trim(),
    keyPoints: Array.isArray(values.keyPoints) ? values.keyPoints : String(values.keyPoints || '').split('|').map(p => p.trim()).filter(Boolean),
    rubricId: values.rubricId ? Number(values.rubricId) : null,
    bloomLevel: values.bloomLevel || null,
    language: String(values.language || 'en').toLowerCase(),
  };
}

export default function LecturerQuestions() {
  useLocale();
  const [questions, setQuestions] = useState([]);
  const [filters, setFilters] = useState({ status: '', bloom: '', source: '' });

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState(null); // null means create new
  const [formData, setFormData] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [formTopics, setFormTopics] = useState([]);
  const [formRubrics, setFormRubrics] = useState([]);
  const [pendingRevision, setPendingRevision] = useState(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionReady, setRevisionReady] = useState(false);
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [formNotice, setFormNotice] = useState('');
  const revisionRequestRef = useRef(0);
  const isRevision = currentQuestion?.status === 'APPROVED';
  const revisionDirty = !pendingRevision || JSON.stringify(revisionFields(formData)) !== JSON.stringify(revisionFields(pendingRevision.content));


  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importErrors, setImportErrors] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);
  const errorRef = useRef(null);

  // --- Approve-with-rubric modal (questions without a rubric, e.g. AI drafts) ---
  const [approveTarget, setApproveTarget] = useState(null);
  const [approveRubrics, setApproveRubrics] = useState([]);
  const [approveRubricId, setApproveRubricId] = useState('');
  const [approveError, setApproveError] = useState('');
  const [approving, setApproving] = useState(false);

  // --- Generate-with-AI modal state ---
  const [isGenOpen, setIsGenOpen] = useState(false);
  const [genForm, setGenForm] = useState(emptyGenForm);
  const [genTopics, setGenTopics] = useState([]);
  const [genMaterials, setGenMaterials] = useState([]);
  const [genRubrics, setGenRubrics] = useState([]);
  const [genError, setGenError] = useState('');
  const [genStatus, setGenStatus] = useState(''); // '', 'RUNNING', 'COMPLETED', 'FAILED'
  const [genResult, setGenResult] = useState(null); // { generatedCount, requestedCount, error }
  const genPollRef = useRef(null);

  const readyMaterials = genMaterials.filter((m) => m.status === 'READY');
  const bloomSum = BLOOM_OPTIONS.reduce((sum, b) => sum + Number(genForm.bloom[b] || 0), 0);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await listQuestions(filters);
      setQuestions(Array.isArray(data) ? data : []);
    } catch {
      setError(t("Could not load questions."));
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Question writes (this tab, other lecturers, generation jobs) refetch the list.
  useBusinessEvents(['question'], () => { load(); });

  const handleOpenModal = async (q = null) => {
    const requestId = ++revisionRequestRef.current;
    setPendingRevision(null);
    setRevisionLoading(q?.status === 'APPROVED');
    setRevisionReady(false);
    setFormNotice('');

    setCurrentQuestion(q);
    setFormData(
      q
        ? {
            topicId: q.topicId != null ? String(q.topicId) : '',
            rubricId: q.rubricId != null ? String(q.rubricId) : '',
            content: q.content || '',
            status: q.status || 'DRAFT',
            bloomLevel: q.bloomLevel || 'REMEMBER',
            language: String(q.language || 'en').toLowerCase().startsWith('vi') ? 'vi' : 'en',
            referenceAnswer: q.referenceAnswer || '',
            keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints.join(' | ') : '',
            purpose: q.purpose || '',
          }
        : emptyForm
    );
    setFormError('');
    setIsModalOpen(true);
    try {
      const [topics, rubrics, revision] = await Promise.all([
        listTopics(), listRubrics(), q?.status === 'APPROVED' ? getQuestionRevision(q.id) : Promise.resolve(null),
      ]);
      if (requestId !== revisionRequestRef.current) return;
      setFormTopics(Array.isArray(topics) ? topics : []);
      setFormRubrics(Array.isArray(rubrics) ? rubrics : []);
      setPendingRevision(revision);
      if (revision) setFormData(prev => ({ ...prev, ...revision.content,
        rubricId: revision.content.rubricId != null ? String(revision.content.rubricId) : '',
        language: String(revision.content.language || 'en').toLowerCase(),
        bloomLevel: revision.content.bloomLevel || 'REMEMBER',
        keyPoints: (revision.content.keyPoints || []).join(' | '),
      }));
      setRevisionReady(true);
    } catch {
      if (requestId === revisionRequestRef.current) setFormError(t('Could not load the question editor. Close and reopen it to retry.'));
    } finally {
      if (requestId === revisionRequestRef.current) setRevisionLoading(false);
    }
  };

  // Rubrics offered for the selected topic: same subject (or unscoped).
  const formSubjectId = formTopics.find((tp) => String(tp.topic_id) === String(formData.topicId))?.subject_id ?? null;
  const rubricsForForm = formRubrics.filter((r) => formSubjectId == null || r.subjectId == null || r.subjectId === formSubjectId);

  const handleSave = async () => {
    const trimmedContent = formData.content.trim();
    if (!trimmedContent) {
      setFormError(t("Question content cannot be empty."));
      return;
    }
    if (!formData.topicId) {
      setFormError(t("Pick a topic for this question."));
      return;
    }

    const keyPoints = formData.keyPoints
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);

    const payload = {
      topicId: Number(formData.topicId),
      rubricId: formData.rubricId ? Number(formData.rubricId) : null,
      content: trimmedContent,
      status: formData.status,
      bloomLevel: formData.bloomLevel,
      language: formData.language.trim(),
      referenceAnswer: formData.referenceAnswer.trim(),
      keyPoints,
      purpose: formData.purpose.trim(),
    };

    try {
      if (isRevision) {
        if (!revisionReady || revisionBusy) return;
        setRevisionBusy(true);
        const revision = await saveQuestionRevision(currentQuestion.id, {
          patch: revisionFields(formData), expectedVersion: pendingRevision?.version ?? 0,
          revisionId: pendingRevision?.id,
        });
        setPendingRevision(revision);
        setFormError('');
        setFormNotice(t('Pending revision saved. Review it before publishing.'));
        return;
      }
      if (currentQuestion) {
        await updateQuestion(currentQuestion.id, payload);
      } else {
        await createQuestion(payload);
      }
      setIsModalOpen(false);
      setNotice(t('Question saved. Review its answer, key points and rubric before approving.'));
      await load();
    } catch (err) {
      if (err.code === 'REVISION_CONFLICT') {
        setFormError(t('This revision changed. Close and reopen the editor before reviewing it again.'));
      } else if (err.code === 'DUPLICATE_QUESTION') {
        setFormError(t("This question already exists."));
      } else {
        setFormError(err.message || t("Failed to save question."));
      }
    } finally {
      setRevisionBusy(false);
    }
  };

  const handlePublishRevision = async () => {
    if (!pendingRevision || revisionDirty || revisionBusy || !revisionReady) return;
    if (!confirm(t('Publish this revision after reviewing its question, reference answer, key points and rubric? Existing interviews keep their original knowledge.'))) return;
    setRevisionBusy(true);
    setFormError('');
    try {
      await publishQuestionRevision(currentQuestion.id, {
        revisionId: pendingRevision.id, expectedVersion: pendingRevision.version,
      });
      setIsModalOpen(false);
      setNotice(t('Reviewed revision published. New interviews will use the approved version.'));
      await load();
    } catch (err) {
      setFormError(err.code === 'REVISION_CONFLICT'
        ? t('This revision changed. Close and reopen the editor before reviewing it again.')
        : err.code === 'QUESTION_INCOMPLETE' ? incompleteApprovalMessage(err)
          : err.message || t('Could not publish the revision.'));
    } finally {
      setRevisionBusy(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm(t("Are you sure you want to delete this question?"))) return;
    setError('');
    try {
      await deleteQuestion(id);
      await load();
    } catch {
      setError(t("Could not delete the question."));
    }
  };

  // The error banner sits above the table; bring it into view so a failed
  // row action far down the list is not silent.
  useEffect(() => {
    if (error && errorRef.current) errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [error]);

  const openApproveWithRubric = async (q) => {
    setApproveTarget(q);
    setApproveRubricId('');
    setApproveError('');
    try {
      const [rubrics, topics] = await Promise.all([listRubrics(), listTopics()]);
      const topic = (Array.isArray(topics) ? topics : []).find((tp) => tp.topic_id === q.topicId);
      const subjectId = topic ? topic.subject_id : null;
      setApproveRubrics((Array.isArray(rubrics) ? rubrics : [])
        .filter((r) => subjectId == null || r.subjectId == null || r.subjectId === subjectId));
    } catch {
      setApproveRubrics([]);
      setApproveError(t("Could not load rubrics."));
    }
  };

  const handleApproveWithRubric = async () => {
    if (!approveTarget || !approveRubricId) {
      setApproveError(t("Pick a rubric before approving this question."));
      return;
    }
    setApproving(true);
    setApproveError('');
    try {
      await approveBatch([approveTarget.id], Number(approveRubricId));
      setNotice(t("Question {v0} approved.", { v0: approveTarget.id }));
      setApproveTarget(null);
      await load();
    } catch (err) {
      if (err.code === 'QUESTION_INCOMPLETE') {
        setApproveError(incompleteApprovalMessage(err));
      } else {
        setApproveError(err.message || t("Could not approve the question."));
      }
    } finally {
      setApproving(false);
    }
  };

  const handleApprove = async (q) => {
    setError('');
    setNotice('');
    if (!q.rubricId) {
      await openApproveWithRubric(q);
      return;
    }
    try {
      await approveQuestion(q.id);
      setNotice(t("Question {v0} approved.", { v0: q.id }));
      await load();
    } catch (err) {
      if (err.code === 'RUBRIC_REQUIRED') {
        setError(t("A rubric must be attached before this question can be approved."));
      } else if (err.code === 'QUESTION_INCOMPLETE') {
        setError(incompleteApprovalMessage(err));
      } else if (err.code === 'INVALID_TRANSITION') {
        setError(t("This question cannot be approved from its current status."));
      } else {
        setError(t("Could not approve the question."));
      }
    }
  };

  const handleReject = async (id) => {
    const reason = prompt(t("Enter a reason for rejecting this question:"));
    if (reason === null) return;
    if (!reason.trim()) {
      setError(t("A reason is required to reject a question."));
      return;
    }
    setError('');
    setNotice('');
    try {
      await rejectQuestion(id, reason.trim());
      await load();
    } catch (err) {
      if (err.code === 'INVALID_TRANSITION') {
        setError(t("This question cannot be rejected from its current status."));
      } else {
        setError(t("Could not reject the question."));
      }
    }
  };

  const handleArchive = async (id) => {
    setError('');
    setNotice('');
    try {
      await archiveQuestion(id);
      await load();
    } catch (err) {
      if (err.code === 'INVALID_TRANSITION') {
        setError(t("This question cannot be archived from its current status."));
      } else {
        setError(t("Could not archive the question."));
      }
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportErrors(null);
    setNotice('');
    setError('');
    setImporting(true);
    try {
      const data = await importQuestions(file);
      setNotice(t("Imported {v0} question(s) for lecturer review.", {v0: data.created?.length ?? 0}));
      await load();
    } catch (err) {
      if (err.status === 422 && Array.isArray(err.details?.errors)) {
        setImportErrors(err.details.errors);
      } else if (err.status === 400) {
        setError(t("The file could not be read. Download the template to see the expected columns."));
      } else {
        setError(t("Could not import questions."));
      }
    } finally {
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDownloadTemplate = async () => {
    setError('');
    try {
      await downloadTemplate();
    } catch {
      setError(t("Could not download the import template."));
    }
  };

  // --- Generate with AI ---------------------------------------------------

  const stopGenPoll = () => {
    if (genPollRef.current) {
      clearInterval(genPollRef.current);
      genPollRef.current = null;
    }
  };

  useEffect(() => () => stopGenPoll(), []);

  const openGenerate = async () => {
    setGenForm(emptyGenForm);
    setGenError('');
    setGenStatus('');
    setGenResult(null);
    setGenMaterials([]);
    setIsGenOpen(true);
    try {
      const [topics, rubrics] = await Promise.all([listTopics(), listRubrics()]);
      setGenTopics(Array.isArray(topics) ? topics : []);
      setGenRubrics(Array.isArray(rubrics) ? rubrics : []);
    } catch {
      setGenError(t("Could not load topics."));
    }
  };

  // When the topic changes, load READY materials for its subject.
  const handleGenTopicChange = async (topicId) => {
    setGenForm((prev) => ({ ...prev, topicId, materialIds: [], rubricId: '' }));
    setGenMaterials([]);
    const topic = genTopics.find((t) => String(t.topic_id) === String(topicId));
    if (!topic || topic.subject_id == null) return;
    try {
      const data = await listMaterials(topic.subject_id);
      setGenMaterials(Array.isArray(data) ? data : []);
    } catch {
      setGenError(t("Could not load materials for this subject."));
    }
  };

  const toggleGenMaterial = (materialId) => {
    setGenForm((prev) => {
      const set = new Set(prev.materialIds);
      if (set.has(materialId)) set.delete(materialId);
      else set.add(materialId);
      return { ...prev, materialIds: [...set] };
    });
  };

  const handleGenerate = async () => {
    setGenError('');
    const topicId = Number(genForm.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      setGenError(t("Choose a topic."));
      return;
    }
    if (genForm.materialIds.length === 0) {
      setGenError(t("Select at least one READY material."));
      return;
    }
    const requestedCount = Number(genForm.requestedCount);
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 20) {
      setGenError(t("Count must be between 1 and 20."));
      return;
    }

    const body = {
      topicId,
      materialIds: genForm.materialIds.map(Number),
      requestedCount,
      language: genForm.language.trim() || 'en',
      ...(genForm.rubricId ? { rubricId: Number(genForm.rubricId) } : {}),
    };

    // Omit bloomDistribution when distributing evenly; otherwise it must sum to
    // the requested count (the backend enforces BLOOM_SUM_MISMATCH too).
    if (!genForm.distributeEvenly) {
      if (bloomSum !== requestedCount) {
        setGenError(t("Bloom counts must sum to {v0} (currently {v1}).", {v0: requestedCount, v1: bloomSum}));
        return;
      }
      body.bloomDistribution = { ...genForm.bloom };
    }

    let job;
    try {
      job = await createGenerationJob(body);
    } catch (err) {
      if (err.code === 'MATERIALS_NOT_READY') {
        setGenError(t("One or more selected materials are not READY in this subject."));
      } else if (err.code === 'BLOOM_SUM_MISMATCH') {
        setGenError(t("The Bloom distribution must sum to the requested count."));
      } else if (err.code === 'VALIDATION_ERROR') {
        setGenError(err.message || t("Please check the generation settings."));
      } else if (err.code === 'FORBIDDEN') {
        setGenError(t("You do not have access to this subject."));
      } else {
        setGenError(t("Could not start generation."));
      }
      return;
    }

    setGenStatus('RUNNING');
    setGenResult(null);
    stopGenPoll();
    genPollRef.current = setInterval(async () => {
      try {
        const fresh = await getGenerationJob(job.id);
        if (GEN_TERMINAL.has(fresh.status)) {
          stopGenPoll();
          setGenStatus(fresh.status);
          setGenResult({
            generatedCount: fresh.generatedCount,
            requestedCount: fresh.requestedCount,
            error: fresh.error,
          });
          await load();
        }
      } catch {
        stopGenPoll();
        setGenStatus('FAILED');
        setGenError(t("Lost track of the generation job."));
      }
    }, GEN_POLL_MS);
  };

  return (
    <div className="animate-fade-in">
      <WorkflowNext step={4} done={questions.length > 0} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2>{t("Question Management")}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t("Create and manage viva examination questions")}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={handleDownloadTemplate}>
            <Download size={18} /> {t("Template")}</button>
          <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            <Upload size={18} /> {importing ? t("Importing...") : t("Import Excel")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={handleImport}
          />
          <button className="btn btn-secondary" onClick={openGenerate}>
            <Sparkles size={18} /> {t("Generate with AI")}</button>
          <button className="btn btn-primary" onClick={() => handleOpenModal()}>
            <Plus size={18} /> {t("Add Question")}</button>
        </div>
      </div>

      {notice && (
        <div style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
          {translateMessage(notice)}
        </div>
      )}
      {error && (
        <div ref={errorRef} style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          {translateMessage(error)}
        </div>
      )}

      {importErrors && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>{t("Import failed. No questions were imported. Fix the rows below and upload the file again.")}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Row")}</th>
                <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Errors")}</th>
              </tr>
            </thead>
            <tbody>
              {importErrors.map((rowError) => (
                <tr key={rowError.row} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '1rem' }}>{rowError.row}</td>
                  <td style={{ padding: '1rem' }}>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                      {rowError.errors.map((msg, idx) => (
                        <li key={idx} style={{ color: 'var(--accent)' }}>{translateMessage(msg)}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">{t("Status")}</label>
            <select className="form-select" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">{t("All statuses")}</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{enumLabel(s)}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">{t("Bloom level")}</label>
            <select className="form-select" value={filters.bloom} onChange={(e) => setFilters({ ...filters, bloom: e.target.value })}>
              <option value="">{t("All levels")}</option>
              {BLOOM_OPTIONS.map((b) => (
                <option key={b} value={b}>{enumLabel(b)}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">{t("Source")}</label>
            <select className="form-select" value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })}>
              <option value="">{t("All sources")}</option>
              {SOURCE_OPTIONS.map((s) => (
                <option key={s} value={s}>{enumLabel(s)}</option>
              ))}
            </select>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>ID</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Content")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Bloom")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Status")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Source")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Rubric")}</th>
              <th style={{ padding: '1rem', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'right' }}>{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => (
              <tr key={q.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background-color 0.2s' }}>
                <td style={{ padding: '1rem' }}><strong>{q.id}</strong></td>
                <td style={{ padding: '1rem' }}>{q.content}</td>
                <td style={{ padding: '1rem' }}>{enumLabel(q.bloomLevel || '—')}</td>
                <td style={{ padding: '1rem' }}>
                  <span className={`badge ${STATUS_BADGE[q.status] || 'badge-info'}`}>{enumLabel(q.status)}</span>
                </td>
                <td style={{ padding: '1rem' }}>{enumLabel(q.source || '—')}</td>
                <td style={{ padding: '1rem' }}>
                  {q.rubricId ? <span className="badge badge-info">{q.rubricId}</span> : <span style={{ color: 'var(--text-muted)' }}>{t("None")}</span>}
                </td>
                <td style={{ padding: '1rem', textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    {CAN_APPROVE.has(q.status) && (
                      <button className="btn btn-secondary btn-icon" title={t("Approve")} onClick={() => handleApprove(q)}>
                        <Check size={16} />
                      </button>
                    )}
                    {CAN_REJECT.has(q.status) && (
                      <button className="btn btn-secondary btn-icon" title={t("Reject")} onClick={() => handleReject(q.id)}>
                        <X size={16} />
                      </button>
                    )}
                    {q.status !== 'ARCHIVED' && (
                      <button className="btn btn-secondary btn-icon" title={t("Archive")} onClick={() => handleArchive(q.id)}>
                        <Archive size={16} />
                      </button>
                    )}
                    <button className="btn btn-secondary btn-icon" title={t("Edit")} onClick={() => handleOpenModal(q)}>
                      <Edit2 size={16} />
                    </button>
                    <button className="btn btn-secondary btn-icon" title={t("Delete")} onClick={() => handleDelete(q.id)} style={{ color: 'var(--accent)' }}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => { if (!revisionBusy) setIsModalOpen(false); }} title={isRevision ? t("Review pending revision") : currentQuestion ? t("Edit Question") : t("Create Question")}>
        <div className="modal-body">
          {isRevision && <p>{t('Edits are saved as a pending revision. The active approved question remains available until you publish. Changes to topics and purpose require a separate question.')}</p>}
          {revisionLoading && <p role="status">{t('Loading pending revision...')}</p>}
          {formNotice && <p role="status">{formNotice}</p>}
          {isRevision && <details style={{ marginBottom: '1rem' }}>
            <summary>{t('Active approved version')}</summary>
            <p>{currentQuestion.content}</p>
            <p><strong>{t('Reference Answer')}: </strong>{currentQuestion.referenceAnswer}</p>
            <p><strong>{t('Key Points')}: </strong>{currentQuestion.keyPoints?.join(' | ')}</p>
            <p><strong>{t('Rubric')}: </strong>{currentQuestion.rubricId}</p>
          </details>}
          <fieldset onChangeCapture={() => setFormNotice('')} disabled={revisionLoading || revisionBusy || (isRevision && !revisionReady)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {!currentQuestion && <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{t('Saving a question does not approve it. A lecturer must review its answer, key points and rubric.')}</p>}
          {formError && (
            <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              {translateMessage(formError)}
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t("Topic")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
            <select
              className="form-select"
              value={formData.topicId}
              disabled={isRevision}
              onChange={(e) => setFormData({ ...formData, topicId: e.target.value, rubricId: '' })}
            >
              <option value="">{t("Select a topic")}</option>
              {formTopics.map((tp) => (
                <option key={tp.topic_id} value={tp.topic_id}>{tp.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t("Rubric")}</label>
            <select
              className="form-select"
              value={formData.rubricId}
              onChange={(e) => setFormData({ ...formData, rubricId: e.target.value })}
              disabled={!formData.topicId}
            >
              <option value="">{t("No rubric (cannot be approved yet)")}</option>
              {rubricsForForm.map((r) => (
                <option key={r.id} value={r.id}>{rubricLabel(r)}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t("Question Content")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
            <textarea
              className="form-textarea"
              rows={4}
              value={formData.content}
              onChange={(e) => {
                setFormData({ ...formData, content: e.target.value });
                if (formError) setFormError('');
              }}
              placeholder={t("Enter the question text here...")}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("Bloom Level")}</label>
            <select
              className="form-select"
              value={formData.bloomLevel}
              onChange={(e) => setFormData({ ...formData, bloomLevel: e.target.value })}
            >
              {BLOOM_OPTIONS.map((b) => (
                <option key={b} value={b}>{enumLabel(b)}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t("Language")}</label>
            <select className="form-select" value={formData.language} onChange={(e) => setFormData({ ...formData, language: e.target.value })}>
              <option value="vi">{t("Vietnamese")}</option>
              <option value="en">{t("English")}</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t("Reference Answer")}</label>
            <textarea
              className="form-textarea"
              rows={3}
              value={formData.referenceAnswer}
              onChange={(e) => setFormData({ ...formData, referenceAnswer: e.target.value })}
              placeholder={t("The model answer used for grading...")}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("Key Points")}</label>
            <textarea
              className="form-textarea"
              rows={2}
              value={formData.keyPoints}
              onChange={(e) => setFormData({ ...formData, keyPoints: e.target.value })}
              placeholder={t("Separate each key point with a | character")}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("Purpose")}</label>
            <input
              type="text"
              className="form-input"
              value={formData.purpose}
              disabled={isRevision}
              onChange={(e) => setFormData({ ...formData, purpose: e.target.value })}
              placeholder={t("Why this question is asked...")}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("Status")}</label>
            <select
              className="form-select"
              value={formData.status}
              disabled={isRevision}
              onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            >
              {(currentQuestion ? STATUS_OPTIONS : ['DRAFT', 'PENDING_REVIEW']).map((s) => (
                <option key={s} value={s}>{enumLabel(s)}</option>
              ))}
            </select>
          </div>
          </fieldset>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" disabled={revisionBusy} onClick={() => setIsModalOpen(false)}>{t("Cancel")}</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={revisionBusy || revisionLoading || (isRevision && !revisionReady)}>{isRevision ? t('Save pending revision') : t("Save")}</button>
          {isRevision && <button className="btn btn-primary" onClick={handlePublishRevision}
            disabled={revisionBusy || revisionLoading || !revisionReady || !pendingRevision || revisionDirty}>
            {t('Review and publish revision')}
          </button>}
          {isRevision && pendingRevision && revisionDirty && <span>{t('Save your changes before publishing.')}</span>}
        </div>
      </Modal>

      <Modal isOpen={approveTarget != null} onClose={() => setApproveTarget(null)} title={t("Attach a rubric and approve")}>
        <div className="modal-body">
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>{t("This question has no rubric yet. A rubric is required before it can be approved.")}</p>
          {approveTarget && (!approveTarget.referenceAnswer?.trim() || !approveTarget.keyPoints?.some((point) => String(point).trim())) && (
            <div className="feedback feedback-warning" style={{ marginBottom: '1rem' }}>
              <p>{t('Add the missing answer information before approval:')}</p>
              <ul>
                {!approveTarget.referenceAnswer?.trim() && <li>{t('Reference Answer')}</li>}
                {!approveTarget.keyPoints?.some((point) => String(point).trim()) && <li>{t('Key Points')}</li>}
              </ul>
              <button className="btn btn-secondary" onClick={() => {
                const target = approveTarget;
                setApproveTarget(null);
                handleOpenModal(target);
              }}>{t('Edit Question')}</button>
            </div>
          )}
          {approveError && (
            <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              {translateMessage(approveError)}
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t("Rubric")}</label>
            <select className="form-select" value={approveRubricId} onChange={(e) => setApproveRubricId(e.target.value)}>
              <option value="">{t("Select a rubric")}</option>
              {approveRubrics.map((r) => (
                <option key={r.id} value={r.id}>{rubricLabel(r)}</option>
              ))}
            </select>
            {approveRubrics.length === 0 && !approveError && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}>{t("No rubric in this subject yet. Create one in Rubrics first.")}</p>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setApproveTarget(null)}>{t("Cancel")}</button>
          <button className="btn btn-primary" onClick={handleApproveWithRubric} disabled={approving || !approveRubricId || !approveTarget?.referenceAnswer?.trim() || !approveTarget?.keyPoints?.some((point) => String(point).trim())}>{t("Approve")}</button>
        </div>
      </Modal>

      <Modal isOpen={isGenOpen} onClose={() => { stopGenPoll(); setIsGenOpen(false); }} title={t("Generate Questions with AI")}>
        <div className="modal-body">
          {genError && (
            <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              {genError}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t("Topic")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
            <select
              className="form-select"
              value={genForm.topicId}
              onChange={(e) => handleGenTopicChange(e.target.value)}
            >
              <option value="">{t("Select a topic")}</option>
              {genTopics.map((t) => (
                <option key={t.topic_id} value={t.topic_id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">{t("Materials (READY only)")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
            {!genForm.topicId && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t("Choose a topic to list its materials.")}</p>
            )}
            {genForm.topicId && readyMaterials.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t("No READY materials for this subject yet.")}</p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: '160px', overflowY: 'auto' }}>
              {readyMaterials.map((m) => (
                <label key={m.course_material_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={genForm.materialIds.includes(m.course_material_id)}
                    onChange={() => toggleGenMaterial(m.course_material_id)}
                  />
                  <span>{m.title}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">{t("Rubric for the generated questions (optional)")}</label>
            <select
              className="form-select"
              value={genForm.rubricId}
              disabled={!genForm.topicId}
              onChange={(e) => setGenForm({ ...genForm, rubricId: e.target.value })}
            >
              <option value="">{t("No rubric (attach one when approving)")}</option>
              {genRubrics
                .filter((r) => {
                  const sid = genTopics.find((tp) => String(tp.topic_id) === String(genForm.topicId))?.subject_id;
                  return sid == null || r.subjectId == null || r.subjectId === sid;
                })
                .map((r) => <option key={r.id} value={r.id}>{rubricLabel(r)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t("Number of questions (1-20)")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
            <input
              type="number"
              min={1}
              max={20}
              className="form-input"
              value={genForm.requestedCount}
              onChange={(e) => setGenForm({ ...genForm, requestedCount: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={genForm.distributeEvenly}
                onChange={(e) => setGenForm({ ...genForm, distributeEvenly: e.target.checked })}
              />
              <span>{t("Distribute Bloom levels evenly")}</span>
            </label>
          </div>

          {!genForm.distributeEvenly && (
            <div className="form-group">
              <label className="form-label">{t("Bloom distribution")}</label>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {BLOOM_OPTIONS.map((b) => (
                  <div key={b} style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{enumLabel(b)}</span>
                    <input
                      type="number"
                      min={0}
                      className="form-input"
                      style={{ width: '80px' }}
                      value={genForm.bloom[b]}
                      onChange={(e) => setGenForm({
                        ...genForm,
                        bloom: { ...genForm.bloom, [b]: e.target.value },
                      })}
                    />
                  </div>
                ))}
              </div>
              <p style={{ fontSize: '0.875rem', marginTop: '0.5rem', color: bloomSum === Number(genForm.requestedCount) ? '#22c55e' : 'var(--text-muted)' }}>{t("Sum:")} {bloomSum} / {genForm.requestedCount}
              </p>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t("Language")}</label>
            <select className="form-select" value={genForm.language} onChange={(e) => setGenForm({ ...genForm, language: e.target.value })}>
              <option value="vi">{t("Vietnamese")}</option>
              <option value="en">{t("English")}</option>
            </select>
          </div>

          {genStatus === 'RUNNING' && (
            <div style={{ backgroundColor: 'rgba(234, 179, 8, 0.1)', color: '#eab308', padding: '0.75rem', borderRadius: '0.5rem', fontSize: '0.875rem', border: '1px solid rgba(234, 179, 8, 0.2)' }}>{t("Generating... this runs in the background and the list refreshes when done.")}</div>
          )}
          {genStatus === 'COMPLETED' && genResult && (
            <div style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '0.75rem', borderRadius: '0.5rem', fontSize: '0.875rem', border: '1px solid rgba(34, 197, 94, 0.2)' }}>{t("Generated")} {genResult.generatedCount} {t("of")} {genResult.requestedCount} {t("requested.")}{genResult.error ? ` ${genResult.error}` : t(" They are now awaiting review.")}
            </div>
          )}
          {genStatus === 'FAILED' && (
            <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              {genResult?.error || t("Generation failed.")}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => { stopGenPoll(); setIsGenOpen(false); }}>{t("Close")}</button>
          <button className="btn btn-primary" onClick={handleGenerate} disabled={genStatus === 'RUNNING'}>
            {genStatus === 'RUNNING' ? t("Generating...") : t("Generate")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
