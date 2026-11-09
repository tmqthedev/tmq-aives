import { t, useLocale, enumLabel, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, RotateCw, CheckCircle, Clock, BookOpen, Mic, AlertCircle, Calendar, Award } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { LoadingSpinner } from '../../components/ui/Loading';
import { Feedback } from '../../components/ui/Feedback';
import DeviceCheck from '../../components/audio/DeviceCheck';
import { listMyExamSessions, startOrResumeInterview } from '../../services/studentExamApi';
import { formatDateTime } from '../../shared/utils/formatDate';
import { useBusinessEvents } from '../../hooks/useBusinessEvents';

export default function StudentDashboard() {
  useLocale();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startingId, setStartingId] = useState(null);
  const [checkSession, setCheckSession] = useState(null);
  // Captured when the list loads, so render stays pure.
  const [now, setNow] = useState(() => Date.now());

  const loadSessions = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      if (!silent) setError(null);
      const data = await listMyExamSessions();
      setSessions(Array.isArray(data) ? data : []);
      setNow(Date.now());
    } catch (err) {
      setError(err.message || t("Could not load your exam sessions."));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Own interview and exam open/close changes (and reconnects) refresh the list.
  useBusinessEvents(['exam', 'interview'], () => { loadSessions({ silent: true }); });

  const handleStartOrResume = async (session) => {
    try {
      setStartingId(session.examSessionId);
      setError(null);
      const result = await startOrResumeInterview(session.examSessionId);
      navigate(`/student/viva?interviewId=${result.interviewId}`);
    } catch (err) {
      setError(err.message || t("Failed to start interview."));
      setStartingId(null);
    }
  };

  return (
    <div className="animate-fade-in" style={{ maxWidth: '1000px', margin: '0 auto', paddingBottom: '3rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.75rem', fontWeight: '700', marginBottom: '0.5rem' }}>{t("My Oral Examination Sessions")}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t("Assigned AI viva examinations for your enrolled subjects")}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => navigate('/student/results')}
          icon={<Award size={18} />}
        >{t("Xem kết quả thi")}</Button>
      </div>

      {error && (
        <div style={{ marginBottom: '1.5rem' }}>
          <Feedback type="error" message={translateMessage(error)} onClose={() => setError(null)} />
        </div>
      )}

      {loading ? (
        <div style={{ padding: '4rem', display: 'flex', justifyContent: 'center' }}>
          <LoadingSpinner size={36} text={t("Loading assigned exam sessions...")} />
        </div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardBody style={{ textAlign: 'center', padding: '4rem 2rem' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'var(--primary-light, #e0e7ff)', color: 'var(--primary, #4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
              <BookOpen size={32} />
            </div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '0.5rem' }}>{t("No exams assigned")}</h3>
            <p style={{ color: 'var(--text-muted)', maxWidth: '420px', margin: '0 auto' }}>{t("You do not have any oral examination sessions scheduled at this time. Please contact your lecturer if you believe this is an error.")}</p>
          </CardBody>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
          {sessions.map((session) => {
            const isCompleted = session.interview && session.interview.status === 'COMPLETED';
            const isStarting = startingId === session.examSessionId;
            const opensAt = session.opensAt ?? session.opens_at ?? null;
            const closesAt = session.closesAt ?? session.closes_at ?? null;
            const notStartedYet = !isCompleted && !session.canResume
              && opensAt != null && new Date(opensAt).getTime() > now;
            const windowClosed = !isCompleted && !session.canResume
              && closesAt != null && new Date(closesAt).getTime() <= now;

            return (
              <motion.div
                key={session.examSessionId}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <Card style={{ borderLeft: session.canResume ? '4px solid #f59e0b' : session.canStart ? '4px solid #10b981' : isCompleted ? '4px solid #6366f1' : '4px solid var(--border)' }}>
                  <CardHeader style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                        <span style={{ fontWeight: '700', color: 'var(--primary, #4f46e5)' }}>
                          {session.subjectCode || t("N/A")}
                        </span>
                        <span style={{ color: 'var(--text-muted)' }}>•</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                          {session.subjectName}
                        </span>
                      </div>
                      <h3 style={{ fontSize: '1.3rem', fontWeight: '600', marginBottom: '0.25rem' }}>
                        {session.title}
                      </h3>
                      {session.topicName && (
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{t("Topic:")} <span style={{ fontWeight: '500', color: 'var(--text)' }}>{session.topicName}</span>
                        </p>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Badge type={session.language === 'VI' ? 'info' : 'neutral'}>
                        {session.language === 'VI' ? t("Tiếng Việt") : t("English")}
                      </Badge>

                      {isCompleted ? (
                        <Badge type="success">{t("Completed")}</Badge>
                      ) : session.canResume ? (
                        <Badge type="warning">{t("In Progress")}</Badge>
                      ) : session.canStart ? (
                        <Badge type="success">{t("Available Now")}</Badge>
                      ) : notStartedYet ? (
                        <Badge type="info">{t("Not started yet")}</Badge>
                      ) : session.status === 'CLOSED' ? (
                        <Badge type="danger">{t("Closed")}</Badge>
                      ) : (
                        <Badge type="neutral">{enumLabel(session.status)}</Badge>
                      )}
                    </div>
                  </CardHeader>

                  <CardBody>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', padding: '1rem', borderRadius: 'var(--radius-md, 8px)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <Clock size={18} style={{ color: 'var(--text-muted)' }} />
                        <div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t("Time Limit")}</div>
                          <div style={{ fontWeight: '600' }}>{Math.round((session.sessionTimeLimitSec || 1800) / 60)} {t("minutes")}</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <Mic size={18} style={{ color: 'var(--text-muted)' }} />
                        <div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t("Questions")}</div>
                          <div style={{ fontWeight: '600' }}>
                            {session.mainQuestionCount} {t("main questions (")}{session.maxFollowUpsPerQuestion} {t("follow-ups max)")}</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <Calendar size={18} style={{ color: 'var(--text-muted)' }} />
                        <div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t("Opens At")}</div>
                          <div style={{ fontWeight: '600' }}>{formatDateTime(opensAt)}</div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <Calendar size={18} style={{ color: 'var(--text-muted)' }} />
                        <div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t("Available Until")}</div>
                          <div style={{ fontWeight: '600' }}>{formatDateTime(closesAt)}</div>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '1rem' }}>
                      {session.canStart && (
                        <Button
                          variant="primary"
                          onClick={() => setCheckSession(session)}
                          disabled={isStarting}
                        >
                          <Play size={18} />
                          {isStarting ? t("Starting...") : t("Start Examination")}
                        </Button>
                      )}

                      {session.canResume && (
                        <Button
                          variant="warning"
                          onClick={() => setCheckSession(session)}
                          disabled={isStarting}
                        >
                          <RotateCw size={18} />
                          {isStarting ? t("Resuming...") : t("Resume Examination")}
                        </Button>
                      )}

                      {isCompleted && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#10b981', fontWeight: '500' }}>
                            <CheckCircle size={18} />
                            <span>{t("Interview submitted for grading")}</span>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => navigate('/student/results')}
                          >{t("Xem kết quả")}</Button>
                        </div>
                      )}

                      {notStartedYet && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                          <Clock size={18} />
                          <span>{t("Not started yet. The exam opens at")} {formatDateTime(opensAt)}.</span>
                        </div>
                      )}

                      {windowClosed && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                          <AlertCircle size={18} />
                          <span>{t("This exam closed at")} {formatDateTime(closesAt)}{t(". Contact your lecturer if you missed it.")}</span>
                        </div>
                      )}

                      {!session.canStart && !session.canResume && !isCompleted && !notStartedYet && !windowClosed && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                          <AlertCircle size={18} />
                          <span>{t("Examination is currently unavailable")}</span>
                        </div>
                      )}
                    </div>
                  </CardBody>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      <DeviceCheck
        isOpen={checkSession != null}
        onClose={() => setCheckSession(null)}
        onConfirm={async () => {
          const sessionToStart = checkSession;
          setCheckSession(null);
          if (sessionToStart) {
            await handleStartOrResume(sessionToStart);
          }
        }}
        isResume={!!checkSession?.canResume}
        examTitle={checkSession ? `${checkSession.subjectCode || ''} • ${checkSession.title}` : ''}
      />
    </div>
  );
}
