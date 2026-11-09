import { io } from 'socket.io-client';

export function subscribeBusinessEvents(onChange, entities = ['exam']) {
  const watchedEntities = new Set(entities);
  const socket = io('/business', {
    transports: ['websocket', 'polling'],
    withCredentials: true,
    autoConnect: false,
  });
  socket.on('business:snapshot', () => onChange());
  socket.on('business:invalidation', (event) => {
    if (watchedEntities.has(event?.entity)) onChange(event);
  });
  socket.connect();
  return () => socket.disconnect();
}
