/* For human — the "Pull + compare URLs" panel: Symbol + the one new base + a list of old sites/URLs
   (all map to that new site), an optional sitemap override, the embedded Basic-Auth block, and the
   run/cancel button. Pure UI bound to the screen's `disc` form state + handlers; the screen owns the
   actual discover+verify run. */
import React from 'react';
import { Panel, Btn } from '../../components/components.jsx';
import { cellInput, cellInputErr, fieldL, fieldT, reqStar } from './cells.jsx';
import { AuthPanel } from './AuthPanel.jsx';

export function DiscoverPanel({
  L, disc, setDiscField, setOldUrl, addOld, delOld, oldList, discErr,
  busy, discBusy, onRun, onCancel, auth,
}) {
  const dInput = (k) => (discErr[k] ? cellInputErr : cellInput);   // red border while a required field is flagged empty
  return (
    <Panel title={L.discTitle} icon="🧭">
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10 }}>
        <label style={fieldL}><span style={fieldT}>{L.discSym} <span style={reqStar} title={L.reqStar}>*</span></span>
          <input value={disc.symbol} placeholder={L.discSymPh} onChange={(e) => setDiscField("symbol", e.target.value)} style={dInput("symbol")} /></label>
        <label style={fieldL}><span style={fieldT}>{L.discNew} <span style={reqStar} title={L.reqStar}>*</span></span>
          <input value={disc.newBase} placeholder={L.discNewPh} onChange={(e) => setDiscField("newBase", e.target.value)} style={dInput("newBase")} /></label>
      </div>

      {/* old side = a list (several old sites or URLs), all mapping to the one new site above */}
      <div style={{ ...fieldL, marginTop: 12 }}>
        <span style={fieldT}>{L.discOldList} <span style={reqStar} title={L.reqStar}>*</span></span>
        {disc.olds.map((u, i) => (
          <div key={i} className="row" style={{ gap: 6, alignItems: "center" }}>
            <input value={u} placeholder={L.phOld} onChange={(e) => setOldUrl(i, e.target.value)}
              style={{ ...(discErr.olds && i === 0 ? cellInputErr : cellInput), flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            {disc.olds.length > 1 && (
              <button type="button" onClick={() => delOld(i)} title={L.mRemove}
                style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
            )}
          </div>
        ))}
        <button type="button" onClick={addOld}
          style={{ alignSelf: "flex-start", border: "1px dashed var(--line)", background: "transparent", color: "var(--ink-3)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
          {L.discAddOld}
        </button>
      </div>

      {oldList().length <= 1 && (
        <label style={{ ...fieldL, marginTop: 10, maxWidth: 520 }}><span style={fieldT}>{L.discSitemap}</span>
          <input value={disc.sitemapUrl} placeholder={L.discSitemapPh} onChange={(e) => setDiscField("sitemapUrl", e.target.value)} style={cellInput} /></label>
      )}

      {/* optional: sites behind HTTP Basic Auth (often UAT). Matched to a probed URL by host. */}
      <AuthPanel L={L} {...auth} />

      <div className="row" style={{ gap: 10, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
        {(busy || discBusy)
          ? <Btn kind="ghost" onClick={onCancel}>{(busy ? L.verifying : L.discBusy)} · {L.cancel}</Btn>
          : <Btn kind="gold" icon="🚀" onClick={onRun}>{L.discRun}</Btn>}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>{L.discHint}</div>
    </Panel>
  );
}
