import { useEffect } from 'react';

/**
 * Modal — overlay (blur) + spring-pop dialog. Controlled via `open`.
 * Esc / overlay-click → onClose. footer is right-aligned (pass via `footer`).
 */
export default function Modal({ open, onClose, title, children, footer, className = '' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={'pk-overlay' + (open ? ' open' : '')} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div className={'pk-modal' + (className ? ' ' + className : '')} role="dialog" aria-modal="true">
        {title && <h3>{title}</h3>}
        {typeof children === 'string' ? <p>{children}</p> : children}
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}
