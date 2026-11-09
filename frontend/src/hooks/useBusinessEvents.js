import { useEffect, useRef } from 'react';
import { subscribeBusinessEvents } from '../services/businessSocket';

// Subscribe to /business invalidation events for the given entities.
// onEvent(event) runs for each matching event; it also runs with no argument
// on every (re)connect snapshot so the page can refetch after a gap.
// The latest onEvent is used without re-opening the socket.
export function useBusinessEvents(entities, onEvent) {
  const handler = useRef(onEvent);
  useEffect(() => { handler.current = onEvent; });
  const key = [].concat(entities).join(',');
  useEffect(
    () => subscribeBusinessEvents((event) => handler.current?.(event), key.split(',')),
    [key],
  );
}
