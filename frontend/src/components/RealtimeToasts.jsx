import { t } from '../i18n/index';
import { useAuth } from '../contexts/AuthContext';
import { useBusinessEvents } from '../hooks/useBusinessEvents';
import { showToast } from './ui/Toast';

// Important-event toasts. Pages do their own refetch; this only announces.
function Announcer({ role }) {
  useBusinessEvents(['exam', 'result'], (event) => {
    if (!event) return;
    if (role === 'STUDENT') {
      if (event.entity === 'exam' && event.action === 'status_changed') {
        if (event.status === 'OPEN') showToast(t('An exam session is now open.'), 'info');
        if (event.status === 'CLOSED') showToast(t('An exam session has closed.'), 'warning');
      }
      if (event.entity === 'result' && event.action === 'finalized') {
        showToast(t('Your exam result has been finalized.'), 'success');
      }
    } else if (role === 'LECTURER' && event.entity === 'result'
      && event.action === 'status_changed' && ['AI_SUGGESTED', 'FLAGGED'].includes(event.status)) {
      showToast(t('AI grading finished for an interview.'), 'info');
    }
  });
  return null;
}

export default function RealtimeToasts() {
  const { user } = useAuth() || {};
  if (!user || !['STUDENT', 'LECTURER'].includes(user.role)) return null;
  return <Announcer key={user.role} role={user.role} />;
}
