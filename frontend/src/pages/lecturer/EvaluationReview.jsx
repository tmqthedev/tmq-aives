import { t, useLocale, enumLabel, getLocale, formatNumber } from '../../i18n/index';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle,
  AlertTriangle,
  Clock,
  Sparkles,
  Lock,
  Unlock,
  RefreshCw,
  FileText,
  Volume2,
  Award,
  ChevronDown,
  ChevronUp,
  BookOpen,
  Quote,
  Activity,
  Edit2,
  Save,
  X,
  MessageSquare
} from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Input, Textarea } from '../../components/ui/Input';
import { Feedback } from '../../components/ui/Feedback';
import { LoadingSpinner } from '../../components/ui/Loading';
import { Table, Thead, Tbody, Tr, Th, Td } from '../../components/ui/Table';
import { ErrorPage } from '../../shared/components/ErrorPage';
import { httpStatusOf } from '../../shared/utils/httpStatus';

import {
  getResultDetail,
  adjustCriterionScore,
  finalizeResult,
  reopenResult,
  regradeResult,
  getTurnAudioUrl
} from '../../services/gradingApi';

// JSONB list items may be plain strings or objects ({ quote } for grading
// evidence, { point } / { text } elsewhere). Rendering an object as a React
// child throws and blanks the page, so always reduce to text.
function asText(item) {
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item === 'object') {
    const v = item.quote ?? item.text ?? item.point ?? item.content ?? item.label;
    if (v != null) return String(v);
    try { return JSON.stringify(item); } catch { return ''; }
  }
  return String(item);
}

function asList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [value];
}

const BLOOM_BADGE = {
  REMEMBER: 'neutral',
  UNDERSTAND: 'info',
  APPLY: 'success',
  ANALYZE: 'warning',
  EVALUATE: 'danger',
  CREATE: 'primary',
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

function gradingProgressLine(result, tFn) {
  const progress = result && result.progress;
  if (!progress || !progress.stage) return null;
  const label = tFn(GRADING_STAGE_LABEL[progress.stage] || progress.stage);
  if (progress.current != null && progress.total != null) {
    return `${label} · ${tFn('Question {v0}/{v1}', { v0: progress.current, v1: progress.total })}`;
  }
  return label;
}

export default function LecturerEvaluationReview() {
  useLocale();
  const { id } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [activeQuestionIdx, setActiveQuestionIdx] = useState(0);
  const [showRationale, setShowRationale] = useState(false);

  // Score adjustments state: { [criterion_score_id]: { score: number, reason: string, isEditing: boolean } }
  const [adjustments, setAdjustments] = useState({});
  const [actionLoading, setActionLoading] = useState(null);
  const [notification, setNotification] = useState(null);

  const pollTimerRef = useRef(null);

  const fetchDetail = useCallback(async (isPolling = false) => {
    try {
      if (!isPolling) setIsLoading(true);
      setError(null);
      const data = await getResultDetail(id);
      setDetail(data);

      // Pre-fill adjustment values from current criteria final/ai scores
      const initialAdjustments = {};
      if (Array.isArray(data.evaluations)) {
        for (const ev of data.evaluations) {
          if (Array.isArray(ev.criteria)) {
            for (const c of ev.criteria) {
              const currentScore = c.final_score != null ? Number(c.final_score) : (c.ai_score != null ? Number(c.ai_score) : 0);
              initialAdjustments[c.criterion_score_id] = {
                score: currentScore,
                reason: '',
                isEditing: false,
              };
            }
          }
        }
      }
      setAdjustments(initialAdjustments);
    } catch (err) {
      console.error('[EvaluationReview] Error loading detail:', err);
      // Polling failures keep the last good data on screen.
      if (!isPolling) setError(err);
    } finally {
      if (!isPolling) setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [fetchDetail]);

  // Polling while grading is in flight (queued or scoring)
  useEffect(() => {
    const active = detail?.result?.status === 'AI_SCORING' || detail?.result?.status === 'PENDING';
    if (active) {
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(() => {
          fetchDetail(true);
        }, 3500);
      }
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [detail?.result?.status, fetchDetail]);

  const handleScoreChange = (criterionScoreId, field, value) => {
    setAdjustments((prev) => ({
      ...prev,
      [criterionScoreId]: {
        ...prev[criterionScoreId],
        [field]: value,
      },
    }));
  };

  const toggleEditing = (criterionScoreId) => {
    setAdjustments((prev) => ({
      ...prev,
      [criterionScoreId]: {
        ...prev[criterionScoreId],
        isEditing: !prev[criterionScoreId]?.isEditing,
      },
    }));
  };

  const handleSaveAdjustment = async (criterionScoreId, maxScore) => {
    const adj = adjustments[criterionScoreId];
    if (!adj) return;

    const numScore = Number(adj.score);
    if (isNaN(numScore) || numScore < 0 || numScore > (maxScore || 10)) {
      setNotification({
        type: 'error',
        message: t("Điểm phải là số hợp lệ từ 0 đến {v0}.", {v0: maxScore || 10}),
      });
      return;
    }

    if (!adj.reason || !adj.reason.trim()) {
      setNotification({
        type: 'error',
        message: t("Vui lòng cung cấp lý do điều chỉnh điểm (bắt buộc)."),
      });
      return;
    }

    try {
      setActionLoading(`save_${criterionScoreId}`);
      setNotification(null);
      const updated = await adjustCriterionScore(criterionScoreId, {
        score: numScore,
        reason: adj.reason.trim(),
      });
      setDetail(updated);
      setAdjustments((prev) => ({
        ...prev,
        [criterionScoreId]: {
          ...prev[criterionScoreId],
          score: numScore,
          reason: '',
          isEditing: false,
        },
      }));
      setNotification({
        type: 'success',
        message: t("Đã lưu điều chỉnh điểm và cập nhật tổng kết quả thành công."),
      });
    } catch (err) {
      console.error('[EvaluationReview] Save adjustment failed:', err);
      setNotification({
        type: 'error',
        message: err.message || t("Không thể lưu điểm điều chỉnh."),
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleFinalize = async () => {
    if (!window.confirm(t("Bạn có chắc chắn muốn chốt điểm cho bài thi viva này? Sinh viên sẽ xem được kết quả chính thức."))) {
      return;
    }
    try {
      setActionLoading('finalize');
      setNotification(null);
      await finalizeResult(id);
      await fetchDetail(true);
      setNotification({
        type: 'success',
        message: t("Bài thi viva đã được chốt điểm chính thức thành công."),
      });
    } catch (err) {
      setNotification({
        type: 'error',
        message: err.message || t("Không thể chốt điểm."),
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleReopen = async () => {
    if (!window.confirm(t("Mở lại kết quả để tiếp tục điều chỉnh điểm?"))) {
      return;
    }
    try {
      setActionLoading('reopen');
      setNotification(null);
      await reopenResult(id);
      await fetchDetail(true);
      setNotification({
        type: 'info',
        message: t("Đã mở lại bài thi viva để giảng viên điều chỉnh điểm."),
      });
    } catch (err) {
      setNotification({
        type: 'error',
        message: err.message || t("Không thể mở lại kết quả."),
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRegrade = async () => {
    if (!window.confirm(t("Yêu cầu AI chấm lại toàn bộ bài thi này? Điểm AI sẽ được tính lại theo rubric."))) {
      return;
    }
    try {
      setActionLoading('regrade');
      setNotification(null);
      await regradeResult(id);
      setDetail((prev) => ({
        ...prev,
        result: {
          ...prev.result,
          status: 'AI_SCORING',
        },
      }));
      setNotification({
        type: 'info',
        message: t("Đã gửi yêu cầu chấm lại qua AI. Kết quả sẽ được cập nhật tự động."),
      });
    } catch (err) {
      setNotification({
        type: 'error',
        message: err.message || t("Không thể yêu cầu chấm lại."),
      });
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return (
      <div className="page-content animate-fade-in" style={{ maxWidth: '1280px', margin: '0 auto', padding: '2rem 1rem' }}>
        <LoadingSpinner size={36} text={t("Đang tải dữ liệu đánh giá bài thi viva...")} />
      </div>
    );
  }

  if (error || !detail || !detail.result) {
    const status = error ? (httpStatusOf(error) || 500) : 404;
    return (
      <ErrorPage
        code={status}
        embedded
        message={error && status !== 404 && status !== 403 ? error.message : undefined}
        onRetry={status >= 500 || status === 409 ? () => fetchDetail() : undefined}
        backTo="/lecturer/sessions"
        backLabel={t("Quay lại danh sách phiên thi")}
      />
    );
  }

  const { result, evaluations = [], scoreAdjustments = [] } = detail;
  const canGrade = detail.canGrade !== false && result.canGrade !== false;
  const isFinalized = result.status === 'FINALIZED';
  const isScoring = result.status === 'AI_SCORING';
  const isPending = result.status === 'PENDING';
  const isFlagged = result.status === 'FLAGGED';

  const currentEval = evaluations[activeQuestionIdx] || null;

  // Safe parse rationale
  let parsedRationale = null;
  if (currentEval?.question_rationale) {
    try {
      parsedRationale = typeof currentEval.question_rationale === 'string'
        ? JSON.parse(currentEval.question_rationale)
        : currentEval.question_rationale;
    } catch {
      parsedRationale = { purpose: String(currentEval.question_rationale) };
    }
  }

  return (
    <div className="page-content animate-fade-in" style={{ maxWidth: '1360px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      {/* Top Header & Navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <Button variant="secondary" icon={<ArrowLeft size={16} />} onClick={() => navigate('/lecturer/sessions')}>{t("Quay lại")}</Button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: '1.6rem' }}>{t("Đánh Giá Thi Viva")}</h1>
              {result.status === 'FINALIZED' && (
                <Badge type="success">
                  <CheckCircle size={14} style={{ marginRight: '4px' }} /> {t("Đã chốt điểm")}</Badge>
              )}
              {result.status === 'FLAGGED' && (
                <Badge type="warning">
                  <AlertTriangle size={14} style={{ marginRight: '4px' }} /> {t("Cần xem xét (Flagged)")}</Badge>
              )}
              {result.status === 'AI_SUGGESTED' && (
                <Badge type="info">
                  <Sparkles size={14} style={{ marginRight: '4px' }} /> {t("AI gợi ý")}</Badge>
              )}
              {result.status === 'AI_SCORING' && (
                <Badge type="info">
                  <Clock size={14} style={{ marginRight: '4px' }} /> {t("AI đang chấm...")}</Badge>
              )}
            </div>
            {(isScoring || isPending) && result.progress && (
              <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                <Clock size={12} style={{ marginRight: '4px', verticalAlign: '-2px' }} />
                {gradingProgressLine(result, t)}
              </p>
            )}
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              <strong>{result.student_name}</strong> ({result.student_code || t("N/A")}) &bull; {result.session_title} {t("• Môn:")} {result.subject_name || t("N/A")} {result.topic_name ? `(${result.topic_name})` : ''}
            </p>
          </div>
        </div>

        {/* Global Action Buttons */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {!canGrade ? (
            <Badge type="neutral">{t("Chỉ xem (Không phải giám khảo)")}</Badge>
          ) : (
            <>
              {isFinalized ? (
                <Button
                  variant="secondary"
                  icon={<Unlock size={16} />}
                  isLoading={actionLoading === 'reopen'}
                  onClick={handleReopen}
                >{t("Mở lại chấm điểm")}</Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<Lock size={16} />}
                  isLoading={actionLoading === 'finalize'}
                  onClick={handleFinalize}
                  disabled={isScoring}
                >{t("Chốt điểm chính thức")}</Button>
              )}

              <Button
                variant="secondary"
                icon={<RefreshCw size={16} />}
                isLoading={actionLoading === 'regrade' || isScoring}
                onClick={handleRegrade}
                disabled={isScoring || isFinalized}
                title={t("Gửi bài thi để AI chấm lại từ đầu")}
              >
                {isScoring ? t("Đang chấm lại...") : t("Chấm lại bằng AI")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Read-only Examiner Banner */}
      {!canGrade && (
        <div style={{
          backgroundColor: 'rgba(59, 130, 246, 0.08)',
          borderLeft: '4px solid #3b82f6',
          borderRadius: 'var(--radius-md)',
          padding: '0.875rem 1rem',
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}>
          <Lock size={18} style={{ color: '#3b82f6', flexShrink: 0 }} />
          <span style={{ fontSize: '0.875rem', color: 'var(--text-main)' }}>{t("Bạn đang xem kết quả với tư cách giảng viên bộ môn. Chỉ giám khảo được phân công hoặc người tạo kỳ thi mới có quyền điều chỉnh điểm và chốt điểm.")}</span>
        </div>
      )}

      {/* Notification banner */}
      {notification && (
        <Feedback
          type={notification.type}
          message={notification.message}
          className="mb-4"
        />
      )}

      {/* Flag Warning Banner */}
      {isFlagged && (
        <div style={{
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          borderLeft: '4px solid #f59e0b',
          borderRadius: 'var(--radius-md)',
          padding: '1rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
          marginBottom: '1.5rem',
        }}>
          <AlertTriangle size={22} style={{ color: '#d97706', flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong style={{ color: '#b45309', display: 'block', marginBottom: '0.25rem' }}>{t("Bài thi có dấu hiệu bất thường cần giảng viên xác nhận")}</strong>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#92400e' }}>
              {result.flag_reason || t("AI phát hiện một hoặc nhiều câu hỏi có tín hiệu âm thanh hoặc độ tin cậy thấp. Vui lòng nghe lại băng ghi âm và rà soát kỹ rubric.")}
            </p>
          </div>
        </div>
      )}

      {/* Summary Score Bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}>
        <Card className="glass-panel" style={{ borderLeft: '4px solid var(--primary)' }}>
          <CardBody style={{ padding: '1rem 1.25rem' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t("Điểm Tổng Kết (Final Score)")}</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '0.25rem' }}>
              <span style={{ fontSize: '2.4rem', fontWeight: 700, color: 'var(--primary)', lineHeight: 1 }}>
                {result.final_total_score != null ? result.final_total_score : '—'}
              </span>
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>/ 10</span>
            </div>
            {isFinalized && result.finalized_by_name && (
              <span style={{ fontSize: '0.75rem', color: 'var(--secondary)', display: 'block', marginTop: '0.35rem' }}>{t("Chốt bởi:")} {result.finalized_by_name}
              </span>
            )}
          </CardBody>
        </Card>

        <Card className="glass-panel" style={{ borderLeft: '4px solid #8b5cf6' }}>
          <CardBody style={{ padding: '1rem 1.25rem' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t("Điểm Gợi Ý AI (Nova Pro)")}</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '0.25rem' }}>
              <span style={{ fontSize: '2.4rem', fontWeight: 700, color: '#8b5cf6', lineHeight: 1 }}>
                {result.ai_total_score != null ? result.ai_total_score : '—'}
              </span>
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>/ 10</span>
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.35rem' }}>{t("Mô hình: apac.amazon.nova-pro-v1:0")}</span>
          </CardBody>
        </Card>

        <Card className="glass-panel" style={{ borderLeft: '4px solid var(--border)' }}>
          <CardBody style={{ padding: '1rem 1.25rem' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t("Số Câu Hỏi Khảo Thí")}</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '0.25rem' }}>
              <span style={{ fontSize: '2.4rem', fontWeight: 700, color: 'var(--text-main)', lineHeight: 1 }}>
                {evaluations.length}
              </span>
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>{t("câu chính")}</span>
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.35rem' }}>{t("Ngôn ngữ thi:")} {result.exam_language || 'EN'}
            </span>
          </CardBody>
        </Card>
      </div>

      {/* Question Selector Tabs */}
      <div style={{
        display: 'flex',
        gap: '0.5rem',
        borderBottom: '1px solid var(--border)',
        paddingBottom: '0.75rem',
        marginBottom: '1.5rem',
        overflowX: 'auto',
      }}>
        {evaluations.map((ev, idx) => {
          const isActive = idx === activeQuestionIdx;
          const qScore = ev.final_score != null ? ev.final_score : (ev.ai_score != null ? ev.ai_score : '—');
          return (
            <button
              key={ev.question_evaluation_id || idx}
              onClick={() => setActiveQuestionIdx(idx)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1.125rem',
                borderRadius: 'var(--radius-md)',
                border: isActive ? '1px solid var(--primary)' : '1px solid var(--border)',
                backgroundColor: isActive ? 'var(--primary-light, #eef2ff)' : 'var(--surface)',
                color: isActive ? 'var(--primary)' : 'var(--text-main)',
                fontWeight: isActive ? 600 : 500,
                fontSize: '0.875rem',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              <span>{t("Câu")} {idx + 1}</span>
              <span style={{
                fontSize: '0.75rem',
                padding: '0.125rem 0.375rem',
                borderRadius: '9999px',
                backgroundColor: isActive ? 'var(--primary)' : 'var(--surface-alt)',
                color: isActive ? '#fff' : 'var(--text-muted)',
              }}>
                {qScore}/10
              </span>
              {ev.flag_reason && (
                <AlertTriangle size={13} style={{ color: '#d97706' }} title={ev.flag_reason} />
              )}
            </button>
          );
        })}
      </div>

      {/* Main 2-Column Review Workspace */}
      {currentEval ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: '1.5rem', alignItems: 'start' }}>
          
          {/* ================= LEFT COLUMN: Question & Audio Transcripts ================= */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            
            {/* Question Details Card */}
            <Card>
              <CardHeader style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <BookOpen size={18} className="text-primary" />
                  <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t("Câu Hỏi")} {activeQuestionIdx + 1}{t(": Nội dung & Tiêu chuẩn")}</h3>
                </div>
                {currentEval.bloom_level && (
                  <Badge type={BLOOM_BADGE[currentEval.bloom_level] || 'info'}>{t("Bloom:")} {currentEval.bloom_level}
                  </Badge>
                )}
              </CardHeader>
              <CardBody style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-main)', lineHeight: 1.5 }}>
                  {currentEval.question_content || t("N/A")}
                </div>

                {currentEval.key_points && (
                  <div>
                    <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>{t("Key Points (Ý chính mong đợi)")}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                      {asList(currentEval.key_points).map((kp, i) => (
                        <span key={i} style={{ fontSize: '0.8125rem', backgroundColor: 'var(--surface-alt)', padding: '0.2rem 0.5rem', borderRadius: 'var(--radius-sm)' }}>
                          &bull; {asText(kp)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {currentEval.reference_answer && (
                  <div style={{ backgroundColor: 'var(--surface-alt)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>{t("Đáp án tham chiếu (Reference Answer)")}</span>
                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-main)', fontStyle: 'italic', lineHeight: 1.5 }}>
                      "{currentEval.reference_answer}"
                    </p>
                  </div>
                )}

                {/* Question Rationale Accordion (Lecturer only) */}
                {parsedRationale && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                    <button
                      onClick={() => setShowRationale(!showRationale)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.625rem 0.875rem',
                        background: 'var(--surface-alt)',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: 'var(--text-main)',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Lock size={13} style={{ color: 'var(--primary)' }} />{t("Vì sao hỏi câu này? (Rationale & Cơ sở tài liệu - Nội bộ GV)")}</span>
                      {showRationale ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    {showRationale && (
                      <div style={{ padding: '0.875rem', backgroundColor: 'var(--surface)', fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {parsedRationale.purpose && (
                          <div>
                            <strong style={{ color: 'var(--primary)' }}>{t("Mục tiêu sư phạm:")}</strong>
                            <p style={{ margin: '0.2rem 0 0 0', color: 'var(--text-main)' }}>{asText(parsedRationale.purpose)}</p>
                          </div>
                        )}
                        {parsedRationale.syllabus_synthesis && (
                          <div>
                            <strong style={{ color: 'var(--primary)' }}>{t("Liên kết chương trình môn học:")}</strong>
                            <p style={{ margin: '0.2rem 0 0 0', color: 'var(--text-main)' }}>{asText(parsedRationale.syllabus_synthesis)}</p>
                          </div>
                        )}
                        {Array.isArray(parsedRationale.source_materials) && parsedRationale.source_materials.length > 0 && (
                          <div>
                            <strong style={{ color: 'var(--primary)' }}>{t("Tài liệu trích xuất nguồn:")}</strong>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.35rem' }}>
                              {parsedRationale.source_materials.map((src, sIdx) => (
                                <div key={sIdx} style={{ padding: '0.4rem 0.6rem', background: 'var(--surface-alt)', borderRadius: 'var(--radius-sm)' }}>
                                  <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{asText(src?.file_name) || t("Nguồn tài liệu")}</div>
                                  {src?.excerpt && (
                                    <div style={{ fontStyle: 'italic', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                      "{asText(src.excerpt)}"
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </CardBody>
            </Card>

            {/* Turns Transcript & Audio Player Card */}
            <Card>
              <CardHeader>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <MessageSquare size={18} className="text-primary" />
                  <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t("Băng Ghi Âm & Nhật Ký Đối Thoại (")}{currentEval.turns?.length || 0} {t("lượt)")}</h3>
                </div>
              </CardHeader>
              <CardBody style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {(!currentEval.turns || currentEval.turns.length === 0) ? (
                  <p style={{ margin: 0, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.875rem' }}>{t("Không có lượt hỏi đáp nào được ghi nhận cho câu hỏi này.")}</p>
                ) : (
                  currentEval.turns.map((turn, tIdx) => {
                    const isFollowUp = turn.turn_type === 'FOLLOW_UP';
                    return (
                      <div
                        key={turn.qa_turn_id || tIdx}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-md)',
                          padding: '1rem',
                          backgroundColor: isFollowUp ? 'rgba(79, 70, 229, 0.02)' : 'var(--surface)',
                        }}
                      >
                        {/* Turn Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Badge type={isFollowUp ? 'warning' : 'primary'}>
                              {isFollowUp ? t("Follow-up {v0}", {v0: turn.sequence_no}) : t("Câu hỏi chính {v0}", {v0: turn.sequence_no})}
                            </Badge>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t("Trạng thái:")} <strong>{enumLabel(turn.status)}</strong>
                            </span>
                          </div>

                          {/* Speech Signals Chips */}
                          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                            {turn.speech_latency_ms != null && (
                              <span style={{ fontSize: '0.7rem', backgroundColor: 'var(--surface-alt)', padding: '0.15rem 0.4rem', borderRadius: '4px', color: 'var(--text-muted)' }}>{t("Độ trễ:")} {turn.speech_latency_ms}ms
                              </span>
                            )}
                            {turn.speech_duration_ms != null && (
                              <span style={{ fontSize: '0.7rem', backgroundColor: 'var(--surface-alt)', padding: '0.15rem 0.4rem', borderRadius: '4px', color: 'var(--text-muted)' }}>{t("Thời lượng:")} {formatNumber((turn.speech_duration_ms / 1000), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}s
                              </span>
                            )}
                            {turn.words_per_minute != null && (
                              <span style={{ fontSize: '0.7rem', backgroundColor: 'var(--surface-alt)', padding: '0.15rem 0.4rem', borderRadius: '4px', color: 'var(--text-muted)' }}>{t("Tốc độ:")} {turn.words_per_minute} WPM
                              </span>
                            )}
                            {turn.pause_count != null && (
                              <span style={{ fontSize: '0.7rem', backgroundColor: 'var(--surface-alt)', padding: '0.15rem 0.4rem', borderRadius: '4px', color: 'var(--text-muted)' }}>{t("Ngắt quãng:")} {turn.pause_count}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* AI Prompt */}
                        <div style={{ marginBottom: '0.75rem' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary)', textTransform: 'uppercase', display: 'block', marginBottom: '0.15rem' }}>{t("AI Interviewer:")}</span>
                          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-main)', fontWeight: 500 }}>
                            {turn.question_text}
                          </p>
                        </div>

                        {/* Student Answer */}
                        <div style={{ marginBottom: '0.75rem' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--secondary)', textTransform: 'uppercase', display: 'block', marginBottom: '0.15rem' }}>{t("Sinh viên trả lời:")}</span>
                          <div style={{
                            padding: '0.625rem 0.875rem',
                            backgroundColor: 'var(--surface-alt)',
                            borderRadius: 'var(--radius-sm)',
                            borderLeft: '3px solid var(--secondary)',
                            fontSize: '0.875rem',
                            color: 'var(--text-main)',
                            lineHeight: 1.5,
                          }}>
                            {turn.answer_text ? (
                              turn.answer_text
                            ) : (
                              <em style={{ color: 'var(--text-muted)' }}>{t("[Không có câu trả lời hoặc không nhận diện được giọng nói]")}</em>
                            )}
                          </div>
                        </div>

                        {/* Audio Player */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                          <Volume2 size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                          <audio
                            controls
                            src={getTurnAudioUrl(turn.qa_turn_id)}
                            style={{ height: '32px', width: '100%', outline: 'none' }}
                          >{t("Trình duyệt không hỗ trợ audio element.")}</audio>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardBody>
            </Card>
          </div>

          {/* ================= RIGHT COLUMN: AI Scoring & Rubric Adjustment ================= */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            
            {/* AI Question Score & Justification Card */}
            <Card className="glass-panel" style={{ borderTop: '4px solid var(--primary)' }}>
              <CardHeader style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Activity size={18} className="text-primary" />
                  <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t("Đánh Giá Câu Hỏi")}</h3>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {currentEval.confidence != null && (
                    <span style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      padding: '0.2rem 0.5rem',
                      borderRadius: '9999px',
                      backgroundColor: currentEval.confidence >= 0.8 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                      color: currentEval.confidence >= 0.8 ? '#059669' : '#d97706',
                    }}>{t("Độ tin cậy AI:")} {formatNumber((currentEval.confidence * 100), { minimumFractionDigits: 0, maximumFractionDigits: 0 })}%
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardBody style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                
                {/* Score breakdown banner */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: 'var(--surface-alt)', borderRadius: 'var(--radius-md)' }}>
                  <div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block' }}>{t("Điểm Câu")} {activeQuestionIdx + 1}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
                      <span style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--primary)', lineHeight: 1 }}>
                        {currentEval.final_score != null ? currentEval.final_score : (currentEval.ai_score != null ? currentEval.ai_score : '—')}
                      </span>
                      <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>/ 10</span>
                    </div>
                  </div>
                  {currentEval.ai_score != null && currentEval.final_score !== currentEval.ai_score && (
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block' }}>{t("Điểm AI gốc:")}</span>
                      <strong style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>{currentEval.ai_score}/10</strong>
                    </div>
                  )}
                </div>

                {/* AI Qualitative Feedback */}
                {currentEval.strengths && (
                  <div>
                    <strong style={{ fontSize: '0.8125rem', color: '#059669', display: 'block', marginBottom: '0.2rem' }}>{t("Điểm mạnh:")}</strong>
                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-main)', lineHeight: 1.4 }}>
                      {currentEval.strengths}
                    </p>
                  </div>
                )}

                {currentEval.weaknesses && (
                  <div>
                    <strong style={{ fontSize: '0.8125rem', color: '#d97706', display: 'block', marginBottom: '0.2rem' }}>{t("Điểm cần cải thiện:")}</strong>
                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-main)', lineHeight: 1.4 }}>
                      {currentEval.weaknesses}
                    </p>
                  </div>
                )}

                {Array.isArray(currentEval.missing_points) && currentEval.missing_points.length > 0 && (
                  <div>
                    <strong style={{ fontSize: '0.8125rem', color: '#dc2626', display: 'block', marginBottom: '0.25rem' }}>{t("Ý còn thiếu (Missing Points):")}</strong>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                      {currentEval.missing_points.map((mp, mIdx) => (
                        <span key={mIdx} style={{ fontSize: '0.75rem', backgroundColor: 'rgba(239, 68, 68, 0.08)', color: '#b91c1c', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                          &bull; {asText(mp)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {currentEval.feedback && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                    <strong style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.2rem' }}>{t("Nhận xét tổng quan AI:")}</strong>
                    <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)', lineHeight: 1.5, fontStyle: 'italic' }}>
                      "{currentEval.feedback}"
                    </p>
                  </div>
                )}
              </CardBody>
            </Card>

            {/* Rubric Criteria & Score Adjustments Card */}
            <Card>
              <CardHeader>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Award size={18} className="text-primary" />
                  <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t("Tiêu Chí Rubric & Điều Chỉnh Điểm")}</h3>
                </div>
              </CardHeader>
              <CardBody style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {(!currentEval.criteria || currentEval.criteria.length === 0) ? (
                  <p style={{ margin: 0, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.875rem' }}>{t("Chưa có tiêu chí rubric được gán cho câu hỏi này.")}</p>
                ) : (
                  currentEval.criteria.map((crit, cIdx) => {
                    const adjState = adjustments[crit.criterion_score_id] || { score: crit.final_score ?? crit.ai_score ?? 0, reason: '', isEditing: false };
                    const isEditing = adjState.isEditing;
                    const maxScore = Number(crit.criterion_max_score || 10);
                    const currentScore = crit.final_score != null ? Number(crit.final_score) : (crit.ai_score != null ? Number(crit.ai_score) : 0);
                    const isSaving = actionLoading === `save_${crit.criterion_score_id}`;

                    return (
                      <div
                        key={crit.criterion_score_id || cIdx}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-md)',
                          padding: '1rem',
                          backgroundColor: isEditing ? 'rgba(79, 70, 229, 0.02)' : 'var(--surface)',
                        }}
                      >
                        {/* Criterion Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                          <div>
                            <strong style={{ fontSize: '0.95rem', color: 'var(--text-main)', display: 'block' }}>
                              {crit.criterion_name}
                            </strong>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t("Trọng số:")} {crit.criterion_weight}{t("% • Tối đa:")} {maxScore} {t("điểm")}</span>
                          </div>
                          
                          {/* Score Badge */}
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--primary)' }}>
                              {currentScore}
                            </span>
                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}> / {maxScore}</span>
                          </div>
                        </div>

                        {/* Level Info */}
                        {crit.level_label && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <Badge type="info" style={{ marginRight: '0.5rem' }}>{t("Mức đạt:")} {crit.level_label}
                            </Badge>
                            {crit.level_description && (
                              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                                {crit.level_description}
                              </span>
                            )}
                          </div>
                        )}

                        {/* AI Justification */}
                        {crit.ai_justification && (
                          <div style={{ margin: '0.5rem 0', fontSize: '0.875rem', color: 'var(--text-main)' }}>
                            <strong style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '0.15rem' }}>{t("Giải trình AI:")}</strong>
                            <p style={{ margin: 0, lineHeight: 1.4 }}>{crit.ai_justification}</p>
                          </div>
                        )}

                        {/* Evidence Quotes */}
                        {Array.isArray(crit.evidence) && crit.evidence.length > 0 && (
                          <div style={{ margin: '0.5rem 0' }}>
                            <strong style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '0.2rem' }}>{t("Trích dẫn chứng cứ từ câu trả lời:")}</strong>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                              {crit.evidence.map((evItem, evIdx) => (
                                <div key={evIdx} style={{ fontSize: '0.8125rem', fontStyle: 'italic', color: 'var(--text-muted)', backgroundColor: 'var(--surface-alt)', padding: '0.25rem 0.5rem', borderRadius: '4px' }}>
                                  <Quote size={11} style={{ display: 'inline', marginRight: '4px' }} />
                                  "{asText(evItem)}"
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Adjustment Controls */}
                        {!canGrade ? (
                          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Lock size={12} /> {t("Bạn chỉ có quyền xem, chỉ giám khảo hoặc người tạo kỳ thi mới có thể điều chỉnh điểm.")}</div>
                        ) : !isFinalized ? (
                          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
                            {!isEditing ? (
                              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  icon={<Edit2 size={13} />}
                                  onClick={() => toggleEditing(crit.criterion_score_id)}
                                >{t("Điều chỉnh điểm")}</Button>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '0.75rem', alignItems: 'flex-start' }}>
                                  <Input
                                    label={t("Điểm mới (0-{v0})", {v0: maxScore})}
                                    type="number"
                                    step="0.25"
                                    min="0"
                                    max={maxScore}
                                    value={adjState.score}
                                    onChange={(e) => handleScoreChange(crit.criterion_score_id, 'score', e.target.value)}
                                  />
                                  <Textarea
                                    label={t("Lý do điều chỉnh (Bắt buộc)")}
                                    rows={2}
                                    placeholder={t("Nêu rõ lý do thay đổi điểm so với gợi ý của AI...")}
                                    value={adjState.reason}
                                    onChange={(e) => handleScoreChange(crit.criterion_score_id, 'reason', e.target.value)}
                                  />
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    icon={<X size={13} />}
                                    onClick={() => toggleEditing(crit.criterion_score_id)}
                                    disabled={isSaving}
                                  >{t("Hủy")}</Button>
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    icon={<Save size={13} />}
                                    isLoading={isSaving}
                                    onClick={() => handleSaveAdjustment(crit.criterion_score_id, maxScore)}
                                  >{t("Lưu điểm")}</Button>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            <Lock size={12} /> {t("Bài thi đã chốt điểm. Mở lại bài thi để sửa.")}</div>
                        )}
                      </div>
                    );
                  })
                )}
              </CardBody>
            </Card>

            {/* Score Adjustments Audit Trail */}
            {scoreAdjustments.length > 0 && (
              <Card>
                <CardHeader>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <FileText size={18} className="text-primary" />
                    <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t("Lịch Sử Điều Chỉnh Điểm (")}{scoreAdjustments.length})
                    </h3>
                  </div>
                </CardHeader>
                <CardBody style={{ padding: 0 }}>
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>{t("Tiêu chí")}</Th>
                        <Th>{t("Thay đổi")}</Th>
                        <Th>{t("Lý do")}</Th>
                        <Th>{t("Người sửa")}</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {scoreAdjustments.map((sa, aIdx) => (
                        <Tr key={sa.adjustment_id || aIdx}>
                          <Td style={{ fontWeight: 600 }}>{sa.criterion_name || t("Tiêu chí")}</Td>
                          <Td>
                            <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)', marginRight: '4px' }}>
                              {sa.old_score}
                            </span>
                            &rarr;
                            <strong style={{ color: 'var(--primary)', marginLeft: '4px' }}>
                              {sa.new_score}
                            </strong>
                          </Td>
                          <Td style={{ fontSize: '0.8125rem' }}>{sa.reason}</Td>
                          <Td style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                            {sa.adjusted_by_name || t("Giảng viên")}<br />
                            <small>{sa.adjusted_at ? new Date(sa.adjusted_at).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : ''}</small>
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </CardBody>
              </Card>
            )}

          </div>
        </div>
      ) : (
        <Card>
          <CardBody style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>{t("Chưa có thông tin đánh giá câu hỏi.")}</CardBody>
        </Card>
      )}
    </div>
  );
}
