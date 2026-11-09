import { useEffect, useState } from 'react';

const listeners = new Set();
let nextId = 1;

// Fire-and-forget toast from anywhere (pages, hooks).
export function showToast(message, type = 'info') {
  const toast = { id: nextId++, message, type };
  listeners.forEach((fn) => fn(toast));
}

const COLORS = {
  info: '#2563eb', success: '#16a34a', warning: '#d97706', error: '#dc2626',
};

export function ToastHost() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const add = (toast) => {
      setToasts((list) => [...list.slice(-3), toast]);
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== toast.id)), 6000);
    };
    listeners.add(add);
    return () => listeners.delete(add);
  }, []);
  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 2000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            background: 'var(--surface, #fff)', color: 'var(--text, #111827)', borderLeft: `4px solid ${COLORS[toast.type] || COLORS.info}`, borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.18)', padding: '0.75rem 1rem', fontSize: '0.9rem',
          }}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
