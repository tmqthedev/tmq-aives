import { t, useLocale, formatNumber } from '../../i18n/index';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Calendar, CheckCircle2, FileQuestion } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { LoadingSpinner } from '../../components/ui/Loading';
import { getMyResult } from '../../services/studentApi';
import { listMyExamSessions } from '../../services/studentExamApi';
import { useBusinessEvents } from '../../hooks/useBusinessEvents';
import TranscriptHistory from '../../components/interview/TranscriptHistory';
import { formatDateTime } from '../../shared/utils/formatDate';
import { ErrorPage } from '../../shared/components/ErrorPage';
import { httpStatusOf } from '../../shared/utils/httpStatus';

export default function StudentResultDetail() {
  useLocale();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [detail, setDetail] = useState(null);
  const [fetchedInterviewId, setFetchedInterviewId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const directId = detail?.interviewId || detail?.interview_id || location.state?.interviewId || searchParams.get('interviewId') || null;
  const interviewId = directId ? Number(directId) : fetchedInterviewId;

  // Latest request wins when the route id changes or a live refresh overlaps
  // the initial load.
  const requestSeq = useRef(0);
  const fetchResult = useCallback(async ({ silent = false } = {}) => {
    const seq = ++requestSeq.current;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const data = await getMyResult(id);
      if (seq === requestSeq.current) {
        setDetail(data);
        setError(null);
      }
    } catch (err) {
      // A failed live refresh keeps the previously loaded result on screen.
      if (seq === requestSeq.current && !silent) setError(err);
    } finally {
      if (seq === requestSeq.current && !silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchResult(); }, [fetchResult]);

  // This result being (re)graded or finalized elsewhere refreshes the page.
  // Reconnects fire with no event; bursts collapse into one refetch per ~500ms.
  const refreshTimer = useRef(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchResult({ silent: true });
    }, 500);
  }, [fetchResult]);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useBusinessEvents(['result'], (event) => {
    if (!event) {
      scheduleRefresh();
      return;
    }
    if (event.action === 'finalized'
      || (event.resultId != null && String(event.resultId) === String(id))) {
      scheduleRefresh();
    }
  });

  useEffect(() => {
    if (!detail || directId) return;
    if (detail.examSessionId) {
      listMyExamSessions()
        .then((sessions) => {
          const match = Array.isArray(sessions) && sessions.find((s) => s.examSessionId === detail.examSessionId);
          if (match?.interview?.interviewId) {
            setFetchedInterviewId(Number(match.interview.interviewId));
          }
        })
        .catch(() => {});
    }
  }, [detail, directId]);

  const getScoreBadgeType = (score) => {
    if (score >= 8.5) return 'success';
    if (score >= 6.5) return 'info';
    if (score >= 5.0) return 'warning';
    return 'danger';
  };

  if (loading) {
    return (
      <div style={{ padding: '5rem', display: 'flex', justifyContent: 'center' }}>
        <LoadingSpinner size={36} text={t("Đang tải chi tiết điểm thi...")} />
      </div>
    );
  }

  if (error || !detail) {
    const status = error ? (httpStatusOf(error) || 500) : 404;
    return (
      <ErrorPage
        code={status}
        embedded
        message={error && status >= 500 ? error.message : undefined}
        onRetry={status >= 500 ? () => window.location.reload() : undefined}
        backTo="/student/results"
        backLabel={t("Quay lại danh sách kết quả")}
      />
    );
  }

  const totalScore = Number(detail.totalScore ?? 0);
  const questions = Array.isArray(detail.questions) ? detail.questions : [];

  return (
    <div className="animate-fade-in" style={{ maxWidth: '960px', margin: '0 auto', paddingBottom: '3rem' }}>
      {/* Top Header & Navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <Button variant="secondary" icon={<ArrowLeft size={16} />} onClick={() => navigate('/student/results')}>{t("Quay lại")}</Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          <Calendar size={15} />
          <span>{t("Ngày chốt điểm:")} {formatDateTime(detail.finalizedAt)}</span>
        </div>
      </div>

      {/* Main Exam Overview Card */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <Card style={{ marginBottom: '1.5rem', borderLeft: '5px solid var(--primary, #4f46e5)' }}>
          <CardBody style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1.5rem', padding: '1.5rem 2rem' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
                <span style={{ fontWeight: '700', color: 'var(--primary, #4f46e5)', fontSize: '1.1rem' }}>
                  {detail.subjectCode || t("N/A")}
                </span>
                <span style={{ color: 'var(--text-muted)' }}>•</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
                  {detail.subjectName || t("Không có tên môn")}
                </span>
              </div>
              <h1 style={{ fontSize: '1.6rem', fontWeight: '700', margin: '0 0 0.5rem 0' }}>
                {detail.examTitle}
              </h1>
              {detail.topicName && (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{t("Chủ đề thi:")} <strong style={{ color: 'var(--text-main)' }}>{detail.topicName}</strong>
                </div>
              )}
            </div>

            <div style={{ textAlign: 'center', background: 'var(--surface-alt, #f8fafc)', padding: '1rem 1.75rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: '600', marginBottom: '0.25rem', letterSpacing: '0.05em' }}>{t("Điểm Tổng Kết")}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: '0.35rem' }}>
                <span style={{ fontSize: '2.5rem', fontWeight: '800', color: 'var(--primary, #4f46e5)' }}>
                  {formatNumber(totalScore, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                </span>
                <span style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: '600' }}>/ 10</span>
              </div>
              <Badge type={getScoreBadgeType(totalScore)} style={{ marginTop: '0.25rem' }}>
                <CheckCircle2 size={12} style={{ marginRight: '4px' }} /> {t("Đã chốt điểm")}</Badge>
            </div>
          </CardBody>
        </Card>
      </motion.div>

      {/* Questions & Criteria Breakdown */}
      <div style={{ marginBottom: '1rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileQuestion size={20} style={{ color: 'var(--primary, #4f46e5)' }} />{t("Chi Tiết Điểm Từng Câu Hỏi")}</h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {questions.map((q, idx) => {
          const qScore = Number(q.score ?? 0);
          const criteria = Array.isArray(q.criteria) ? q.criteria : [];
          return (
            <motion.div
              key={idx}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: idx * 0.05 }}
            >
              <Card>
                <CardHeader style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', background: 'var(--surface-alt, #f8fafc)' }}>
                  <div>
                    <span style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--primary, #4f46e5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t("Câu hỏi")} {q.orderNo ?? idx + 1}
                    </span>
                    <h4 style={{ margin: '0.25rem 0 0 0', fontSize: '1.05rem', fontWeight: '600', lineHeight: 1.4 }}>
                      {q.questionContent}
                    </h4>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t("Điểm câu")}</div>
                    <Badge type={getScoreBadgeType(qScore)} style={{ fontSize: '0.9rem', fontWeight: '700' }}>
                      {formatNumber(qScore, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / 10
                    </Badge>
                  </div>
                </CardHeader>
                <CardBody style={{ padding: '1rem 1.25rem' }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>{t("Đánh giá theo tiêu chí rubric:")}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                    {criteria.map((c, cIdx) => {
                      const cScore = Number(c.score ?? 0);
                      const maxScore = Number(c.maxScore ?? 10);
                      return (
                        <div
                          key={cIdx}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '0.625rem 0.875rem',
                            borderRadius: '8px',
                            background: 'var(--bg-subtle, rgba(0,0,0,0.02))',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: '500', fontSize: '0.925rem' }}>{c.criterionName}</div>
                            {c.weight != null && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t("Trọng số:")} {c.weight}%
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '1.05rem', fontWeight: '700', color: 'var(--text-main)' }}>
                              {formatNumber(cScore, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                            </span>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>/ {maxScore}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardBody>
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* Read-only Transcript History */}
      {interviewId && (
        <div style={{ marginTop: '2rem' }}>
          <TranscriptHistory interviewId={interviewId} />
        </div>
      )}
    </div>
  );
}
