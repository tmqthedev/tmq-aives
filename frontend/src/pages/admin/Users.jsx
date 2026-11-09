import { t, useLocale, enumLabel, translateMessage } from '../../i18n/index';
import { useCallback, useEffect, useRef, useState } from 'react';
import { UserPlus, Upload, Lock, Unlock, Mail, Trash2, ListTree } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Feedback } from '../../components/ui/Feedback';
import { LoadingSpinner } from '../../components/ui/Loading';
import { Table, Thead, Tbody, Tr, Th, Td } from '../../components/ui/Table';
import Modal from '../../components/Modal';
import {
  searchUsers,
  getUserAssignments,
  listSubjects,
  createUser,
  updateUser,
  deleteUser,
  lockUser,
  unlockUser,
  resendSetup,
  importStudents,
} from '../../services/adminApi';
import { subscribeBusinessEvents } from '../../services/businessSocket';

const ROLES = ['STUDENT', 'LECTURER', 'ADMIN'];
const EMPTY_FORM = { code: '', email: '', fullName: '', role: 'STUDENT' };
const STATUSES = ['ACTIVE', 'LOCKED'];
const PAGE_SIZE = 20;

// "Exam 7 (OPEN)" list for USER_IN_OPEN_EXAM.
const describeExams = (err) => (err.details?.details?.exams || [])
  .map((e) => `${e.title || `#${e.id}`} (${e.status})`).join(', ');

const statusBadge = (status) => {
  if (status === 'ACTIVE') return 'success';
  if (status === 'LOCKED') return 'error';
  return 'info';
};

export default function AdminUsers() {
  useLocale();
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Server-side filters for large user sets.
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [subjects, setSubjects] = useState([]);

  const [assignmentsOf, setAssignmentsOf] = useState(null);
  const [assignments, setAssignments] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [importErrors, setImportErrors] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await searchUsers({
        role: roleFilter || undefined,
        status: statusFilter || undefined,
        subjectId: subjectFilter || undefined,
        q: query || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setUsers(data.users || []);
      setTotal(data.total || 0);
    } catch {
      setError(t("Could not load users."));
    } finally {
      setLoading(false);
    }
  }, [roleFilter, statusFilter, subjectFilter, query, page]);

  useEffect(() => {
    const unsubscribe = subscribeBusinessEvents(load, ['user']);
    load();
    return unsubscribe;
  }, [load]);

  // Debounce the free-text search.
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    (async () => {
      try {
        const data = await listSubjects();
        setSubjects(data.subjects || []);
      } catch {
        // The subject filter is optional.
      }
    })();
  }, []);

  const openAssignments = async (user) => {
    setAssignmentsOf(user);
    setAssignments(null);
    try {
      setAssignments(await getUserAssignments(user.id));
    } catch (err) {
      setAssignments({ error: err.message || t("Could not load assignments.") });
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleCreate = async (e) => {
    e.preventDefault();
    setFormError('');
    if (form.role === 'STUDENT' && !form.code.trim()) {
      setFormError(t("A student code is required."));
      return;
    }
    if (form.role === 'ADMIN' && !confirm(t("Create an ADMIN account for {v0}? Admins can manage every user, subject and exam.", { v0: form.email.trim() }))) {
      return;
    }
    setSaving(true);
    try {
      await createUser({
        code: form.code.trim() || undefined,
        email: form.email.trim(),
        fullName: form.fullName.trim() || undefined,
        role: form.role,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setNotice(t("User created. A setup link has been emailed."));
      await load();
    } catch (err) {
      setFormError(err.message || t("Could not create the user."));
    } finally {
      setSaving(false);
    }
  };

  const handleLockToggle = async (user) => {
    setNotice('');
    setError('');
    try {
      if (user.status === 'LOCKED') {
        await unlockUser(user.id);
      } else {
        await lockUser(user.id);
      }
      await load();
    } catch {
      setError(t("Could not update the user status."));
    }
  };

  const handleRoleChange = async (user, role) => {
    if (role === user.role) return;
    setNotice('');
    setError('');
    if (!confirm(t("Change the role of {v0} from {v1} to {v2}? Their subject assignments are removed.", { v0: user.email, v1: enumLabel(user.role), v2: enumLabel(role) }))) {
      await load();
      return;
    }
    try {
      await updateUser(user.id, { role });
      setNotice(t("Role updated."));
    } catch (err) {
      const exams = err.code === 'USER_IN_OPEN_EXAM' ? ` ${describeExams(err)}` : '';
      setError(`${err.message || t("Could not update the user.")}${exams}`);
    }
    await load();
  };

  const handleDelete = async (user) => {
    setNotice('');
    setError('');
    if (!confirm(t("Delete {v0}? The account is disabled and hidden; exam history is kept.", { v0: user.email }))) return;
    try {
      await deleteUser(user.id);
      setNotice(t("User deleted."));
      await load();
    } catch (err) {
      const exams = err.code === 'USER_IN_OPEN_EXAM' ? ` ${describeExams(err)}` : '';
      setError(`${err.message || t("Could not delete the user.")}${exams}`);
    }
  };

  const handleResend = async (user) => {
    setNotice('');
    setError('');
    try {
      await resendSetup(user.id);
      setNotice(t("Setup link re-sent to {v0}.", {v0: user.email}));
    } catch {
      setError(t("Could not resend the setup link."));
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
      const data = await importStudents(file);
      setNotice(t("Imported {v0} student(s). Setup links have been emailed.", {v0: data.created?.length ?? 0}));
      await load();
    } catch (err) {
      if (err.status === 422 && Array.isArray(err.details?.errors)) {
        setImportErrors(err.details.errors);
      } else if (err.status === 400) {
        setError(t("The file could not be read. Expected columns: student code, full name, email."));
      } else {
        setError(t("Could not import students."));
      }
    } finally {
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2>{t("Users")}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t("Manage lecturers and students")}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Button variant="secondary" icon={<Upload size={16} />} isLoading={importing} onClick={() => fileInputRef.current?.click()}>{t("Import students")}</Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={handleImport}
          />
          <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => { setFormError(''); setForm(EMPTY_FORM); setCreateOpen(true); }}>{t("Add user")}</Button>
        </div>
      </div>

      {notice && <Feedback type="success" message={translateMessage(notice)} />}
      {error && <Feedback type="error" message={translateMessage(error)} />}

      {importErrors && (
        <Card style={{ marginBottom: '1.5rem' }}>
          <Feedback
            type="error"
            title={t("Import failed")}
            message={t("No students were imported. Fix the rows below and upload the file again.")}
          />
          <Table>
            <Thead>
              <Tr>
                <Th>{t("Row")}</Th>
                <Th>{t("Errors")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {importErrors.map((rowError) => (
                <Tr key={rowError.row}>
                  <Td>{rowError.row}</Td>
                  <Td>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                      {rowError.errors.map((msg, idx) => (
                        <li key={idx} style={{ color: 'var(--accent)' }}>{translateMessage(msg)}</li>
                      ))}
                    </ul>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}

      <Card style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 14rem' }}>
            <Input label={t("Search")} placeholder={t("Code, name or email")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">{t("Role")}</label>
            <select className="form-select" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}>
              <option value="">{t("All")}</option>
              {ROLES.map((r) => <option key={r} value={r}>{enumLabel(r)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t("Status")}</label>
            <select className="form-select" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
              <option value="">{t("All")}</option>
              {STATUSES.map((st) => <option key={st} value={st}>{enumLabel(st)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">{t("Subject")}</label>
            <select className="form-select" value={subjectFilter} onChange={(e) => { setSubjectFilter(e.target.value); setPage(1); }}>
              <option value="">{t("All")}</option>
              {subjects.map((sub) => <option key={sub.id} value={sub.id}>{sub.code} — {sub.name}</option>)}
            </select>
          </div>
        </div>
      </Card>

      <Card>
        {loading ? (
          <LoadingSpinner text={t("Loading users...")} />
        ) : users.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>{t("No users found.")}</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>{t("Code")}</Th>
                <Th>{t("Name")}</Th>
                <Th>{t("Email")}</Th>
                <Th>{t("Role")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Actions")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {users.map((user) => (
                <Tr key={user.id}>
                  <Td>{user.code || '—'}</Td>
                  <Td>{user.fullName || '—'}</Td>
                  <Td>{user.email}</Td>
                  <Td>
                    {me && Number(me.id) === Number(user.id) ? (
                      <Badge type="info">{enumLabel(user.role)}</Badge>
                    ) : (
                      <select
                        className="form-select"
                        aria-label={t("Role")}
                        value={user.role}
                        onChange={(e) => handleRoleChange(user, e.target.value)}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{enumLabel(r)}</option>)}
                      </select>
                    )}
                  </Td>
                  <Td><Badge type={statusBadge(user.status)}>{user.status}</Badge></Td>
                  <Td>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Button
                        variant="secondary"
                        icon={user.status === 'LOCKED' ? <Unlock size={14} /> : <Lock size={14} />}
                        onClick={() => handleLockToggle(user)}
                      >
                        {user.status === 'LOCKED' ? t("Unlock") : t("Lock")}
                      </Button>
                      <Button variant="secondary" icon={<ListTree size={14} />} onClick={() => openAssignments(user)}>{t("Assignments")}</Button>
                      <Button variant="secondary" icon={<Mail size={14} />} onClick={() => handleResend(user)}>{t("Resend setup")}</Button>
                      {!(me && Number(me.id) === Number(user.id)) && (
                        <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => handleDelete(user)}>{t("Delete")}</Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("Previous")}</Button>
          <span>{t("Page {v0} of {v1}", { v0: page, v1: pages })} · {t("{v0} found", { v0: total })}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t("Next")}</Button>
        </div>
      </Card>

      <Modal isOpen={assignmentsOf != null} onClose={() => setAssignmentsOf(null)} title={t("Assignments of {v0}", { v0: assignmentsOf?.email || '' })}>
        <div className="modal-body">
          {!assignments ? (
            <LoadingSpinner text={t("Loading...")} />
          ) : assignments.error ? (
            <Feedback type="error" message={translateMessage(assignments.error)} />
          ) : (
            [
              ['subjectsTaught', t("Subjects taught")],
              ['subjectsEnrolled', t("Subjects enrolled")],
              ['examsAsExaminer', t("Exams as examiner")],
              ['examsAsCandidate', t("Exams as candidate")],
            ].map(([key, title]) => (
              <div key={key} style={{ marginBottom: '1rem' }}>
                <h4 style={{ margin: '0 0 0.35rem' }}>{title} ({(assignments[key] || []).length})</h4>
                {(assignments[key] || []).length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', margin: 0 }}>—</p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                    {assignments[key].map((row) => (
                      <li key={row.subject_id || row.exam_session_id}>
                        {row.code ? `${row.code} — ${row.name}` : (row.title || t("Session {v0}", { v0: row.exam_session_id }))}
                        {row.status ? <span style={{ color: 'var(--text-muted)' }}> ({enumLabel(row.status)})</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      </Modal>

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={t("Add user")}>
        <form onSubmit={handleCreate}>
          {formError && <Feedback type="error" message={translateMessage(formError)} />}
          <div className="form-group">
            <label className="form-label">{t("Role")} <span aria-hidden="true" style={{ color: 'var(--accent)' }}>*</span></label>
            <select
              className="form-select"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              required
            >
              {ROLES.map((r) => <option key={r} value={r}>{enumLabel(r)}</option>)}
            </select>
          </div>
          <Input
            label={t("Email")}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <Input
            label={form.role === 'STUDENT' ? `${t("Code")} *` : t("Code (optional)")}
            type="text"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            required={form.role === 'STUDENT'}
          />
          <Input
            label={t("Full name (optional)")}
            type="text"
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" variant="primary" isLoading={saving}>{t("Create")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
