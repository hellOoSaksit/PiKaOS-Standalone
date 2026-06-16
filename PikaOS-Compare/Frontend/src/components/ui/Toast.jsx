import { createContext, useCallback, useContext, useState } from 'react';

const ToastCtx = createContext(null);

/**
 * ToastProvider — wrap the app. Exposes useToast() → toast(msg, type).
 * type: "ok" | "err". Card springs up bottom-right, auto-dismiss 3s.
 */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const remove = useCallback((id) => {
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 250);
  }, []);

  const toast = useCallback((msg, type = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setItems((list) => [...list, { id, msg, type }]);
    setTimeout(() => remove(id), 3000);
  }, [remove]);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-stack">
        {items.map((t) => (
          <div key={t.id} className={'toast ' + t.type + (t.leaving ? ' leaving' : '')} role="status">
            <span className="t-ic">{t.type === 'err' ? '✕' : '✓'}</span>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) return () => {};
  return ctx;
}
