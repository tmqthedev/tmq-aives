import { useCallback, useEffect, useState } from 'react';
import { useBusinessEvents } from './useBusinessEvents';

// Per-exam { inProgress, completed } counts (counts only, no student data).
// `fetchCounts` resolves to { counts: { [examSessionId]: { inProgress, completed } } }.
// Refetched on interview events and after every (re)connect.
export function useExamCounts(fetchCounts) {
  const [counts, setCounts] = useState({});
  const refresh = useCallback(async () => {
    try {
      const data = await fetchCounts();
      setCounts(data?.counts || {});
    } catch {
      // Counts are supplementary; the exam list still works without them.
    }
  }, [fetchCounts]);
  useEffect(() => { refresh(); }, [refresh]);
  useBusinessEvents(['interview', 'exam'], () => { refresh(); });
  return counts;
}
