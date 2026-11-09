import { t } from '../i18n/index';

export default function ExamCounts({ counts }) {
  const c = counts || { inProgress: 0, completed: 0 };
  return (
    <>
      <div>{c.inProgress} {t('in progress')}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{c.completed} {t('completed')}</div>
    </>
  );
}
