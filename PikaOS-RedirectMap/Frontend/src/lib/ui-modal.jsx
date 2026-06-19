/* PiKaOs — ES module (migrated from PiKaOs/ui-modal.jsx). */
import React from 'react';
const { useState, useEffect } = React;

/* ============================================================
   UI MODAL — in-app confirm / prompt / alert (replaces native
   window.confirm & window.prompt). Imperative API returns a
   Promise; supports danger styling, a text input (prompt), and
   two-step confirmation for destructive / overwrite actions.
     await uiConfirm({ title, message, danger, twoStep })  -> bool
     await uiPrompt({ title, message, defaultValue })       -> string|false
     await uiAlert({ title, message })                      -> true
   ============================================================ */
(function () {
  let current = null; let subs = [];
  const emit = () => subs.forEach(fn => fn());
  window.__getModal = () => current;
  window.__subModal = (fn) => { subs.push(fn); return () => { subs = subs.filter(x => x !== fn); }; };
  window.uiConfirm = (opts = {}) => new Promise(res => { current = { opts, resolve: (v) => { current = null; emit(); res(v); } }; emit(); });
  window.uiPrompt = (opts = {}) => window.uiConfirm({ ...opts, input: true });
  window.uiAlert = (opts = {}) => window.uiConfirm({ ...opts, alert: true });
})();

function UIModalHost() {
  const [, force] = React.useReducer(x => x + 1, 0);
  const [val, setVal] = useState("");
  const [armed, setArmed] = useState(false);
  const [count, setCount] = useState(0);
  useEffect(() => window.__subModal(() => {
    const m = window.__getModal();
    setVal((m && m.opts && m.opts.defaultValue) || "");
    setArmed(false); force();
  }), []);
  const m = window.__getModal();
  // delete-style confirms (move-to-trash / delete) get a red button + safety countdown
  const _o = m ? m.opts : null;
  const isDelete = !!_o && !_o.alert && !_o.input && /ลบ|ถังขยะ|trash|delete|ทิ้ง/i.test((_o.title || "") + " " + (_o.message || ""));
  const destructive = !!_o && (_o.danger || isDelete);
  // 3-second safety countdown on destructive confirms (and the 2nd step of two-step)
  const needsCountdown = !!m && destructive && (!m.opts.twoStep || armed);
  useEffect(() => {
    if (!needsCountdown) { setCount(0); return; }
    setCount(3);
    const iv = setInterval(() => setCount(c => { if (c <= 1) { clearInterval(iv); return 0; } return c - 1; }), 1000);
    return () => clearInterval(iv);
  }, [m, armed, needsCountdown]);
  if (!m) return null;
  const o = m.opts;
  const ok = () => {
    if (count > 0) return;
    if (o.twoStep && !armed) { setArmed(true); return; }
    if (o.input) { const v = val.trim(); if (!v) return; m.resolve(v); return; }
    m.resolve(true);
  };
  const cancel = () => m.resolve(false);
  const baseLabel = o.twoStep && armed ? (o.confirmText2 || "ยืนยันถาวร") : (o.confirmText || "ตกลง");
  // centered status icon + delete-style (red) confirm button
  const iconCls = o.alert ? "info" : (destructive ? "trash" : "ask");
  const iconGlyph = o.icon || (o.alert ? "i" : (destructive ? "🗑" : "?"));
  const confirmKind = destructive ? "btn-danger" : "btn-gold";
  return (
    <div className="pk-overlay open" onClick={cancel}>
      <div className="pk-modal status" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className={`status-ic ${iconCls}`}>{iconGlyph}</div>
        <h3>{o.title || "ยืนยัน"}</h3>
        {o.message && <p>{o.message}</p>}
        {o.input && <input className="pk-input" autoFocus value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") ok(); if (e.key === "Escape") cancel(); }} placeholder={o.placeholder || ""} />}
        {o.twoStep && armed && <div className="pk-warn">⚠️ {o.warnText || "กดยืนยันอีกครั้งเพื่อดำเนินการถาวร — การกระทำนี้ย้อนกลับไม่ได้"}</div>}
        <div className="pk-foot">
          {!o.alert && <button className="btn btn-ghost" onClick={cancel}>{o.cancelText || "ยกเลิก"}</button>}
          <button className={`btn ${confirmKind} ${count > 0 ? "is-counting" : ""}`} onClick={ok} disabled={count > 0}>
            {baseLabel}{count > 0 && <span className="btn-cd">{count}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
Object.assign(window, { UIModalHost });

/* ============================================================
   UI LOADING — imperative popup loader (module).
     const h = uiLoading("กำลังบันทึก…");   // or { title, message }
     h.update("กำลังส่งให้ HERMES…");        // change text
     h.close();                              // dismiss
   Mount <UILoadingHost /> once near the app root.
   ============================================================ */
(function () {
  let cur = null; let subs = [];
  const emit = () => subs.forEach(fn => fn());
  window.__getLoading = () => cur;
  window.__subLoading = (fn) => { subs.push(fn); return () => { subs = subs.filter(x => x !== fn); }; };
  window.uiLoading = (opts = {}) => {
    if (typeof opts === "string") opts = { message: opts };
    cur = { title: "กำลังโหลด", ...opts, _id: Date.now() }; emit();
    const handle = {
      update: (o) => { if (cur) { cur = { ...cur, ...(typeof o === "string" ? { message: o } : o) }; emit(); } return handle; },
      close: () => { cur = null; emit(); },
    };
    handle.done = handle.close;
    return handle;
  };
  window.uiLoadingHide = () => { cur = null; emit(); };
  // run an async (or timed) task behind the loader
  window.uiLoadingRun = async (opts, fn) => {
    const h = window.uiLoading(opts);
    try { return await (typeof fn === "function" ? fn(h) : fn); }
    finally { h.close(); }
  };
})();

function UILoadingHost() {
  const [, force] = React.useReducer(x => x + 1, 0);
  useEffect(() => window.__subLoading(() => force()), []);
  const m = window.__getLoading();
  if (!m) return null;
  return (
    <div className="pk-overlay open" role="status" aria-live="polite">
      <div className="pk-modal load">
        <div className="load-title">{m.title}</div>
        <div className="load-frame"><div className="walker walking" /></div>
        <div className="load-track"><div className="load-indet" /></div>
        {m.message && <div className="load-meta"><span className="load-label">{m.message}</span></div>}
        {typeof m.onCancel === "function" && (
          <div className="pk-foot" style={{ justifyContent: "center", marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => m.onCancel()}>{m.cancelText || "ยกเลิก"}</button>
          </div>
        )}
      </div>
    </div>
  );
}
Object.assign(window, { UIModalHost, UILoadingHost });

export {
  UILoadingHost,
  UIModalHost
};
