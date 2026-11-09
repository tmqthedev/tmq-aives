import { t, useLocale } from '../../i18n/index';
import { useState, useEffect } from 'react';
import { MessageSquare, AlertCircle, CheckCircle, Send, X, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { LoadingSpinner } from '../ui/Loading';
import { Feedback } from '../ui/Feedback';
import { getInterviewTranscript, disputeTurnStt } from '../../services/studentExamApi';
import { formatDateTime } from '../../shared/utils/formatDate';
import { errorMessage as localizedErrorMessage } from '../../i18n/core';

export default function TranscriptHistory({
  interviewId,
  turns: propTurns,
  onTurnsUpdate,
  currentTurnId = null,
  isRecording = false,
  isFinalized = false,
}) {
  useLocale();

  const [internalTurns, setInternalTurns] = useState([]);
  const [loading, setLoading] = useState(() => propTurns === undefined && Boolean(interviewId));
  const [error, setError] = useState(null);

  // Dispute state
  const [disputingTurnId, setDisputingTurnId] = useState(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const [disputeError, setDisputeError] = useState(null);
  const [disputeDisabledByFinalized, setDisputeDisabledByFinalized] = useState(isFinalized);

  const activeTurns = propTurns !== undefined ? propTurns : internalTurns;

  useEffect(() => {
    if (propTurns === undefined && interviewId) {
      let cancelled = false;
      getInterviewTranscript(interviewId)
        .then((data) => {
          if (!cancelled) {
            const fetchedTurns = Array.isArray(data?.turns) ? data.turns : [];
            setInternalTurns(fetchedTurns);
            if (typeof onTurnsUpdate === 'function') {
              onTurnsUpdate(fetchedTurns);
            }
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err.message || t("Không thể tải lịch sử câu trả lời."));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }
  }, [propTurns, interviewId, onTurnsUpdate]);

  const handleOpenDispute = (turn) => {
    setDisputingTurnId(turn.turnId);
    setDisputeNote('');
    setDisputeError(null);
  };

  const handleCloseDispute = () => {
    setDisputingTurnId(null);
    setDisputeNote('');
    setDisputeError(null);
  };

  const handleSubmitDispute = async (turnId) => {
    if (!disputeNote.trim()) {
      setDisputeError(t("Vui lòng nhập mô tả lỗi nhận dạng."));
      return;
    }

    try {
      setSubmittingDispute(true);
      setDisputeError(null);
      const res = await disputeTurnStt(interviewId, turnId, disputeNote.trim());

      const updateList = (prev) =>
        prev.map((turn) =>
          turn.turnId === turnId
            ? { ...turn, sttDisputed: true, sttDisputeNote: res.sttDisputeNote || disputeNote.trim() }
            : turn
        );

      setInternalTurns((prev) => updateList(prev));
      if (typeof onTurnsUpdate === 'function') {
        onTurnsUpdate((prev) => updateList(prev || []));
      }
      handleCloseDispute();
    } catch (err) {
      if (err.status === 409 || err.code === 'RESULT_FINALIZED') {
        setDisputeDisabledByFinalized(true);
      }
      setDisputeError(err.code ? localizedErrorMessage(err) : err.message || t("Không thể gửi báo lỗi nhận dạng."));
    } finally {
      setSubmittingDispute(false);
    }
  };

  if (loading && activeTurns.length === 0) {
    return (
      <Card style={{ marginTop: '1.5rem' }}>
        <CardBody style={{ textAlign: 'center', padding: '2.5rem' }}>
          <LoadingSpinner size={28} text={t("Đang tải nhật ký câu trả lời...")} />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card style={{ marginTop: '1.5rem', border: '1px solid var(--border)' }}>
      <CardHeader style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', padding: '1rem 1.25rem', background: 'var(--surface-alt, #f8fafc)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <MessageSquare size={18} style={{ color: 'var(--primary, #4f46e5)' }} />
          <h3 style={{ fontSize: '1.05rem', fontWeight: '700', margin: 0 }}>
            {t("Nhật ký hỏi đáp & Nhận dạng giọng nói")}
          </h3>
          <Badge type="neutral" style={{ fontSize: '0.75rem' }}>
            {activeTurns.length} {t("câu")}
          </Badge>
        </div>
      </CardHeader>

      <CardBody style={{ padding: '1.25rem' }}>
        {error && (
          <div style={{ marginBottom: '1rem' }}>
            <Feedback type="error" message={error} onClose={() => setError(null)} />
          </div>
        )}

        {disputeError && (
          <div style={{ marginBottom: '1rem' }}>
            <Feedback type="error" message={disputeError} onClose={() => setDisputeError(null)} />
          </div>
        )}

        {disputeDisabledByFinalized && (
          <div style={{ marginBottom: '1rem', padding: '0.625rem 0.875rem', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#b91c1c' }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{t("Bài thi đã chốt điểm. Mở lại bài thi để sửa.")}</span>
          </div>
        )}

        {activeTurns.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)' }}>
            <MessageSquare size={32} style={{ margin: '0 auto 0.5rem auto', opacity: 0.5 }} />
            <p style={{ margin: 0, fontSize: '0.9rem' }}>
              {t("Chưa có câu hỏi nào được trả lời. Các câu hỏi và văn bản nhận dạng sẽ xuất hiện tại đây sau khi bạn nộp câu trả lời.")}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {activeTurns.map((turn, index) => {
              const isCurrentTurn = turn.turnId === currentTurnId;
              const currentlyRecordingThis = isCurrentTurn && isRecording;
              const isDisputingThis = disputingTurnId === turn.turnId;

              return (
                <div
                  key={turn.turnId || index}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '1rem',
                    background: 'var(--surface)',
                  }}
                >
                  {/* Turn Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Badge type={turn.turnType === 'FOLLOW_UP' ? 'warning' : 'info'}>
                        {turn.turnType === 'FOLLOW_UP'
                          ? t("Câu hỏi phụ")
                          : t("Câu hỏi")} {turn.sequenceNo ?? index + 1}
                      </Badge>
                      {turn.answeredAt && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {formatDateTime(turn.answeredAt)}
                        </span>
                      )}
                    </div>

                    <div>
                      {turn.sttDisputed ? (
                        <Badge type="warning" title={turn.sttDisputeNote || t("Đã báo nhận dạng sai")}>
                          <CheckCircle size={12} style={{ marginRight: '4px' }} />
                          {t("Đã báo")}
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disputeDisabledByFinalized || isFinalized || currentlyRecordingThis || (!turn.transcript && !turn.answeredAt)}
                          onClick={() => handleOpenDispute(turn)}
                          title={disputeDisabledByFinalized || isFinalized ? t("Bài thi đã chốt điểm") : t("Báo giảng viên nếu văn bản nhận dạng sai nội dung bạn nói")}
                        >
                          <AlertTriangle size={13} style={{ marginRight: '4px' }} />
                          {t("Báo nhận dạng sai")}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Question Text */}
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.2rem' }}>
                      {t("Câu hỏi:")}
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: '600', color: 'var(--text-main)' }}>
                      {turn.questionText || t("Đang tải nội dung câu hỏi...")}
                    </div>
                  </div>

                  {/* Student Answer Transcript */}
                  <div>
                    <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.2rem' }}>
                      {t("Câu trả lời của bạn:")}
                    </div>

                    {currentlyRecordingThis ? (
                      <div style={{ fontStyle: 'italic', color: '#ef4444', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                        {t("Đang ghi âm câu trả lời...")}
                      </div>
                    ) : !turn.transcript ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.875rem', padding: '0.5rem', background: 'var(--bg-subtle, rgba(0,0,0,0.02))', borderRadius: '6px' }}>
                        <LoadingSpinner size={14} />
                        <span>{t("Đang nhận dạng…")}</span>
                      </div>
                    ) : (
                      <div
                        style={{
                          fontSize: '0.9rem',
                          lineHeight: 1.5,
                          padding: '0.625rem 0.875rem',
                          background: 'var(--bg-subtle, rgba(0,0,0,0.02))',
                          borderRadius: '6px',
                          borderLeft: '3px solid var(--primary, #4f46e5)',
                          color: 'var(--text-main)',
                        }}
                      >
                        "{turn.transcript}"
                      </div>
                    )}
                  </div>

                  {turn.sttDisputed && turn.sttDisputeNote && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#b45309', background: 'rgba(245, 158, 11, 0.08)', padding: '0.4rem 0.6rem', borderRadius: '4px' }}>
                      <strong>{t("Ghi chú báo lỗi:")}</strong> {turn.sttDisputeNote}
                    </div>
                  )}

                  {/* Inline Dispute Form */}
                  {isDisputingThis && (
                    <div
                      style={{
                        marginTop: '0.75rem',
                        padding: '0.75rem',
                        background: 'var(--surface-alt, #f8fafc)',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: '600' }}>
                          {t("Báo lỗi nhận dạng giọng nói")}
                        </span>
                        <Button size="sm" variant="secondary" onClick={handleCloseDispute}>
                          <X size={14} />
                        </Button>
                      </div>

                      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 0.5rem 0' }}>
                        {t("Giảng viên sẽ nghe lại đoạn ghi âm gốc để xem xét và chấm điểm chính xác.")}
                      </p>

                      <textarea
                        rows={2}
                        value={disputeNote}
                        onChange={(e) => setDisputeNote(e.target.value)}
                        placeholder={t("Ví dụ: Nhận dạng nhầm từ 'cấu trúc' thành 'cầu trúc'...")}
                        style={{
                          width: '100%',
                          padding: '0.5rem',
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          fontSize: '0.85rem',
                          marginBottom: '0.5rem',
                          resize: 'vertical',
                          boxSizing: 'border-box',
                        }}
                      />

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                        <Button size="sm" variant="secondary" onClick={handleCloseDispute}>
                          {t("Hủy")}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={submittingDispute || !disputeNote.trim()}
                          onClick={() => handleSubmitDispute(turn.turnId)}
                          icon={<Send size={13} />}
                        >
                          {submittingDispute ? t("Đang gửi...") : t("Gửi báo cáo")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
