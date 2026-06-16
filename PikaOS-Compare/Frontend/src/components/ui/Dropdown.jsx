import { useEffect, useRef, useState } from 'react';

function useOutside(ref, onClose, open) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, onClose, ref]);
}

/**
 * Select — single-select dropdown. options: [{value,label,disabled?}] or [string].
 * Selected = gold + ✓. Supports `disabled`, `block` (full width), `style`, `className`.
 */
export function Select({ options = [], value, onChange, placeholder = 'Select…', minWidth = 200, disabled = false, block = false, style, className = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const cur = norm.find((o) => o.value === value);
  return (
    <div
      className={'dd' + (open ? ' open' : '') + (disabled ? ' is-disabled' : '') + (className ? ' ' + className : '')}
      ref={ref}
      style={{ display: block ? 'block' : 'inline-block', ...style }}
    >
      <button
        type="button"
        className="dd-btn"
        style={{ minWidth, width: block ? '100%' : undefined }}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className="dd-value">{cur ? cur.label : placeholder}</span>
        <span className="dd-caret">▼</span>
      </button>
      <div className="dd-menu" role="listbox">
        {norm.map((o, i) => (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            className={'dd-item' + (o.value === value ? ' selected' : '')}
            style={{ '--i': i }}
            onClick={() => { if (o.disabled) return; onChange && onChange(o.value); setOpen(false); }}
          >
            {o.label} <span className="tick">✓</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Menu — action dropdown. items: [{label,onSelect,danger}]. Closes on pick.
 */
export function Menu({ label = 'Actions', items = [], minWidth = 140 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <div className={'dd' + (open ? ' open' : '')} ref={ref}>
      <button type="button" className="dd-btn" style={{ minWidth }} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="dd-value">{label}</span>
        <span className="dd-caret">▼</span>
      </button>
      <div className="dd-menu" role="menu" style={{ minWidth: 180 }}>
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            className="dd-item"
            style={{ '--i': i, ...(it.danger ? { color: 'var(--crimson)' } : null) }}
            onClick={() => { it.onSelect && it.onSelect(); setOpen(false); }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const MsCheck = () => (
  <svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5L10 17.5L19 7" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/**
 * MultiSelect — facet dropdown; menu stays open while picking; trigger shows a count pill.
 * options: [{value,label}], values: string[], onChange(values)
 */
export function MultiSelect({ label = 'Filter', options = [], values = [], onChange, minWidth = 150 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const toggle = (v) => {
    const has = values.includes(v);
    onChange && onChange(has ? values.filter((x) => x !== v) : [...values, v]);
  };
  return (
    <div className={'dd' + (open ? ' open' : '')} ref={ref}>
      <button type="button" className="dd-btn" style={{ minWidth }} onClick={() => setOpen((o) => !o)}>
        <span className="dd-value">{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {values.length > 0 && <span className="ms-num">{values.length}</span>}
          <span className="dd-caret">▼</span>
        </span>
      </button>
      <div className="dd-menu" role="listbox" onClick={(e) => e.stopPropagation()}>
        {norm.map((o, i) => (
          <button
            key={o.value}
            type="button"
            className={'ms-item' + (values.includes(o.value) ? ' on' : '')}
            style={{ '--i': i }}
            onClick={() => toggle(o.value)}
          >
            <span className="ms-box"><MsCheck /></span>
            <span className="ms-label">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default Select;
