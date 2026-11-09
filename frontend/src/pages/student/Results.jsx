import { t, useLocale, formatNumber, translateMessage } from '../../i18n/index';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Award, BookOpen, Calendar, ArrowRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { LoadingSpinner } from '../../components/ui/Loading';
import { Feedback } from '../../components/ui/Feedback';
import { Table, Thead, Tbody, Tr, Th, Td } from '../../components/ui/Table';
import { listMyResults } from '../../services/studentApi';
import { formatDateTime } from '../../shared/utils/formatDate';
import { useBusinessEvents } from '../../hooks/useBusinessEvents';

export default function StudentResults() {
  useLocale();
  const navigate = useNavigate();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) { setLoading(true); setError(null); }
      const data = await listMyResults();
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      if (!silent) setError(err.message || t("Không thể tải kết quả thi."));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Own finalized/reopened results (and reconnects) refresh the list.
  useBusinessEvents(['result'], () => { load({ silent: true }); });

  const getScoreBadgeType = (score) => {
    if (score >= 8.5) return 'success';
    if (score >= 6.5) return 'info';
    if (score >= 5.0) return 'warning';
    return 'danger';
  };

  return (
    <div className="animate-fade-in" style={{ maxWidth: '1000px', margin: '0 auto', paddingBottom: '3rem' }}>
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.75rem', fontWeight: '700', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Award size={28} style={{ color: 'var(--primary, #4f46e5)' }} />{t("Kết Quả Thi Viva")}</h2>
        <p style={{ color: 'var(--text-muted)' }}>{t("Danh sách kết quả thi vấn đáp chính thức đã được giảng viên chốt điểm")}</p>
      </div>

      {error && (
        <div style={{ marginBottom: '1.5rem' }}>
          <Feedback type="error" message={translateMessage(error)} onClose={() => setError(null)} />
        </div>
      )}

      {loading ? (
        <div style={{ padding: '4rem', display: 'flex', justifyContent: 'center' }}>
          <LoadingSpinner size={36} text={t("Đang tải kết quả thi...")} />
        </div>
      ) : results.length === 0 ? (
        <Card>
          <CardBody style={{ textAlign: 'center', padding: '4rem 2rem' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'var(--primary-light, #e0e7ff)', color: 'var(--primary, #4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
              <BookOpen size={32} />
            </div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '0.5rem' }}>{t("Chưa có kết quả thi chính thức")}</h3>
            <p style={{ color: 'var(--text-muted)', maxWidth: '420px', margin: '0 auto' }}>{t("Các bài thi của bạn đang trong quá trình chấm điểm hoặc chưa được giảng viên chốt điểm chính thức. Vui lòng quay lại sau.")}</p>
          </CardBody>
        </Card>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <Card>
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("Môn học")}</Th>
                  <Th>{t("Kỳ thi")}</Th>
                  <Th>{t("Ngày chốt điểm")}</Th>
                  <Th style={{ textAlign: 'center' }}>{t("Điểm tổng kết")}</Th>
                  <Th style={{ textAlign: 'right' }}>{t("Thao tác")}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {results.map((r) => {
                  const score = Number(r.totalScore ?? 0);
                  return (
                    <Tr key={r.resultId}>
                      <Td>
                        <div style={{ fontWeight: '600', color: 'var(--primary, #4f46e5)' }}>
                          {r.subjectCode || t("N/A")}
                        </div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                          {r.subjectName || t("Không có tên môn")}
                        </div>
                      </Td>
                      <Td>
                        <div style={{ fontWeight: '500' }}>{r.examTitle}</div>
                        {r.topicName && (
                          <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{t("Chủ đề:")} {r.topicName}
                          </div>
                        )}
                      </Td>
                      <Td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.875rem' }}>
                          <Calendar size={14} style={{ color: 'var(--text-muted)' }} />
                          {formatDateTime(r.finalizedAt)}
                        </div>
                      </Td>
                      <Td style={{ textAlign: 'center' }}>
                        <Badge type={getScoreBadgeType(score)} style={{ fontSize: '0.95rem', fontWeight: '700', padding: '0.25rem 0.6rem' }}>
                          {formatNumber(score, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / 10
                        </Badge>
                      </Td>
                      <Td style={{ textAlign: 'right' }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<ArrowRight size={14} />}
                          onClick={() => navigate(`/student/results/${r.resultId}`, {
                            state: {
                              interviewId: r.interviewId || r.interview_id,
                              examSessionId: r.examSessionId,
                            },
                          })}
                        >{t("Chi tiết")}</Button>
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
