import { t, useLocale, translateMessage } from '../../i18n/index';
import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Users as UsersIcon, GraduationCap, Archive, ArchiveRestore } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Textarea } from '../../components/ui/Input';
import { Feedback } from '../../components/ui/Feedback';
import { LoadingSpinner } from '../../components/ui/Loading';
import { Table, Thead, Tbody, Tr, Th, Td } from '../../components/ui/Table';
import Modal from '../../components/Modal';
import { UserPicker } from '../../components/ui/UserPicker';
import {
  listSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  setSubjectArchived,
  assignLecturers,
  listSubjectStudents,
  listSubjectLecturers,
  assignStudents,
} from '../../services/adminApi';
import { subscribeBusinessEvents } from '../../services/businessSocket';

export default function AdminSubjects() {
  useLocale();
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(null); // null => create
  const [form, setForm] = useState({ code: '', name: '' });
  const [formError, setFormError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [saving, setSaving] = useState(false);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignSubject, setAssignSubject] = useState(null);
  const [selectedLecturers, setSelectedLecturers] = useState([]);
  const [assigning, setAssigning] = useState(false);

  // Student enrollment state
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollSubject, setEnrollSubject] = useState(null);
  const [codesText, setCodesText] = useState('');
  const [enrollErrors, setEnrollErrors] = useState([]);
  const [enrolling, setEnrolling] = useState(false);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [enrollTab, setEnrollTab] = useState('list'); // 'list' | 'paste'
  const [selectedStudents, setSelectedStudents] = useState([]);
  const [loadingLecturers, setLoadingLecturers] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const subjectData = await listSubjects();
      setSubjects(subjectData.subjects || []);
    } catch {
      setError(t("Could not load subjects."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeBusinessEvents(load, ['subject']);
    load();
    return unsubscribe;
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ code: '', name: '' });
    setFormError('');
    setEditOpen(true);
  };

  const openEdit = (subject) => {
    setEditing(subject);
    setForm({ code: subject.code, name: subject.name });
    setFormError('');
    setEditOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setFormError('');
    setCodeError('');
    setSaving(true);
    try {
      if (editing) {
        await updateSubject(editing.id, { code: form.code.trim(), name: form.name.trim() });
        setNotice(t("Subject updated."));
      } else {
        await createSubject({ code: form.code.trim(), name: form.name.trim() });
        setNotice(t("Subject created."));
      }
      setEditOpen(false);
      await load();
    } catch (err) {
      if (err.code === 'SUBJECT_CODE_TAKEN') {
        setCodeError(err.message);
      } else if (err.status === 400) {
        setFormError(t("Code and name are required."));
      } else {
        setFormError(err.message || t("Could not save the subject."));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (subject, archived) => {
    setNotice('');
    setError('');
    try {
      await setSubjectArchived(subject.id, archived);
      setNotice(archived ? t("Subject archived.") : t("Subject restored."));
      await load();
    } catch (err) {
      setError(err.message || t("Could not update the subject."));
    }
  };

  // Only an empty subject can be deleted; one with content is offered archive.
  const handleDelete = async (subject) => {
    setNotice('');
    setError('');
    if (!confirm(t("Delete subject {v0}? This cannot be undone.", { v0: subject.code }))) return;
    try {
      await deleteSubject(subject.id);
      setNotice(t("Subject deleted."));
      await load();
    } catch (err) {
      if (err.code === 'SUBJECT_IN_USE') {
        const c = err.details?.details || {};
        const summary = t("Topics: {v0}, materials: {v1}, rubrics: {v2}, exams: {v3}.", {
          v0: c.topics ?? 0, v1: c.materials ?? 0, v2: c.rubrics ?? 0, v3: c.examSessions ?? 0,
        });
        if (confirm(`${err.message}\n${summary}\n\n${t("Archive this subject now?")}`)) {
          await handleArchive(subject, true);
        } else {
          setError(`${err.message} ${summary}`);
        }
      } else {
        setError(err.message || t("Could not delete the subject."));
      }
    }
  };

  // Saving replaces the whole set, so start from the current assignment.
  const openAssign = async (subject) => {
    setAssignSubject(subject);
    setSelectedLecturers([]);
    setAssignOpen(true);
    setLoadingLecturers(true);
    try {
      const data = await listSubjectLecturers(subject.id);
      setSelectedLecturers(data.lecturers || []);
    } catch (err) {
      setError(err.message || t("Could not load lecturers."));
    } finally {
      setLoadingLecturers(false);
    }
  };

  const handleAssign = async (e) => {
    e.preventDefault();
    setAssigning(true);
    setError('');
    try {
      await assignLecturers(assignSubject.id, selectedLecturers.map((u) => u.id));
      setAssignOpen(false);
      setNotice(t("Lecturers assigned to {v0}.", {v0: assignSubject.name}));
      await load();
    } catch {
      setError(t("Could not assign lecturers."));
    } finally {
      setAssigning(false);
    }
  };

  const openEnroll = async (subject) => {
    setEnrollSubject(subject);
    setCodesText('');
    setEnrollErrors([]);
    setEnrollTab('list');
    setSelectedStudents([]);
    setEnrollOpen(true);
    setLoadingStudents(true);
    try {
      const subjectData = await listSubjectStudents(subject.id);
      const currentStudents = subjectData?.students || [];
      setCodesText(currentStudents.map((st) => st.code).filter(Boolean).join('\n'));
      setSelectedStudents(currentStudents);
    } catch {
      setEnrollErrors([{ code: 'ALL', error: t("Could not load students.") }]);
    } finally {
      setLoadingStudents(false);
    }
  };

  const handleEnroll = async (e) => {
    e.preventDefault();
    setEnrollErrors([]);

    let payload;
    if (enrollTab === 'list') {
      if (selectedStudents.length === 0) {
        const confirmed = window.confirm(t("Are you sure you want to remove all enrolled students from this subject?"));
        if (!confirmed) return;
      }
      payload = { studentIds: selectedStudents.map((u) => u.id) };
    } else {
      if (!codesText.trim()) {
        const confirmed = window.confirm(t("Are you sure you want to remove all enrolled students from this subject?"));
        if (!confirmed) return;
      }
      payload = codesText;
    }

    setEnrolling(true);
    try {
      const res = await assignStudents(enrollSubject.id, payload);
      if (!res.ok) {
        setEnrollErrors(res.errors || [{ code: 'UNKNOWN', error: t("Failed to enroll students.") }]);
        return;
      }
      setEnrollOpen(false);
      setNotice(t("Students enrolled into {v0}.", {v0: enrollSubject.name}));
      await load();
    } catch (err) {
      if (err.details && Array.isArray(err.details.errors)) {
        setEnrollErrors(err.details.errors);
      } else if (err.errors) {
        setEnrollErrors(err.errors);
      } else {
        setEnrollErrors([{ code: 'GENERAL', error: err.message || t("Could not enroll students.") }]);
      }
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2>{t("Subjects")}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t("Manage subjects, lecturer assignments and student enrollment")}</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>{t("Create subject")}</Button>
      </div>

      {notice && <Feedback type="success" message={translateMessage(notice)} />}
      {error && <Feedback type="error" message={translateMessage(error)} />}

      <Card>
        {loading ? (
          <LoadingSpinner text={t("Loading subjects...")} />
        ) : subjects.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>{t("No subjects found.")}</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>{t("Code")}</Th>
                <Th>{t("Name")}</Th>
                <Th>{t("Lecturers")}</Th>
                <Th>{t("Students")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Actions")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {subjects.map((subject) => (
                <Tr key={subject.id}>
                  <Td>{subject.code}</Td>
                  <Td>{subject.name}</Td>
                  <Td>{subject.lecturerCount ?? '—'}</Td>
                  <Td>{subject.studentCount ?? '—'}</Td>
                  <Td>
                    <Badge type={subject.status === 'ARCHIVED' ? 'neutral' : 'success'}>
                      {subject.status === 'ARCHIVED' ? t("Archived") : t("Active")}
                    </Badge>
                  </Td>
                  <Td>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Button variant="secondary" icon={<UsersIcon size={14} />} onClick={() => openAssign(subject)}>{t("Assign lecturers")}</Button>
                      <Button variant="secondary" icon={<GraduationCap size={14} />} onClick={() => openEnroll(subject)}>{t("Students")}</Button>
                      <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => openEdit(subject)}>{t("Edit")}</Button>
                      {subject.status === 'ARCHIVED' ? (
                        <Button variant="secondary" icon={<ArchiveRestore size={14} />} onClick={() => handleArchive(subject, false)}>{t("Unarchive")}</Button>
                      ) : (
                        <Button variant="secondary" icon={<Archive size={14} />} onClick={() => handleArchive(subject, true)}>{t("Archive")}</Button>
                      )}
                      <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => handleDelete(subject)}>{t("Delete")}</Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <Modal isOpen={editOpen} onClose={() => setEditOpen(false)} title={editing ? t("Edit subject") : t("Create subject")}>
        <form onSubmit={handleSave}>
          {formError && <Feedback type="error" message={translateMessage(formError)} />}
          <Input
            label={t("Code")}
            type="text"
            value={form.code}
            onChange={(e) => { setForm({ ...form, code: e.target.value }); setCodeError(''); }}
            error={codeError}
            required
          />
          <Input
            label={t("Name")}
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" variant="primary" isLoading={saving}>{t("Save")}</Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={assignOpen} onClose={() => setAssignOpen(false)} title={t("Assign lecturers{v0}", {v0: assignSubject ? ` — ${assignSubject.name}` : ''})}>
        <form onSubmit={handleAssign}>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>{t("Selecting lecturers replaces the current assignment set for this subject.")}</p>
          {loadingLecturers ? (
            <LoadingSpinner text={t("Loading...")} />
          ) : (
            <UserPicker role="LECTURER" selected={selectedLecturers} onChange={setSelectedLecturers} />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
            <Button type="button" variant="secondary" onClick={() => setAssignOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" variant="primary" isLoading={assigning}>{t("Save assignment")}</Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={enrollOpen} onClose={() => setEnrollOpen(false)} title={t("Enroll students{v0}", {v0: enrollSubject ? ` — ${enrollSubject.name}` : ''})}>
        <form onSubmit={handleEnroll}>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
            <button
              type="button"
              style={{
                padding: '0.4rem 0.8rem',
                border: 'none',
                background: enrollTab === 'list' ? 'var(--primary)' : 'transparent',
                color: enrollTab === 'list' ? '#fff' : 'var(--text-color)',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: enrollTab === 'list' ? 600 : 400,
              }}
              onClick={() => setEnrollTab('list')}
            >{t("Select from list")}</button>
            <button
              type="button"
              style={{
                padding: '0.4rem 0.8rem',
                border: 'none',
                background: enrollTab === 'paste' ? 'var(--primary)' : 'transparent',
                color: enrollTab === 'paste' ? '#fff' : 'var(--text-color)',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: enrollTab === 'paste' ? 600 : 400,
              }}
              onClick={() => setEnrollTab('paste')}
            >{t("Paste student codes")}</button>
          </div>

          {loadingStudents ? (
            <LoadingSpinner text={t("Loading enrolled students...")} />
          ) : enrollTab === 'list' ? (
            <UserPicker role="STUDENT" selected={selectedStudents} onChange={setSelectedStudents} />
          ) : (
            <>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>{t("Paste student codes (one per line or comma-separated). Saving replaces the student enrollment set for this subject.")}</p>
              <Textarea
                label={t("Student codes")}
                value={codesText}
                onChange={(e) => setCodesText(e.target.value)}
                placeholder="SE123456&#10;SE123457"
                rows={6}
              />
            </>
          )}

          {enrollErrors.length > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              <Table>
                <Thead>
                  <Tr>
                    <Th>{t("Code / ID")}</Th>
                    <Th>{t("Error")}</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {enrollErrors.map((row, idx) => (
                    <Tr key={`${row.code || row.id || idx}-${idx}`}>
                      <Td>{row.code || row.id || '—'}</Td>
                      <Td style={{ color: 'var(--accent)' }}>{translateMessage(row.error)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
            <Button type="button" variant="secondary" onClick={() => setEnrollOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" variant="primary" isLoading={enrolling}>{t("Save enrollment")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
