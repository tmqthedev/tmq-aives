import { t, useLocale, enumLabel, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback, useRef } from 'react';
import WorkflowNext from '../../shared/components/WorkflowNext';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronDown, ChevronRight, FileCheck, AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import { Table, Thead, Tbody, Tr, Th, Td } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { LoadingSpinner } from '../../components/ui/Loading';
import { listExamSessions, getExamMonitoring } from '../../services/examSessionApi';
import { useBusinessEvents } from '../../hooks/useBusinessEvents';
import { useExamCounts } from '../../hooks/useExamCounts';
import ExamCounts from '../../components/ExamCounts';
import { listSessionResults } from '../../services/gradingApi';

const STATUS_BADGE = {
  DRAFT: 'info',
  OPEN: 'success',
  CLOSED: 'warning',
};

const VIVA_STATUS_BADGE = {
  PENDING: 'neutral',
  AI_SCORING: 'info',
  AI_SUGGESTED: 'warning',
  FLAGGED: 'danger',
  FINALIZED: 'success',
};

const GRADING_STAGE_LABEL = {
  QUEUED: 'Queued',
  PREPARING: 'Preparing',
  SCORING: 'Scoring',
  AGGREGATING: 'Aggregating',
  RETRYING: 'Retrying',
  FAILED: 'Grading failed',
  AWAITING_REVIEW: 'Awaiting review',
};

function gradingProgressText(res, tFn) {
  const progress = res && res.progress;
  if (!progress || !progress.stage) return '—';
  const label = tFn(GRADING_STAGE_LABEL[progress.stage] || progress.stage);
  const live = res.status === 'PENDING' || res.status === 'AI_SCORING';
  if (live && progress.current != null && progress.total != null) {
    return `${label} · ${tFn('Question {v0}/{v1}', { v0: progress.current, v1: progress.total })}`;
  }
  return label;
}

export default function LecturerSessions() {
  useLocale();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState('');

  // Track expanded session and its student results
  const [expandedSessionId, setExpandedSessionId] = useState(null);
  const [sessionResults, setSessionResults] = useState({});
  const [loadingResults, setLoadingResults] = useState({});

  const loadSessions = useCallback(async () => {
    try {
      const data = await listExamSessions();
      setSessions(Array.isArray(data) ? data : []);
    } catch {
      setError(t("Could not load exam sessions."));
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const examCounts = useExamCounts(getExamMonitoring);
  const expandedRef = useRef(null);
  useEffect(() => { expandedRef.current = expandedSessionId; });

  // Grading/interview/exam changes refetch the list and the open results panel.
  useBusinessEvents(['exam', 'interview', 'result'], async () => {
    loadSessions();
    const open = expandedRef.current;
    if (open == null) return;
    try {
      const results = await listSessionResults(open);
      setSessionResults((prev) => ({ ...prev, [open]: Array.isArray(results) ? results : [] }));
    } catch {
      // Keep the previous panel content if the refetch fails.
    }
  });

  const toggleExpand = async (sessionId) => {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);
    if (!sessionResults[sessionId]) {
      setLoadingResults((prev) => ({ ...prev, [sessionId]: true }));
      try {
        const results = await listSessionResults(sessionId);
        setSessionResults((prev) => ({ ...prev, [sessionId]: Array.isArray(results) ? results : [] }));
      } catch {
        // Failed to load results for session
      } finally {
        setLoadingResults((prev) => ({ ...prev, [sessionId]: false }));
      }
    }
  };

  const term = searchTerm.toLowerCase();
  const filteredSessions = sessions.filter((s) => {
    const title = (s.title || '').toLowerCase();
    return (
      title.includes(term) ||
      String(s.subject_id).includes(term) ||
      String(s.topic_id).includes(term) ||
      (s.language || '').toLowerCase().includes(term) ||
      (s.status || '').toLowerCase().includes(term)
    );
  });

  return (
    <div className="animate-fade-in">
      <WorkflowNext step={7} done={false} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2 style={{ marginBottom: '0.5rem' }}>{t("Exam Sessions & Grading")}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t("Review AI viva results, adjust scores, and finalize student grades")}</p>
        </div>
      </div>

      {error && (
        <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', fontSize: '0.875rem', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          {translateMessage(error)}
        </div>
      )}

      <Card>
        <CardHeader style={{ paddingBottom: 0 }}>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                className="form-input"
                placeholder={t("Search by title, subject, topic, language, or status...")}
                style={{ paddingLeft: '2.5rem' }}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <Table>
            <Thead>
              <Tr>
                <Th style={{ width: '40px' }}></Th>
                <Th>{t("Title")}</Th>
                <Th>{t("Subject / Topic")}</Th>
                <Th>{t("Language")}</Th>
                <Th>{t("Config")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Students taking the exam")}</Th>
                <Th style={{ textAlign: 'right' }}>{t("Actions")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {filteredSessions.map((session) => {
                const isExpanded = expandedSessionId === session.exam_session_id;
                const results = sessionResults[session.exam_session_id] || [];
                const isLoading = loadingResults[session.exam_session_id];

                return (
                  <div key={session.exam_session_id} style={{ display: 'contents' }}>
                    <Tr
                      style={{ cursor: 'pointer', backgroundColor: isExpanded ? 'var(--bg-subtle, rgba(0,0,0,0.02))' : 'transparent' }}
                      onClick={() => toggleExpand(session.exam_session_id)}
                    >
                      <Td>
                        {isExpanded ? <ChevronDown size={18} color="var(--primary)" /> : <ChevronRight size={18} color="var(--text-muted)" />}
                      </Td>
                      <Td>
                        <div style={{ fontWeight: 600 }}>{session.title || t("Session {v0}", {v0: session.exam_session_id})}</div>
                      </Td>
                      <Td>{t("Subject")} {session.subject_id} {t("/ Topic")} {session.topic_id}</Td>
                      <Td>{session.language}</Td>
                      <Td>
                        {session.main_question_count}/{session.max_follow_ups_per_question}/{session.answer_time_limit_sec}s
                      </Td>
                      <Td>
                        <Badge type={STATUS_BADGE[session.status] || 'info'}>{enumLabel(session.status)}</Badge>
                      </Td>
                      <Td><ExamCounts counts={examCounts[session.exam_session_id]} /></Td>
                      <Td style={{ textAlign: 'right' }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(session.exam_session_id);
                          }}
                        >
                          {isExpanded ? t("Hide Results") : t("View Results")}
                        </Button>
                      </Td>
                    </Tr>

                    {isExpanded && (
                      <Tr style={{ backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.02))' }}>
                        <Td colSpan={8} style={{ padding: '1rem 1.5rem' }}>
                          <div style={{ borderLeft: '3px solid var(--primary, #4f46e5)', paddingLeft: '1rem' }}>
                            <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem' }}>{t("Student Viva Results (")}{results.length})
                            </h4>

                            {isLoading && (
                              <div style={{ padding: '1rem 0' }}>
                                <LoadingSpinner size={20} text={t("Loading student interview results...")} />
                              </div>
                            )}

                            {!isLoading && results.length === 0 && (
                              <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', fontStyle: 'italic', padding: '0.5rem 0' }}>{t("No student examination submissions yet for this session.")}</div>
                            )}

                            {!isLoading && results.length > 0 && (
                              <Table>
                                <Thead>
                                  <Tr>
                                    <Th>{t("Student Code")}</Th>
                                    <Th>{t("Student Name")}</Th>
                                    <Th>{t("Status")}</Th>
                                    <Th>{t("Progress")}</Th>
                                    <Th>{t("AI Score")}</Th>
                                    <Th>{t("Final Score")}</Th>
                                    <Th>{t("Flag Reason")}</Th>
                                    <Th style={{ textAlign: 'right' }}>{t("Review")}</Th>
                                  </Tr>
                                </Thead>
                                <Tbody>
                                  {results.map((res) => (
                                    <Tr key={res.viva_result_id}>
                                      <Td style={{ fontWeight: 600 }}>{res.student_code || t("N/A")}</Td>
                                      <Td>{res.student_name || t("Student")}</Td>
                                      <Td>
                                        <Badge type={VIVA_STATUS_BADGE[res.status] || 'neutral'}>
                                          {res.status === 'FLAGGED' && <AlertTriangle size={12} style={{ marginRight: '4px' }} />}
                                          {res.status === 'FINALIZED' && <CheckCircle size={12} style={{ marginRight: '4px' }} />}
                                          {res.status === 'AI_SCORING' && <Clock size={12} style={{ marginRight: '4px' }} />}
                                          {res.status}
                                        </Badge>
                                      </Td>
                                      <Td style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                                        {gradingProgressText(res, t)}
                                      </Td>
                                      <Td>{res.ai_total_score != null ? `${res.ai_total_score}/10` : '—'}</Td>
                                      <Td style={{ fontWeight: 600, color: 'var(--primary, #4f46e5)' }}>
                                        {res.final_total_score != null ? `${res.final_total_score}/10` : '—'}
                                      </Td>
                                      <Td style={{ fontSize: '0.8125rem', color: res.flag_reason ? 'var(--danger, #ef4444)' : 'var(--text-muted)' }}>
                                        {res.flag_reason || '—'}
                                      </Td>
                                      <Td style={{ textAlign: 'right' }}>
                                        <Button
                                          size="sm"
                                          variant="primary"
                                          icon={<FileCheck size={14} />}
                                          onClick={() => navigate(`/lecturer/evaluation/${res.viva_result_id}`)}
                                        >{t("Review")}</Button>
                                      </Td>
                                    </Tr>
                                  ))}
                                </Tbody>
                              </Table>
                            )}
                          </div>
                        </Td>
                      </Tr>
                    )}
                  </div>
                );
              })}
              {filteredSessions.length === 0 && (
                <Tr>
                  <Td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t("No sessions found matching your search.")}</Td>
                </Tr>
              )}
            </Tbody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}
