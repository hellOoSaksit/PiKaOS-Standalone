/* PiKaOs-Compare — app primitives used by the Compare screen.
   Trimmed from the full PiKaOs kit to ONLY what Compare needs: Btn, Empty, PageHead
   (+ FeatureTag), Panel, StatTile, Divider. The full kit's Avatar/AgentCard/Chat/etc.
   are intentionally NOT here — they pull in the world/data layers this standalone drops. */
import React from 'react';

function Panel({ title, en, icon, right, children, className = "", ornate = false, bodyPad = true }) {
  return (
    <section className={`panel ${ornate ? "ornate" : ""} ${className}`}>
      {title && (
        <div className="panel-head">
          {icon && <span className="ph-icon">{icon}</span>}
          <h3>{title}</h3>
          {en && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{en}</span>}
          <span className="ph-spacer" />
          {right}
        </div>
      )}
      <div className={bodyPad ? "panel-body" : "panel-body no-pad"}>{children}</div>
    </section>
  );
}

function Btn({ kind = "gold", sm, icon, children, onClick, style, title }) {
  return (
    <button className={`btn btn-${kind} ${sm ? "btn-sm" : ""}`} onClick={onClick} style={style} title={title}>
      {icon && <span>{icon}</span>}{children}
    </button>
  );
}

// onClick/active make a tile a status filter toggle (used by the Redirect screen): a clickable
// tile gets a pointer cursor and, when active, a gold ring so it reads as the current filter.
function StatTile({ label, value, unit, delta, deltaTone, icon, onClick, active }) {
  const clickable = typeof onClick === "function";
  return (
    <div className={`stat-tile ${active ? "is-active" : ""}`} onClick={onClick}
      style={clickable ? { cursor: "pointer", borderColor: active ? "var(--gold)" : undefined, boxShadow: active ? "0 0 0 1px var(--gold)" : undefined } : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="st-label">{label}</div>
        {icon && <span style={{ fontSize: 16, opacity: .8 }}>{icon}</span>}
      </div>
      <div className="st-value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {delta && <div className={`st-delta ${deltaTone || ""}`}>{delta}</div>}
    </div>
  );
}

function Divider() { return <div className="divider"><span className="gem" /></div>; }

function Empty({ icon = "🗺️", title, sub }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <div className="thai-serif" style={{ fontSize: 16, color: "var(--ink-2)" }}>{title}</div>
      {sub && <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

/* Feature status tag — Compare passes tag="local" (saved-on-this-machine, no AI). */
const FEATURE_TAGS = {
  live:  { ic: "🟢", label: "ต่อ AI จริง · มีผล", cls: "ft-live", tip: "ส่วนนี้เชื่อมต่อกับ AI จริง" },
  local: { ic: "💾", label: "บันทึกจริง · มีผล", cls: "ft-local", tip: "ข้อมูลถูกบันทึกจริงในเครื่องของคุณ มีผลต่อระบบจริง ( ยังไม่ได้ต่อ AI )" },
  demo:  { ic: "◌", label: "ตัวอย่างสาธิต · ยังไม่มีผล", cls: "ft-demo", tip: "ส่วนนี้เป็นตัวอย่างเพื่อแสดงหน้าตา" },
};
function FeatureTag({ kind = "demo" }) {
  const t = FEATURE_TAGS[kind] || FEATURE_TAGS.demo;
  return <span className={`feature-tag ${t.cls}`} title={t.tip}><span className="ft-ic">{t.ic}</span>{t.label}</span>;
}

function PageHead({ kicker, title, desc, actions, tag }) {
  return (
    <div className="page-head">
      <div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {kicker && <div className="kicker">{kicker}</div>}
          {tag && <FeatureTag kind={tag} />}
        </div>
        <h2 className="page-title">{title}</h2>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {actions && <div className="row" style={{ gap: 10 }}>{actions}</div>}
    </div>
  );
}

export { Btn, Divider, Empty, FEATURE_TAGS, FeatureTag, PageHead, Panel, StatTile };
